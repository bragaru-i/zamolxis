// Compliance (Anthropic terms, code.claude.com/docs/en/legal-and-compliance). These rules
// override convenience; keep them when changing this package:
// - Only the unmodified, installed `claude` CLI runs, with the owner's own Claude Code
//   login and default config location (HOME / ~/.claude). Billing is the owner's own Claude
//   subscription. No Agent SDK (it requires API-key auth) and no other Anthropic package.
// - Credentials and session/OAuth tokens are never read, copied, parsed, stored, logged or
//   forwarded (no ~/.claude/.credentials*, Keychain, CLAUDE_CODE_OAUTH_TOKEN, setup-token);
//   tests never copy a login into a temporary config dir. Resume only checks that a
//   session's transcript file exists; it never reads transcript contents.
// - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN (and ANTHROPIC_BASE_URL) are removed from the
//   child environment (`claudeEnv` in cli-process.ts); no base URL or proxy is set; the CLI
//   never runs with --dangerously-skip-permissions, bypassPermissions or --bare.
// - User/project settings files and MCP servers are not loaded (--setting-sources "",
//   --strict-mcp-config): they are not execution grants. The login itself is unaffected.
// - Pro/Max plan limits assume ordinary individual use; heavy parallel or always-on use
//   can hit them.

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalResolutionReason,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
} from "@zamolxis/contracts";
import {
  type AgentRuntime,
  agentNote,
  approvalIdFor,
  boundText,
  fitPayload,
  RESTART_CONTINUATION,
  RESTART_INTERRUPTED_CODE,
  type ResumeRunInput,
  type RuntimeModelDto,
  type RuntimeSessionSnapshot,
  redactedText,
  type StartRunInput,
  safeSummary,
  type UsageCounter,
} from "@zamolxis/runtime-core";
import { knownCommit } from "@zamolxis/runtime-core/known-commits";
import { changedPath, completedSummary, describePermission, describeTool } from "./activity";
import { ClaudeCliProcess, type ClaudeLaunch, type ClaudeProcess } from "./cli-process";
import {
  catalogArgs,
  claudeArgs,
  controlError,
  controlRequest,
  controlSuccess,
  isSessionId,
  mapModels,
  readOnlyRole,
  realPath,
  sessionProcessRunning,
  sessionTranscriptExists,
  turnUsage,
  userMessage,
} from "./protocol";

export interface ClaudeRuntimeOptions {
  readonly executable?: string;
  /** Model when a run names none (otherwise the CLI's default). */
  readonly model?: string;
  readonly stopTimeoutMs?: number;
  /** How long a new process may take to report its session (default 60 seconds). */
  readonly startTimeoutMs?: number;
  // Pending approvals are rejected after this long (default 30 minutes).
  readonly approvalTimeoutMs?: number;
  readonly launch?: (launch: ClaudeLaunch) => ClaudeProcess;
  /** Whether the session's transcript exists for this workspace (default: the CLI's store). */
  readonly sessionExists?: (cwd: string, sessionId: string) => boolean;
  /** Whether a CLI process may still be running the session (default: the process list). */
  readonly sessionRunning?: (sessionId: string) => boolean;
  readonly newSessionId?: () => string;
  readonly now?: () => number;
}
interface Session {
  input: StartRunInput;
  // The workspace's real path: the CLI reports real paths.
  root: string;
  process: ClaudeProcess | undefined;
  id: string;
  state: RuntimeSessionSnapshot["state"];
  // Sequence of the last event a previous process reported (0 for a new session).
  base: number;
  // Scopes approval ids of a resumed session.
  approvalScope: string;
  // Usage already reported for the run; a resumed turn's usage is added to it.
  usageFloor: Partial<Record<UsageCounter, number>>;
  events: NormalizedRunEventDto[];
  waiters: Set<() => void>;
  uncertain: boolean;
  // system/init was received and checked.
  initialized: boolean;
  // Emit run.started when system/init arrives (new runs).
  announceOnInit: boolean;
  ready: { resolve: () => void; reject: (error: Error) => void } | undefined;
  stopping: boolean;
  model?: string;
  // The latest assistant text: the final reply unless anything follows it, in which case
  // it was a progress note and is reported as `run.message`.
  held?: string | undefined;
  tools: Map<
    string,
    { name: string; input: Record<string, unknown>; summary: string; tool: string }
  >;
  approvals: Map<string, PendingApproval>;
}
interface PendingApproval {
  requestId: string;
  input: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}
const REPLY_LIMIT = 8000;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const INITIALIZE_ID = "zamolxis-initialize";
const REJECTED = "The owner did not approve this operation in Zamolxis.";
const READ_ONLY_DENIAL = "This run is read-only: it may read the workspace but not change it.";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLAUDE_INVALID_FRAME");
  return value as Record<string, unknown>;
}
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
function terminal(session: Session): boolean {
  return ["completed", "failed", "stopped"].includes(session.state);
}

/**
 * Claude Code as an agent runtime: one `claude -p` stream-json process per turn, in the
 * assigned workspace, authenticated by the owner's own Claude Code login (API keys are
 * removed from its environment). The native session is Claude's session id; a restarted
 * Node continues it with `--resume`. Permission prompts are held for a human; nothing is
 * approved automatically.
 */
export class ClaudeRuntime implements AgentRuntime {
  readonly id = "claude";
  readonly #sessions = new Map<string, Session>();
  readonly #starts = new Map<
    string,
    { input: StartRunInput; result: Promise<RuntimeSessionSnapshot> }
  >();
  readonly #resumes = new Map<
    string,
    { input: ResumeRunInput; result: Promise<RuntimeSessionSnapshot> }
  >();
  constructor(private readonly options: ClaudeRuntimeOptions = {}) {}
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
  #launch(launch: ClaudeLaunch): ClaudeProcess {
    return (
      this.options.launch?.(launch) ??
      new ClaudeCliProcess({
        ...launch,
        ...(this.options.executable ? { executable: this.options.executable } : {}),
      })
    );
  }
  /**
   * The models the CLI offers (the `initialize` response), for the owner's login. The
   * process runs in a private scratch directory, never a workspace, and starts no turn.
   */
  async listModels(): Promise<RuntimeModelDto[]> {
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-claude-models-")));
    let process: ClaudeProcess | undefined;
    try {
      const launched = this.#launch({ cwd: scratch, args: catalogArgs() });
      process = launched;
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("CLAUDE_REQUEST_TIMEOUT")),
          this.options.startTimeoutMs ?? 60_000,
        );
        launched.onFrame((frame) => {
          if (frame.type !== "control_response") return;
          const body = optionalRecord(frame.response);
          if (body?.request_id !== INITIALIZE_ID) return;
          clearTimeout(timer);
          if (body.subtype !== "success") reject(new Error("CLAUDE_REQUEST_REJECTED"));
          else resolve(record(body.response));
        });
        launched.onClose(() => {
          clearTimeout(timer);
          reject(new Error("CLAUDE_PROCESS_EXITED"));
        });
        launched.write(controlRequest(INITIALIZE_ID, { subtype: "initialize" }));
      });
      return mapModels(response.models);
    } finally {
      process?.kill();
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
  #session(input: StartRunInput, id: string, resumed?: ResumeRunInput): Session {
    const base = resumed?.afterSequence ?? 0;
    return {
      input,
      root: realPath(input.workspace.cwd),
      process: undefined,
      id,
      state: "running",
      base,
      approvalScope: resumed ? `r${base}.` : "",
      usageFloor: { ...(resumed?.usage ?? {}) },
      events: [],
      waiters: new Set(),
      uncertain: false,
      initialized: false,
      announceOnInit: !resumed,
      ready: undefined,
      stopping: false,
      tools: new Map(),
      approvals: new Map(),
    };
  }
  // Launches the session's process and sends its turn; resolves once the CLI reported
  // the expected session in the assigned workspace.
  async #run(session: Session, args: string[], instruction: string): Promise<void> {
    const process = this.#launch({ cwd: session.input.workspace.cwd, args });
    session.process = process;
    const ready = new Promise<void>((resolve, reject) => {
      session.ready = { resolve, reject };
    });
    const timer = setTimeout(() => {
      session.ready?.reject(new Error("CLAUDE_START_TIMEOUT"));
      session.ready = undefined;
    }, this.options.startTimeoutMs ?? 60_000);
    process.onFrame((frame) => this.#frame(session, frame));
    process.onClose(() => {
      session.ready?.reject(new Error("CLAUDE_PROCESS_EXITED"));
      session.ready = undefined;
      if (session.initialized && !terminal(session)) this.#abort(session);
    });
    try {
      process.write(controlRequest(INITIALIZE_ID, { subtype: "initialize" }));
      process.write(userMessage(instruction));
      await ready;
    } catch (error) {
      process.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async #start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    const id = this.options.newSessionId?.() ?? randomUUID();
    if (!isSessionId(id) || this.#sessions.has(id)) throw new Error("RUNTIME_REQUEST_CONFLICT");
    const session = this.#session(input, id);
    try {
      await this.#run(
        session,
        claudeArgs({
          ...(input.role ? { role: input.role } : {}),
          ...((input.model ?? this.options.model)
            ? { model: input.model ?? this.options.model }
            : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          sessionId: id,
        }),
        input.instruction,
      );
      return this.#snapshot(session);
    } catch (error) {
      if (session.initialized && terminal(session)) return this.#snapshot(session);
      if (session.initialized) this.#abort(session);
      throw error;
    }
  }
  /**
   * Reattaches a run to its Claude session in a new Node process. The CLI process of the
   * old Node is gone (or still running, which is uncertain and never resumed), and its
   * transcript does not say reliably whether the last turn finished, so the turn is
   * treated as interrupted: continued with `--resume` and a new turn, failed or stopped
   * according to `interrupted`. A completed turn the Node already recorded never reaches
   * here (the Node completes it from its outbox).
   */
  resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    if (!isAbsolute(input.workspace.cwd) || !input.workspace.branch || !input.workspace.headSha)
      return Promise.reject(new Error("WORKSPACE_ASSIGNMENT_REQUIRED"));
    const after = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      return Promise.reject(new Error("INVALID_EVENT_CURSOR"));
    const live = this.#sessions.get(input.nativeSessionId);
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
    const forget = () => {
      if (this.#resumes.get(input.nativeSessionId) === entry)
        this.#resumes.delete(input.nativeSessionId);
    };
    result.then(forget, forget);
    return result;
  }
  async #resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    const id = input.nativeSessionId;
    if (!isSessionId(id)) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    const exists =
      this.options.sessionExists ??
      ((cwd: string, sessionId: string) => sessionTranscriptExists(cwd, sessionId));
    // The transcript lives under its workspace's project: another cwd does not find it.
    if (!exists(input.workspace.cwd, id)) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    if ((this.options.sessionRunning ?? sessionProcessRunning)(id))
      throw new Error("RECONCILIATION_REQUIRED");
    const previous = this.#sessions.get(id);
    if (previous && !previous.uncertain) throw new Error("RUNTIME_REQUEST_CONFLICT");
    const start: StartRunInput = {
      runId: input.runId,
      workstationId: input.workstationId,
      workspace: input.workspace,
      instruction: input.instruction,
      ...(input.role ? { role: input.role } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    };
    const session = this.#session(start, id, input);
    this.#sessions.set(id, session);
    if (input.announce) this.#emit(session, "run.started", { nativeSessionId: id });
    // Their permission requests died with the old process: nothing was approved.
    for (const approvalId of input.pendingApprovalIds ?? [])
      this.#emit(session, "approval.resolved", {
        approvalId,
        decision: "rejected",
        reason: "withdrawn",
      });
    const policy = input.interrupted ?? "fail";
    if (policy === "stop") {
      this.#finish(session, "stopped", "Stopped: the Node restarted before the turn ended");
      return this.#snapshot(session);
    }
    if (policy === "fail") {
      this.#finish(session, "failed", "Interrupted by a Node restart", RESTART_INTERRUPTED_CODE);
      return this.#snapshot(session);
    }
    this.#emit(session, "run.activity", { label: "Continuing after a restart" });
    try {
      await this.#run(
        session,
        claudeArgs({
          ...(start.role ? { role: start.role } : {}),
          ...((start.model ?? this.options.model)
            ? { model: start.model ?? this.options.model }
            : {}),
          ...(start.reasoningEffort ? { reasoningEffort: start.reasoningEffort } : {}),
          resume: id,
        }),
        RESTART_CONTINUATION,
      );
      return this.#snapshot(session);
    } catch (error) {
      if (terminal(session)) return this.#snapshot(session);
      this.#abort(session);
      throw error;
    }
  }
  async inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot> {
    return this.#snapshot(this.#get(nativeSessionId));
  }
  /** Adds a message to the running turn (the CLI reads it before its next step). */
  async send(input: { nativeSessionId: string; message: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) throw new Error("RUNTIME_TERMINAL");
    if (!session.process) throw new Error("RECONCILIATION_REQUIRED");
    session.process.write(userMessage(input.message));
  }
  async resolveApproval(input: {
    nativeSessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session) || !session.approvals.has(input.approvalId))
      throw new Error("APPROVAL_NOT_PENDING");
    if (input.decision === "approve_session") throw new Error("APPROVAL_SCOPE_UNAVAILABLE");
    this.#settleApproval(
      session,
      input.approvalId,
      input.decision === "reject" ? "rejected" : "approved",
      "user",
    );
  }
  async stop(input: { nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) return;
    const process = session.process;
    if (!process) throw new Error("RECONCILIATION_REQUIRED");
    // Nothing held for approval may run after a stop request.
    this.#rejectPending(session, "stopped");
    session.stopping = true;
    try {
      process.write(
        controlRequest(`zamolxis-interrupt-${session.events.length}`, { subtype: "interrupt" }),
      );
    } catch (error) {
      if (terminal(session)) return;
      throw error;
    }
    if (terminal(session)) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        if (!terminal(session) && !session.uncertain) return;
        clearTimeout(timer);
        session.waiters.delete(wake);
        if (terminal(session)) resolve();
        else reject(new Error("CLAUDE_STOP_UNCONFIRMED"));
      };
      const timer = setTimeout(() => {
        session.waiters.delete(wake);
        this.#abort(session);
        reject(new Error("CLAUDE_STOP_UNCONFIRMED"));
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
  #frame(session: Session, frame: Record<string, unknown>): void {
    if (terminal(session) || session.uncertain) return;
    try {
      // Frames of another session are never attributed to this run.
      if (
        typeof frame.session_id === "string" &&
        frame.session_id &&
        frame.session_id !== session.id
      )
        return;
      switch (frame.type) {
        case "system":
          if (frame.subtype === "init") this.#init(session, frame);
          return;
        case "control_request":
          this.#permission(session, frame);
          return;
        case "control_cancel_request":
          // The CLI withdrew a request (for example its turn was interrupted).
          for (const [approvalId, pending] of session.approvals)
            if (pending.requestId === frame.request_id)
              this.#settleApproval(session, approvalId, "rejected", "withdrawn", false);
          return;
        case "result":
          this.#result(session, frame);
          return;
        case "assistant":
          if (session.initialized) this.#assistant(session, frame);
          return;
        case "user":
          if (session.initialized) this.#toolResults(session, frame);
          return;
        default:
          return;
      }
    } catch {
      this.#abort(session);
    }
  }
  #init(session: Session, frame: Record<string, unknown>): void {
    if (session.initialized) return;
    const cwd = str(frame.cwd);
    if (frame.session_id !== session.id || !cwd || realPath(cwd) !== session.root) {
      session.ready?.reject(new Error("RUNTIME_WORKSPACE_MISMATCH"));
      session.ready = undefined;
      session.process?.kill();
      return;
    }
    session.initialized = true;
    this.#sessions.set(session.id, session);
    if (session.announceOnInit) this.#emit(session, "run.started", { nativeSessionId: session.id });
    session.ready?.resolve();
    session.ready = undefined;
  }
  #assistant(session: Session, frame: Record<string, unknown>): void {
    // Sub-agent output (the Task tool is not offered) is not the run's own.
    if (frame.parent_tool_use_id) return;
    const message = record(frame.message);
    const model = str(message.model);
    if (model && model !== session.model && model.length <= 256) {
      session.model = model;
      this.#emit(session, "run.usage", { modelActual: model });
    }
    if (!Array.isArray(message.content)) return;
    for (const value of message.content) {
      const block = optionalRecord(value);
      if (!block) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (!text) continue;
        this.#releaseHeld(session);
        session.held = text;
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        this.#releaseHeld(session);
        this.#emit(session, "run.activity", { label: "Thinking" });
      } else if (block.type === "tool_use") {
        this.#releaseHeld(session);
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name) continue;
        const input = optionalRecord(block.input) ?? {};
        const activity = describeTool(name, input, session.root);
        if (session.tools.size >= 1000) session.tools.clear();
        session.tools.set(id, { name, input, summary: activity.summary, tool: activity.tool });
        this.#emit(session, "tool.started", {
          tool: activity.tool,
          summary: activity.summary,
          ...(activity.reads ? { reads: activity.reads } : {}),
        });
      }
    }
  }
  #toolResults(session: Session, frame: Record<string, unknown>): void {
    if (frame.parent_tool_use_id) return;
    const message = optionalRecord(frame.message);
    if (!message || !Array.isArray(message.content)) return;
    const declined =
      Array.isArray(frame.tool_result_meta) &&
      frame.tool_result_meta.some((meta) => !!optionalRecord(meta)?.non_execution_kind);
    for (const value of message.content) {
      const block = optionalRecord(value);
      if (block?.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const tool = id ? session.tools.get(id) : undefined;
      if (!id || !tool) continue;
      session.tools.delete(id);
      const success = block.is_error !== true;
      this.#emit(session, "tool.completed", {
        tool: tool.tool,
        summary: completedSummary(tool.summary, success, declined),
        success,
      });
      const changed = success ? changedPath(tool.name, tool.input, session.root) : undefined;
      if (changed?.inside) this.#emit(session, "files.changed", { paths: [changed.path] });
      else if (changed)
        this.#emit(session, "run.activity", { label: "Changed a file outside the workspace" });
    }
  }
  #result(session: Session, frame: Record<string, unknown>): void {
    if (!session.initialized) {
      // The CLI ended before it reported the session (for example it is not signed in).
      session.ready?.reject(new Error("CLAUDE_START_FAILED"));
      session.ready = undefined;
      session.process?.kill();
      return;
    }
    const usage = turnUsage(frame.usage);
    if (usage) {
      const floor = session.usageFloor;
      const inputTokens = (floor.inputTokens ?? 0) + usage.inputTokens;
      const outputTokens = (floor.outputTokens ?? 0) + usage.outputTokens;
      this.#emit(session, "run.usage", {
        inputTokens,
        cachedInputTokens: (floor.cachedInputTokens ?? 0) + usage.cachedInputTokens,
        outputTokens,
        totalTokens: Math.max(inputTokens + outputTokens, floor.totalTokens ?? 0),
      });
    }
    const succeeded = frame.subtype === "success" && frame.is_error !== true;
    if (succeeded) {
      const reply = str(frame.result) ?? session.held;
      const summary = reply
        ? session.input.role === "supervisor"
          ? // The Supervisor's reply is structured JSON that the Node parses and redacts
            // field by field; redacting it here would corrupt values such as task keys.
            boundText(reply, REPLY_LIMIT)
          : redactedText(reply, REPLY_LIMIT, { keep: knownCommit(session.input.workspace.cwd) })
        : "Claude turn completed";
      this.#finish(session, "completed", summary);
    } else if (session.stopping) this.#finish(session, "stopped", "Claude turn interrupted");
    else {
      const errors = Array.isArray(frame.errors)
        ? frame.errors.find((error) => str(error))
        : undefined;
      const detail = str(frame.result) ?? str(errors) ?? str(frame.subtype) ?? "unknown error";
      this.#finish(
        session,
        "failed",
        `Claude turn failed: ${safeSummary(detail, 400)}`,
        "CLAUDE_TURN_FAILED",
      );
    }
  }
  #finish(
    session: Session,
    state: "completed" | "failed" | "stopped",
    message: string,
    code?: string,
  ): void {
    if (terminal(session)) return;
    // A completed turn's last text is its reply; otherwise it was only a progress note.
    if (state === "completed") session.held = undefined;
    else this.#releaseHeld(session);
    // Pending approvals settle (rejected) before the terminal event.
    this.#rejectPending(session, "stopped");
    session.state = state;
    if (state === "completed") this.#emit(session, "run.completed", { summary: message });
    else if (state === "stopped") this.#emit(session, "run.stopped", { reason: message });
    else this.#emit(session, "run.failed", { ...(code ? { code } : {}), message });
    session.process?.close();
  }
  #releaseHeld(session: Session): void {
    const held = session.held;
    session.held = undefined;
    if (held) this.#emit(session, "run.message", { text: agentNote(held) });
  }
  #emit(
    session: Session,
    type: NormalizedRunEventDto["type"],
    payload: Record<string, unknown>,
  ): void {
    if (session.events.length >= 10_000) {
      this.#abort(session);
      return;
    }
    const sequence = session.base + session.events.length + 1;
    session.events.push({
      type,
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
  // A permission request: held for a human, or denied for read-only runs. Other control
  // requests from the CLI (hooks, MCP) are refused; nothing is ever allowed automatically.
  #permission(session: Session, frame: Record<string, unknown>): void {
    const requestId = str(frame.request_id);
    const request = optionalRecord(frame.request);
    const process = session.process;
    if (!requestId || !request || !process) return;
    if (request.subtype !== "can_use_tool") {
      process.write(controlError(requestId, "Not supported by Zamolxis"));
      return;
    }
    const deny = (message: string) =>
      process.write(controlSuccess(requestId, { behavior: "deny", message }));
    if (
      !session.initialized ||
      session.stopping ||
      // Verifier and Supervisor stay read-only: they never escalate through approvals.
      readOnlyRole(session.input.role) ||
      session.approvals.size >= 16
    ) {
      deny(readOnlyRole(session.input.role) ? READ_ONLY_DENIAL : REJECTED);
      return;
    }
    const approvalId = approvalIdFor(session.input.runId, `${session.approvalScope}${requestId}`);
    if (session.approvals.has(approvalId)) {
      deny(REJECTED);
      return;
    }
    const held = describePermission(request, session.root);
    session.approvals.set(approvalId, {
      requestId,
      input: optionalRecord(request.input) ?? {},
      timer: setTimeout(() => {
        try {
          this.#settleApproval(session, approvalId, "rejected", "timeout");
        } catch {
          this.#abort(session);
        }
      }, this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS),
    });
    this.#emit(session, "approval.requested", {
      approvalId,
      kind: held.kind,
      summary: held.summary,
      risk: held.risk,
    });
  }
  // Answers the CLI (unless it withdrew the request) and records the outcome.
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
        if (!session.process) throw new Error("CLAUDE_TRANSPORT_CLOSED");
        // Exactly the requested input, and no permission updates ("always allow").
        session.process.write(
          controlSuccess(
            pending.requestId,
            decision === "approved"
              ? { behavior: "allow", updatedInput: pending.input }
              : { behavior: "deny", message: REJECTED },
          ),
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
    session.process?.kill();
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
