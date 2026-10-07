import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalResolutionReason,
  ApprovalRisk,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
} from "@zamolxis/contracts";
import {
  type AgentRuntime,
  approvalIdFor,
  approvalSummary,
  boundRuntimeModels,
  boundText,
  classifyCommandRisk,
  insideWorkspace,
  maxRisk,
  REQUIRED_USAGE_COUNTERS,
  RESTART_CONTINUATION,
  RESTART_INTERRUPTED_CODE,
  type ResumeRunInput,
  RUNTIME_MODEL_LIMITS,
  type RuntimeModelDto,
  type RuntimeSessionSnapshot,
  redactSecrets,
  type StartRunInput,
  type UsageCounter,
} from "@zamolxis/runtime-core";
import { knownCommit } from "@zamolxis/runtime-core/known-commits";
import { agentNote, describeItem, fitPayload, readPaths, redactedText } from "./activity";
import {
  AppServerClient,
  type AppServerNotification,
  type AppServerRequest,
  type AppServerRequestHandler,
  type AppServerRequestId,
} from "./app-server-client";

export interface CodexConnection {
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (event: AppServerNotification) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
  // Approval bridge. Without it every server request is refused by the transport.
  onServerRequest?(handler: AppServerRequestHandler): () => void;
  respond?(id: AppServerRequestId, result: Record<string, unknown>): void;
}
export interface CodexRuntimeOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly stopTimeoutMs?: number;
  // Pending approvals are rejected after this long (default 30 minutes).
  readonly approvalTimeoutMs?: number;
  readonly connect?: (cwd: string, env?: NodeJS.ProcessEnv) => CodexConnection;
  readonly now?: () => number;
}
interface Session {
  input: StartRunInput;
  client: CodexConnection;
  // The run's private TMPDIR (writing roles only), writable in the sandbox and removed
  // with the connection: tools that need temporary files then work without asking.
  tmp?: string;
  id: string;
  turnId: string;
  state: RuntimeSessionSnapshot["state"];
  // Sequence of the last event a previous process reported (0 for a new session).
  base: number;
  // Scopes approval ids of a resumed session: a new app-server reuses request ids.
  approvalScope: string;
  // Usage already reported for the run; resumed totals never go below it.
  usageFloor: Partial<Record<UsageCounter, number>>;
  // Model responses seen by this process: usage reports whose total grew.
  calls: number;
  lastTotal: number;
  events: NormalizedRunEventDto[];
  seen: Set<string>;
  uncertain: boolean;
  waiters: Set<() => void>;
  // Text of the last completed agent message: the agent's final reply for this turn.
  reply?: string;
  // A completed agent message without a phase: the final reply unless anything follows
  // it, in which case it was a progress note and is reported as `run.message`.
  held?: { itemId: string; text: string } | undefined;
  approvals: Map<string, PendingApproval>;
  // Paths proposed by in-progress file change items, for approval summaries.
  fileItems: Map<string, { path: string; kind: string }[]>;
  // Commit SHAs of the run's repository stay readable in its replies (see knownCommit).
  readonly commits: (run: string) => boolean;
}
interface PendingApproval {
  requestId: AppServerRequestId;
  timer: ReturnType<typeof setTimeout>;
  allowForSession: boolean;
  answer: (decision: ApprovalDecision) => Record<string, unknown>;
}
const REPLY_LIMIT = 8000;
// `model/list` pages read before the catalog is considered complete.
const MODEL_PAGES = 5;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const ELICITATION = "mcpServer/elicitation/request";
function optionalText(value: unknown, limit = 4096): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}
// Approval text is redacted too; the risk is classified from the original command.
function redactedSummary(parts: readonly (string | undefined)[]): string {
  return approvalSummary(parts.map((part) => (part ? redactSecrets(part) : part)));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CODEX_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error("CODEX_INVALID_RESPONSE");
  return value;
}
// Verifier and Supervisor inspect the repository; they never edit it.
function readOnly(input: StartRunInput): boolean {
  return input.role === "verifier" || input.role === "supervisor";
}
function sameAssignment(a: StartRunInput, b: StartRunInput): boolean {
  return (
    a.runId === b.runId &&
    a.workstationId === b.workstationId &&
    a.workspace.workspaceId === b.workspace.workspaceId &&
    a.workspace.cwd === b.workspace.cwd &&
    a.workspace.branch === b.workspace.branch
  );
}
// The text of the last agent message among a turn's items: the agent's final reply.
function finalReply(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item: unknown = items[index];
    if (!item || typeof item !== "object") continue;
    const { type, text: value } = item as Record<string, unknown>;
    if (type === "agentMessage" && typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
function terminal(session: Session): boolean {
  return ["completed", "failed", "stopped"].includes(session.state);
}

export class CodexRuntime implements AgentRuntime {
  readonly id = "codex";
  readonly #sessions = new Map<string, Session>();
  readonly #starts = new Map<
    string,
    { input: StartRunInput; result: Promise<RuntimeSessionSnapshot> }
  >();
  // In-flight reattachments by native session, so a retried resume shares one.
  readonly #resumes = new Map<
    string,
    { input: ResumeRunInput; result: Promise<RuntimeSessionSnapshot> }
  >();
  constructor(private readonly options: CodexRuntimeOptions = {}) {}
  capabilities(): RuntimeCapabilitiesDto {
    return {
      runtime: this.id,
      canStart: true,
      canResume: true,
      canMessage: true,
      canStop: true,
      canDiscoverSessions: false,
      supportsSubagents: false,
      canApprove: true,
    };
  }
  /**
   * The models app-server lists (`model/list`), hidden ones excluded. The connection runs
   * in a private scratch directory, never a workspace, and is closed afterwards.
   */
  async listModels(): Promise<RuntimeModelDto[]> {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-models-")));
    let client: CodexConnection | undefined;
    try {
      client =
        this.options.connect?.(scratch) ??
        new AppServerClient({
          cwd: scratch,
          ...(this.options.executable ? { executable: this.options.executable } : {}),
        });
      await client.initialize();
      const models: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MODEL_PAGES; page++) {
        const result = record(await client.request("model/list", cursor ? { cursor } : {}));
        if (!Array.isArray(result.data)) throw new Error("CODEX_INVALID_RESPONSE");
        for (const entry of result.data) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const model = entry as Record<string, unknown>;
          if (model.hidden === true) continue;
          models.push({
            id: typeof model.model === "string" && model.model ? model.model : model.id,
            displayName: model.displayName,
            description: model.description,
            isDefault: model.isDefault,
            efforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((effort: unknown) =>
                  effort && typeof effort === "object"
                    ? (effort as Record<string, unknown>).reasoningEffort
                    : effort,
                )
              : undefined,
            defaultEffort: model.defaultReasoningEffort,
          });
        }
        cursor =
          typeof result.nextCursor === "string" && result.nextCursor
            ? result.nextCursor
            : undefined;
        if (!cursor || models.length >= RUNTIME_MODEL_LIMITS.models) break;
      }
      return boundRuntimeModels(models);
    } finally {
      client?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    if (!isAbsolute(input.workspace.cwd) || !input.workspace.branch || !input.workspace.headSha)
      return Promise.reject(new Error("WORKSPACE_ASSIGNMENT_REQUIRED"));
    const existing = this.#starts.get(input.runId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        return Promise.reject(new Error("RUNTIME_REQUEST_CONFLICT"));
      return existing.result.then((snapshot) => this.inspect(snapshot.nativeSessionId));
    }
    const copied = structuredClone(input);
    // Reserve before any asynchronous launch; failed/ambiguous starts are never replayed.
    const result = Promise.resolve().then(() => this.#start(copied));
    this.#starts.set(input.runId, { input: copied, result });
    return result;
  }
  // A native connection and an empty session bound to it.
  #open(input: StartRunInput, resumed?: ResumeRunInput): Session {
    const tmp = readOnly(input)
      ? undefined
      : realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-run-")));
    const tools = input.workspace.toolPaths ?? [];
    const env =
      tmp || tools.length
        ? {
            ...(tmp ? { TMPDIR: `${tmp}/` } : {}),
            ...(tools.length ? { PATH: [...tools, process.env.PATH ?? ""].join(delimiter) } : {}),
          }
        : undefined;
    const client =
      this.options.connect?.(input.workspace.cwd, env) ??
      new AppServerClient({
        cwd: input.workspace.cwd,
        ...(env ? { env } : {}),
        ...(this.options.executable ? { executable: this.options.executable } : {}),
      });
    if (tmp) client.onClose(() => rmSync(tmp, { recursive: true, force: true }));
    const base = resumed?.afterSequence ?? 0;
    const session: Session = {
      input,
      client,
      ...(tmp ? { tmp } : {}),
      commits: knownCommit(input.workspace.cwd),
      id: "",
      turnId: "",
      state: "running",
      base,
      approvalScope: resumed ? `r${base}.` : "",
      usageFloor: { ...(resumed?.usage ?? {}) },
      calls: 0,
      lastTotal: -1,
      events: [],
      seen: new Set(),
      uncertain: false,
      waiters: new Set(),
      approvals: new Map(),
      fileItems: new Map(),
    };
    client.onNotification((event) => this.#notification(session, event));
    client.onServerRequest?.((request) => this.#serverRequest(session, request));
    client.onClose(() => {
      if (session.id && !terminal(session)) this.#abort(session);
    });
    return session;
  }
  // Every turn of a run uses the assigned cwd and the role's sandbox.
  async #startTurn(session: Session, instruction: string): Promise<void> {
    const input = session.input;
    const result = record(
      await session.client.request("turn/start", {
        threadId: session.id,
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
        cwd: input.workspace.cwd,
        input: [{ type: "text", text: instruction }],
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: readOnly(input) ? "readOnly" : "workspaceWrite",
          ...(session.tmp ? { writableRoots: [input.workspace.cwd, session.tmp] } : {}),
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }),
    );
    const turn = record(result.turn);
    const id = text(turn.id);
    if (session.turnId && session.turnId !== id) throw new Error("CODEX_TURN_MISMATCH");
    session.turnId = id;
    if (!terminal(session) && turn.status !== "inProgress")
      this.#turnFinished(session, turn.status);
  }
  async #start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    const session = this.#open(input);
    const client = session.client;
    try {
      await client.initialize();
      const response = record(
        await client.request("thread/start", {
          cwd: input.workspace.cwd,
          sandbox: readOnly(input) ? "read-only" : "workspace-write",
          approvalPolicy: "on-request",
          ...((input.model ?? this.options.model)
            ? { model: input.model ?? this.options.model }
            : {}),
        }),
      );
      const thread = record(response.thread);
      session.id = text(thread.id);
      if (thread.cwd !== input.workspace.cwd || this.#sessions.has(session.id))
        throw new Error("RUNTIME_WORKSPACE_MISMATCH");
      this.#sessions.set(session.id, session);
      this.#emit(session, "run.started", { nativeSessionId: session.id });
      if (typeof response.model === "string")
        this.#emit(session, "run.usage", { modelActual: response.model });
      await this.#startTurn(session, input.instruction);
      return this.#snapshot(session);
    } catch (error) {
      if (session.id && !terminal(session)) this.#abort(session);
      client.close();
      if (terminal(session)) return this.#snapshot(session);
      throw error;
    }
  }
  /**
   * Reattaches a run to its persisted Codex thread in a new app-server process
   * (`thread/resume`, then the last turn from `thread/turns/list`). The app-server exits
   * with the Node, so a turn in flight at the restart is reported `interrupted`: it is
   * continued with a new turn on the same thread, failed or stopped according to
   * `interrupted`. A completed or failed last turn reports its outcome (with the final
   * reply). A thread that is still active or a turn still in progress is uncertain and
   * requires reconciliation; nothing is ever started from scratch.
   */
  resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    if (!isAbsolute(input.workspace.cwd) || !input.workspace.branch || !input.workspace.headSha)
      return Promise.reject(new Error("WORKSPACE_ASSIGNMENT_REQUIRED"));
    const after = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      return Promise.reject(new Error("INVALID_EVENT_CURSOR"));
    const live = this.#sessions.get(input.nativeSessionId);
    // Attached in this process: nothing to do. An uncertain session's connection is
    // closed (nothing runs on it), so it may be replaced by a fresh reattachment.
    if (live && !live.uncertain) {
      if (!sameAssignment(live.input, input))
        return Promise.reject(new Error("RUNTIME_WORKSPACE_MISMATCH"));
      return this.inspect(input.nativeSessionId);
    }
    const existing = this.#resumes.get(input.nativeSessionId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        return Promise.reject(new Error("RUNTIME_REQUEST_CONFLICT"));
      return existing.result.then((snapshot) => this.inspect(snapshot.nativeSessionId));
    }
    const copied = structuredClone(input);
    const result = Promise.resolve().then(() => this.#resume(copied));
    const entry = { input: copied, result };
    this.#resumes.set(input.nativeSessionId, entry);
    // Settled either way: a later resume (for example after another restart) starts over.
    const forget = () => {
      if (this.#resumes.get(input.nativeSessionId) === entry)
        this.#resumes.delete(input.nativeSessionId);
    };
    result.then(forget, forget);
    return result;
  }
  async #resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    const session = this.#open(
      {
        runId: input.runId,
        workstationId: input.workstationId,
        workspace: input.workspace,
        instruction: input.instruction,
        ...(input.role ? { role: input.role } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      },
      input,
    );
    const client = session.client;
    try {
      await client.initialize();
      const response = record(
        await client.request("thread/resume", {
          threadId: input.nativeSessionId,
          cwd: input.workspace.cwd,
          approvalPolicy: "on-request",
          sandbox: readOnly(input) ? "read-only" : "workspace-write",
          ...((input.model ?? this.options.model)
            ? { model: input.model ?? this.options.model }
            : {}),
          // Turns are paged below: a long run's full history could exceed a frame.
          excludeTurns: true,
        }),
      );
      const thread = record(response.thread);
      if (text(thread.id) !== input.nativeSessionId || thread.cwd !== input.workspace.cwd)
        throw new Error("RUNTIME_WORKSPACE_MISMATCH");
      // A fresh app-server reports an active thread only if something else still runs it.
      const status =
        thread.status && typeof thread.status === "object" ? record(thread.status).type : undefined;
      if (status === "active" || status === "systemError")
        throw new Error("RECONCILIATION_REQUIRED");
      const page = record(
        await client.request("thread/turns/list", {
          threadId: input.nativeSessionId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "summary",
        }),
      );
      const last: unknown = Array.isArray(page.data) ? page.data[0] : undefined;
      if (!last) throw new Error("CODEX_RESUME_NO_TURN");
      const turn = record(last);
      const turnId = text(turn.id);
      if (turn.status === "inProgress") throw new Error("RECONCILIATION_REQUIRED");
      if (!["completed", "failed", "interrupted"].includes(String(turn.status)))
        throw new Error("CODEX_INVALID_TURN_STATUS");
      const previous = this.#sessions.get(input.nativeSessionId);
      if (previous && !previous.uncertain) throw new Error("RUNTIME_REQUEST_CONFLICT");
      session.id = input.nativeSessionId;
      this.#sessions.set(session.id, session);
      if (input.announce) this.#emit(session, "run.started", { nativeSessionId: session.id });
      // Their native requests died with the old app-server: nothing was approved.
      for (const approvalId of input.pendingApprovalIds ?? [])
        this.#emit(session, "approval.resolved", {
          approvalId,
          decision: "rejected",
          reason: "withdrawn",
        });
      if (input.announce && typeof response.model === "string")
        this.#emit(session, "run.usage", { modelActual: response.model });
      if (turn.status === "interrupted") {
        const policy = input.interrupted ?? "fail";
        if (policy === "continue") {
          this.#emit(session, "run.activity", { label: "Continuing after a restart" });
          await this.#startTurn(session, RESTART_CONTINUATION);
        } else if (policy === "stop")
          this.#finish(session, "stopped", "Stopped: the Node restarted before the turn ended");
        else
          this.#finish(
            session,
            "failed",
            "Interrupted by a Node restart",
            RESTART_INTERRUPTED_CODE,
          );
      } else {
        session.turnId = turnId;
        const reply = finalReply(turn.items);
        if (reply)
          session.reply =
            session.input.role === "supervisor"
              ? boundText(reply, REPLY_LIMIT)
              : redactedText(reply, REPLY_LIMIT, { keep: session.commits });
        this.#turnFinished(session, turn.status);
      }
      return this.#snapshot(session);
    } catch (error) {
      if (session.id && !terminal(session)) this.#abort(session);
      client.close();
      if (session.id && terminal(session)) return this.#snapshot(session);
      throw error;
    }
  }
  async inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot> {
    return this.#snapshot(this.#get(nativeSessionId));
  }
  async send(input: { nativeSessionId: string; message: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) throw new Error("RUNTIME_TERMINAL");
    if (!session.turnId) throw new Error("RECONCILIATION_REQUIRED");
    const response = record(
      await session.client.request("turn/steer", {
        threadId: session.id,
        expectedTurnId: session.turnId,
        input: [{ type: "text", text: input.message }],
      }),
    );
    if (response.turnId !== session.turnId) throw new Error("CODEX_TURN_MISMATCH");
  }
  async resolveApproval(input: {
    nativeSessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    const pending = session.approvals.get(input.approvalId);
    if (terminal(session) || !pending) throw new Error("APPROVAL_NOT_PENDING");
    if (input.decision === "approve_session" && !pending.allowForSession)
      throw new Error("APPROVAL_SCOPE_UNAVAILABLE");
    this.#settleApproval(
      session,
      input.approvalId,
      input.decision === "reject" ? "rejected" : "approved",
      "user",
      true,
      input.decision,
    );
  }
  async stop(input: { nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) return;
    if (!session.turnId) throw new Error("RECONCILIATION_REQUIRED");
    // Nothing held for approval may run after a stop request.
    this.#rejectPending(session, "stopped");
    try {
      await session.client.request("turn/interrupt", {
        threadId: session.id,
        turnId: session.turnId,
      });
    } catch (error) {
      if (terminal(session)) return;
      throw error;
    }
    if (terminal(session)) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        if (!terminal(session)) return;
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        session.waiters.delete(wake);
        this.#abort(session);
        session.client.close();
        reject(new Error("CODEX_STOP_UNCONFIRMED"));
      }, this.options.stopTimeoutMs ?? 10_000);
      session.waiters.add(wake);
    });
  }
  async *subscribe(input: {
    nativeSessionId: string;
    afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto> {
    let cursor = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("INVALID_EVENT_CURSOR");
    const session = this.#get(input.nativeSessionId);
    while (true) {
      if (session.uncertain) throw new Error("RECONCILIATION_REQUIRED");
      for (const event of session.events) {
        if (event.sequence > cursor) {
          cursor = event.sequence;
          yield structuredClone(event);
        }
      }
      if (session.uncertain) throw new Error("RECONCILIATION_REQUIRED");
      if (terminal(session)) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          session.waiters.delete(wake);
          resolve();
        };
        session.waiters.add(wake);
      });
    }
  }
  #notification(session: Session, event: AppServerNotification): void {
    if (terminal(session) || !session.id || event.params.threadId !== session.id) return;
    try {
      const params = event.params;
      if (event.method === "turn/started") {
        const id = text(record(params.turn).id);
        if (session.turnId && session.turnId !== id) return;
        session.turnId = id;
        return;
      }
      if (event.method === "serverRequest/resolved") {
        // The runtime withdrew a request (for example its turn ended): forget it, unanswered.
        for (const [approvalId, pending] of session.approvals)
          if (pending.requestId === params.requestId)
            this.#settleApproval(session, approvalId, "rejected", "withdrawn", false);
        return;
      }
      const turnId =
        event.method === "turn/completed" ? text(record(params.turn).id) : params.turnId;
      if (!session.turnId || turnId !== session.turnId) return;
      if (event.method === "thread/tokenUsage/updated") {
        const usage = record(record(params.tokenUsage).total);
        const payload: Record<string, number> = {};
        for (const field of REQUIRED_USAGE_COUNTERS) {
          const value = usage[field];
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
          // A resumed thread's totals never go below what was already reported.
          payload[field] = Math.max(value, session.usageFloor[field] ?? 0);
        }
        for (const field of ["cacheWriteInputTokens", "reasoningOutputTokens"] as const) {
          const value = usage[field];
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
            payload[field] = Math.max(value, session.usageFloor[field] ?? 0);
        }
        // Codex reports usage once per model response; a repeated report (same thread
        // total) is not another call.
        const total = usage.totalTokens as number;
        if (total > session.lastTotal) {
          session.lastTotal = total;
          session.calls += 1;
        }
        payload.modelCalls = (session.usageFloor.modelCalls ?? 0) + session.calls;
        this.#emit(session, "run.usage", payload);
        return;
      }
      if (event.method === "turn/completed") {
        this.#turnFinished(session, record(params.turn).status);
        return;
      }
      if (event.method !== "item/started" && event.method !== "item/completed") return;
      const item = record(params.item);
      const key = `${event.method}:${text(item.id)}`;
      if (session.seen.has(key)) return;
      if (session.seen.size >= 10_000) throw new Error("CODEX_EVENT_LIMIT");
      session.seen.add(key);
      const done = event.method === "item/completed";
      // Anything after a message whose phase is unknown shows it was not the final reply.
      if (session.held && session.held.itemId !== item.id) this.#releaseHeld(session);
      if (item.type === "fileChange" && !done && Array.isArray(item.changes)) {
        if (session.fileItems.size >= 1000) session.fileItems.clear();
        session.fileItems.set(
          text(item.id),
          item.changes.slice(0, 100).map((value) => {
            const change = record(value);
            return {
              path: text(change.path),
              kind: typeof change.kind === "object" ? String(record(change.kind).type) : "update",
            };
          }),
        );
      }
      if (item.type === "fileChange" && done && item.status === "completed") {
        if (!Array.isArray(item.changes)) throw new Error("CODEX_INVALID_RESPONSE");
        const paths = item.changes.slice(0, 100).map((value) => {
          const path = text(record(value).path);
          const local = relative(
            session.input.workspace.cwd,
            resolve(session.input.workspace.cwd, path),
          );
          if (local === ".." || local.startsWith("../") || isAbsolute(local))
            throw new Error("CODEX_PATH_OUTSIDE_WORKSPACE");
          return local;
        });
        this.#emit(session, "files.changed", { paths });
      } else if (item.type === "agentMessage" && done) {
        if (typeof item.text === "string" && item.text.trim()) {
          // The Supervisor's reply is structured JSON that the Node parses and redacts
          // field by field; redacting it here would corrupt values such as task keys.
          session.reply =
            session.input.role === "supervisor"
              ? boundText(item.text, REPLY_LIMIT)
              : redactedText(item.text, REPLY_LIMIT, { keep: session.commits });
          // Interim commentary is a progress note now; a final answer is only the reply;
          // without a phase the message is held until something follows it.
          if (item.phase === "commentary")
            this.#emit(session, "run.message", { text: agentNote(item.text) });
          else if (item.phase !== "final_answer")
            session.held = { itemId: text(item.id), text: item.text };
        }
      }
      const activity = describeItem(item, done);
      if (activity?.kind === "activity")
        this.#emit(session, "run.activity", { label: activity.label });
      else if (activity?.kind === "tool") {
        const reads = done ? undefined : readPaths(item, session.input.workspace.cwd);
        this.#emit(
          session,
          done ? "tool.completed" : "tool.started",
          done
            ? { tool: activity.tool, summary: activity.summary, success: activity.success === true }
            : { tool: activity.tool, summary: activity.summary, ...(reads ? { reads } : {}) },
        );
      }
    } catch {
      this.#abort(session);
      session.client.close();
    }
  }
  #turnFinished(session: Session, status: unknown): void {
    if (status === "completed")
      this.#finish(session, "completed", session.reply ?? "Codex turn completed");
    else if (status === "interrupted") this.#finish(session, "stopped", "Codex turn interrupted");
    else if (status === "failed") this.#finish(session, "failed", "Codex turn failed");
    else throw new Error("CODEX_INVALID_TURN_STATUS");
  }
  #finish(
    session: Session,
    state: "completed" | "failed" | "stopped",
    message: string,
    code?: string,
  ): void {
    if (terminal(session)) return;
    // A completed turn's last message is its reply; otherwise it was only a progress note.
    if (state === "completed") session.held = undefined;
    else this.#releaseHeld(session);
    // Pending approvals settle (rejected) before the terminal event.
    this.#rejectPending(session, "stopped");
    session.state = state;
    if (state === "completed") this.#emit(session, "run.completed", { summary: message });
    else if (state === "stopped") this.#emit(session, "run.stopped", { reason: message });
    else this.#emit(session, "run.failed", { ...(code ? { code } : {}), message });
    session.client.close();
  }
  // Reports a held agent message as a progress note (redacted and bounded).
  #releaseHeld(session: Session): void {
    const held = session.held;
    session.held = undefined;
    if (held) this.#emit(session, "run.message", { text: agentNote(held.text) });
  }
  #emit(
    session: Session,
    type: NormalizedRunEventDto["type"],
    payload: Record<string, unknown>,
  ): void {
    if (session.events.length >= 10_000) {
      this.#abort(session);
      session.client.close();
      return;
    }
    const sequence = session.base + session.events.length + 1;
    session.events.push({
      type,
      // Every payload stays under the backend event limit.
      payload: fitPayload(payload),
      eventId: `${session.id}:${sequence}`,
      sequence,
      runId: session.input.runId,
      workspaceId: session.input.workspace.workspaceId,
      workstationId: session.input.workstationId,
      occurredAt: this.options.now?.() ?? Date.now(),
    } as NormalizedRunEventDto);
    for (const wake of session.waiters) wake();
  }
  // Holds a supported approval request; anything else is refused by the transport.
  #serverRequest(session: Session, request: AppServerRequest): boolean {
    const params = request.params;
    if (
      !session.id ||
      terminal(session) ||
      session.uncertain ||
      params.threadId !== session.id ||
      // Verifier and Supervisor stay read-only: they never escalate through approvals.
      readOnly(session.input) ||
      session.approvals.size >= 16
    )
      return false;
    const held = this.#describe(session, request);
    if (!held) return false;
    const approvalId = approvalIdFor(session.input.runId, `${session.approvalScope}${request.id}`);
    if (session.approvals.has(approvalId)) return false;
    session.approvals.set(approvalId, {
      requestId: request.id,
      answer: held.answer,
      allowForSession: held.allowForSession === true,
      timer: setTimeout(() => {
        try {
          this.#settleApproval(session, approvalId, "rejected", "timeout");
        } catch {
          this.#abort(session);
          session.client.close();
        }
      }, this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS),
    });
    this.#emit(session, "approval.requested", {
      approvalId,
      kind: held.kind,
      summary: held.summary,
      risk: held.risk,
      ...(held.allowForSession ? { allowForSession: true } : {}),
    });
    return true;
  }
  #describe(
    session: Session,
    request: AppServerRequest,
  ):
    | {
        kind: ApprovalKind;
        summary: string;
        risk: ApprovalRisk;
        allowForSession?: boolean;
        answer: PendingApproval["answer"];
      }
    | undefined {
    const params = request.params;
    const workspace = session.input.workspace.cwd;
    const reason = optionalText(params.reason, 500);
    const accept = (decision: ApprovalDecision) => ({
      decision:
        decision === "approve_session"
          ? "acceptForSession"
          : decision === "approve"
            ? "accept"
            : "decline",
    });
    if (request.method === COMMAND_APPROVAL) {
      if (session.turnId && params.turnId !== session.turnId) return undefined;
      const command = optionalText(params.command, 1800);
      const cwd = optionalText(params.cwd);
      const network =
        params.networkApprovalContext && typeof params.networkApprovalContext === "object"
          ? record(params.networkApprovalContext)
          : undefined;
      const host = network ? optionalText(network.host, 200) : undefined;
      const amendments =
        Array.isArray(params.proposedNetworkPolicyAmendments) &&
        params.proposedNetworkPolicyAmendments.length > 0;
      const risk = command
        ? classifyCommandRisk({
            command,
            workspace,
            ...(cwd ? { cwd } : {}),
            network: !!network || amendments,
          })
        : "high";
      const allowForSession =
        params.kind !== "writeStdin" &&
        (risk === "low" || risk === "medium") &&
        Array.isArray(params.availableDecisions) &&
        params.availableDecisions.includes("acceptForSession");
      return {
        kind: "command",
        summary: redactedSummary([
          params.kind === "writeStdin"
            ? `Send input to a running command: ${command ?? "(not shown)"}`
            : `Run: ${command ?? "(command not shown)"}`,
          cwd && cwd !== workspace ? `In: ${cwd}` : undefined,
          host ? `Network access to ${host}` : undefined,
          reason ? `Reason: ${reason}` : undefined,
        ]),
        risk,
        ...(allowForSession ? { allowForSession: true } : {}),
        answer: accept,
      };
    }
    if (request.method === FILE_APPROVAL) {
      if (session.turnId && params.turnId !== session.turnId) return undefined;
      const grantRoot = optionalText(params.grantRoot);
      const changes = (session.fileItems.get(String(params.itemId)) ?? []).map((change) => ({
        ...change,
        absolute: resolve(workspace, change.path),
      }));
      const listed = changes
        .map(
          (change) =>
            `${relative(workspace, change.absolute) || "."}${change.kind === "delete" ? " (delete)" : ""}`,
        )
        .join(", ");
      return {
        kind: "fileChange",
        summary: redactedSummary([
          listed ? `Change files: ${listed}` : "Change files in the workspace",
          grantRoot ? `Write access outside the workspace: ${grantRoot}` : undefined,
          reason ? `Reason: ${reason}` : undefined,
        ]),
        risk: maxRisk(
          "medium",
          changes.some((change) => change.kind === "delete") ? "high" : "low",
          grantRoot || changes.some((change) => !insideWorkspace(change.absolute, workspace))
            ? "critical"
            : "low",
        ),
        answer: accept,
      };
    }
    if (request.method === ELICITATION) {
      // Only a plain confirmation (a form without fields) can be answered yes or no.
      const schema =
        params.mode === "form" &&
        params.requestedSchema &&
        typeof params.requestedSchema === "object"
          ? record(params.requestedSchema)
          : undefined;
      const properties =
        schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
      if (!schema || Object.keys(properties).length) return undefined;
      return {
        kind: "tool",
        summary: redactedSummary([
          `Tool ${optionalText(params.serverName, 200) ?? "(unknown)"}: ${optionalText(params.message, 1500) ?? "requests confirmation"}`,
        ]),
        risk: "high",
        answer: (decision) =>
          decision === "approve"
            ? { action: "accept", content: {}, _meta: null }
            : { action: "decline", content: null, _meta: null },
      };
    }
    return undefined;
  }
  // Answers the runtime (unless it withdrew the request) and records the outcome.
  #settleApproval(
    session: Session,
    approvalId: string,
    decision: "approved" | "rejected",
    reason: ApprovalResolutionReason,
    answer = true,
    runtimeDecision?: ApprovalDecision,
  ): void {
    const pending = session.approvals.get(approvalId);
    if (!pending) return;
    session.approvals.delete(approvalId);
    clearTimeout(pending.timer);
    let delivered = false;
    try {
      if (answer) {
        if (!session.client.respond) throw new Error("CODEX_APPROVAL_BRIDGE_UNAVAILABLE");
        session.client.respond(
          pending.requestId,
          pending.answer(runtimeDecision ?? (decision === "approved" ? "approve" : "reject")),
        );
        delivered = true;
      }
    } finally {
      // An undelivered answer dies with the transport; it is never reported as approved.
      this.#emit(session, "approval.resolved", {
        approvalId,
        decision: delivered ? decision : "rejected",
        reason,
      });
    }
  }
  #rejectPending(session: Session, reason: ApprovalResolutionReason): void {
    for (const approvalId of [...session.approvals.keys()]) {
      try {
        this.#settleApproval(session, approvalId, "rejected", reason);
      } catch {
        /* Transport closed: the event was recorded and the request dies with the process. */
      }
    }
  }
  #abort(session: Session): void {
    for (const pending of session.approvals.values()) clearTimeout(pending.timer);
    session.approvals.clear();
    session.uncertain = true;
    for (const wake of session.waiters) wake();
  }
  #get(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    if (session.uncertain) throw new Error("RECONCILIATION_REQUIRED");
    return session;
  }
  #snapshot(session: Session): RuntimeSessionSnapshot {
    if (session.uncertain) throw new Error("RECONCILIATION_REQUIRED");
    return {
      nativeSessionId: session.id,
      runId: session.input.runId,
      workspace: { ...session.input.workspace },
      state: session.state,
      lastSequence: session.base + session.events.length,
    };
  }
}
