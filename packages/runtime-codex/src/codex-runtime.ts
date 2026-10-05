import { isAbsolute, relative, resolve } from "node:path";
import type { NormalizedRunEventDto, RuntimeCapabilitiesDto } from "@zamolxis/contracts";
import type {
  AgentRuntime,
  ResumeRunInput,
  RuntimeSessionSnapshot,
  StartRunInput,
} from "@zamolxis/runtime-core";
import { AppServerClient, type AppServerNotification } from "./app-server-client";

export interface CodexConnection {
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotification(listener: (event: AppServerNotification) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}
export interface CodexRuntimeOptions {
  readonly executable?: string;
  readonly model?: string;
  readonly stopTimeoutMs?: number;
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
}
const REPLY_LIMIT = 8000;
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
    };
    client.onNotification((event) => this.#notification(session, event));
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
  async stop(input: { nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) return;
    if (!session.turnId) throw new Error("RECONCILIATION_REQUIRED");
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
      if (item.type === "commandExecution" || item.type === "mcpToolCall") {
        const tool = item.type === "commandExecution" ? "command" : "mcp";
        this.#emit(
          session,
          done ? "tool.completed" : "tool.started",
          done
            ? {
                tool,
                summary: "Tool finished",
                success:
                  item.status === "completed" &&
                  (item.type !== "commandExecution" || item.exitCode === 0),
              }
            : { tool, summary: "Tool started" },
        );
      } else if (item.type === "fileChange" && done && item.status === "completed") {
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
          session.reply = item.text.trim().slice(0, REPLY_LIMIT);
      } else if (["agentMessage", "reasoning", "plan"].includes(String(item.type)) && !done) {
        this.#emit(session, "run.activity", {
          label: item.type === "agentMessage" ? "Agent responding" : "Agent planning",
        });
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
  #finish(session: Session, state: "completed" | "failed" | "stopped", message: string): void {
    if (terminal(session)) return;
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
      payload,
      eventId: `${session.id}:${sequence}`,
      sequence,
      runId: session.input.runId,
      workspaceId: session.input.workspace.workspaceId,
      workstationId: session.input.workstationId,
      occurredAt: this.options.now?.() ?? Date.now(),
    } as NormalizedRunEventDto);
    for (const wake of session.waiters) wake();
  }
  #abort(session: Session): void {
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
