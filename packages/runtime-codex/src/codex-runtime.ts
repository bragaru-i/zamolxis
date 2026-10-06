import { isAbsolute, relative, resolve } from "node:path";
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
  classifyCommandRisk,
  insideWorkspace,
  maxRisk,
  type ResumeRunInput,
  type RuntimeSessionSnapshot,
  redactSecrets,
  type StartRunInput,
} from "@zamolxis/runtime-core";
import { describeItem, fitPayload, redactedText } from "./activity";
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
  readonly connect?: (cwd: string) => CodexConnection;
  readonly now?: () => number;
}
interface Session {
  input: StartRunInput;
  client: CodexConnection;
  id: string;
  turnId: string;
  state: RuntimeSessionSnapshot["state"];
  events: NormalizedRunEventDto[];
  seen: Set<string>;
  uncertain: boolean;
  waiters: Set<() => void>;
  // Text of the last completed agent message: the agent's final reply for this turn.
  reply?: string;
  approvals: Map<string, PendingApproval>;
  // Paths proposed by in-progress file change items, for approval summaries.
  fileItems: Map<string, { path: string; kind: string }[]>;
}
interface PendingApproval {
  requestId: AppServerRequestId;
  timer: ReturnType<typeof setTimeout>;
  answer: (decision: ApprovalDecision) => Record<string, unknown>;
}
const REPLY_LIMIT = 8000;
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
  constructor(private readonly options: CodexRuntimeOptions = {}) {}
  capabilities(): RuntimeCapabilitiesDto {
    return {
      runtime: this.id,
      canStart: true,
      canResume: false,
      canMessage: true,
      canStop: true,
      canDiscoverSessions: false,
      supportsSubagents: false,
      canApprove: true,
    };
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
  async #start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    const client =
      this.options.connect?.(input.workspace.cwd) ??
      new AppServerClient({
        cwd: input.workspace.cwd,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
      });
    const session: Session = {
      input,
      client,
      id: "",
      turnId: "",
      state: "running",
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
      const result = record(
        await client.request("turn/start", {
          threadId: session.id,
          ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          cwd: input.workspace.cwd,
          input: [{ type: "text", text: input.instruction }],
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: readOnly(input) ? "readOnly" : "workspaceWrite",
            ...(readOnly(input) ? {} : { writableRoots: [input.workspace.cwd] }),
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
      return this.#snapshot(session);
    } catch (error) {
      if (session.id && !terminal(session)) this.#abort(session);
      client.close();
      if (terminal(session)) return this.#snapshot(session);
      throw error;
    }
  }
  async resume(_input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    throw new Error("CODEX_RESUME_REQUIRES_DURABLE_BINDING");
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
    if (terminal(session) || !session.approvals.has(input.approvalId))
      throw new Error("APPROVAL_NOT_PENDING");
    this.#settleApproval(
      session,
      input.approvalId,
      input.decision === "approve" ? "approved" : "rejected",
      "user",
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
        for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"]) {
          const value = usage[field];
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
          payload[field] = value;
        }
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
        if (typeof item.text === "string" && item.text.trim())
          session.reply = redactedText(item.text, REPLY_LIMIT);
      }
      const activity = describeItem(item, done);
      if (activity?.kind === "activity")
        this.#emit(session, "run.activity", { label: activity.label });
      else if (activity?.kind === "tool")
        this.#emit(
          session,
          done ? "tool.completed" : "tool.started",
          done
            ? { tool: activity.tool, summary: activity.summary, success: activity.success === true }
            : { tool: activity.tool, summary: activity.summary },
        );
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
  #finish(session: Session, state: "completed" | "failed" | "stopped", message: string): void {
    if (terminal(session)) return;
    // Pending approvals settle (rejected) before the terminal event.
    this.#rejectPending(session, "stopped");
    session.state = state;
    if (state === "completed") this.#emit(session, "run.completed", { summary: message });
    else if (state === "stopped") this.#emit(session, "run.stopped", { reason: message });
    else this.#emit(session, "run.failed", { message });
    session.client.close();
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
    const sequence = session.events.length + 1;
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
    const approvalId = approvalIdFor(session.input.runId, request.id);
    if (session.approvals.has(approvalId)) return false;
    session.approvals.set(approvalId, {
      requestId: request.id,
      answer: held.answer,
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
        answer: PendingApproval["answer"];
      }
    | undefined {
    const params = request.params;
    const workspace = session.input.workspace.cwd;
    const reason = optionalText(params.reason, 500);
    const accept = (decision: ApprovalDecision) => ({
      decision: decision === "approve" ? "accept" : "decline",
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
        risk: command
          ? classifyCommandRisk({
              command,
              workspace,
              ...(cwd ? { cwd } : {}),
              network: !!network || amendments,
            })
          : "high",
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
          pending.answer(decision === "approved" ? "approve" : "reject"),
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
      lastSequence: session.events.length,
    };
  }
}
