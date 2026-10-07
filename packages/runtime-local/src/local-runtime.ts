import { randomUUID } from "node:crypto";
import type { NormalizedRunEventDto, RuntimeCapabilitiesDto } from "@zamolxis/contracts";
import {
  type AgentRuntime,
  type RuntimeModelDto,
  type RuntimeSessionSnapshot,
  type StartRunInput,
  safeSummary,
} from "@zamolxis/runtime-core";

export const LOCAL_RUNTIME_ID = "local";
// The Orchestrator's turn runs in a scratch workspace marked with this branch.
const ORCHESTRATOR_BRANCH = "orchestrator";
const REQUEST_TIMEOUT_MS = 4 * 60_000;
const REPLY_LIMIT = 16_000;

export interface LocalChatRuntimeOptions {
  /**
   * OpenAI-compatible APIs to try in order, e.g. LM Studio's `http://127.0.0.1:1234/v1`;
   * the first that lists a chat model is used.
   */
  readonly baseUrls: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface Session {
  readonly id: string;
  readonly input: StartRunInput;
  state: RuntimeSessionSnapshot["state"];
  readonly events: NormalizedRunEventDto[];
  readonly waiters: Set<() => void>;
  readonly abort: AbortController;
}
const terminal = (session: Session) =>
  session.state === "completed" || session.state === "failed" || session.state === "stopped";

/**
 * A model served on this computer (LM Studio, mlx_lm.server, Ollama…) through an
 * OpenAI-compatible chat API. It only writes text: no tools, no repository, no approvals,
 * so it runs the Orchestrator's Home-chat replies and nothing else. One chat completion per
 * turn; the reply is the turn's summary, which the Node parses like any other runtime's.
 */
export class LocalChatRuntime implements AgentRuntime {
  readonly id = LOCAL_RUNTIME_ID;
  readonly #sessions = new Map<string, Session>();
  readonly #fetch: typeof fetch;
  readonly #baseUrls: readonly string[];
  // The server that answered last; servers can be started and stopped at any time.
  #active: string | undefined;

  constructor(private readonly options: LocalChatRuntimeOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrls = options.baseUrls.map((url) => url.replace(/\/+$/, ""));
  }

  /** The server in use, once one answered (for status lines). */
  get baseUrl(): string | undefined {
    return this.#active;
  }

  capabilities(): RuntimeCapabilitiesDto {
    return {
      runtime: LOCAL_RUNTIME_ID,
      canStart: true,
      canResume: false,
      canMessage: false,
      canStop: true,
      canDiscoverSessions: false,
      supportsSubagents: false,
      canApprove: false,
    };
  }

  /** Whether a server answers now (the Node advertises the runtime only then). */
  async reachable(): Promise<boolean> {
    for (const url of this.#baseUrls) {
      try {
        if ((await this.#modelsAt(url, 2000)).length) {
          this.#active = url;
          return true;
        }
      } catch {
        /* try the next server */
      }
    }
    this.#active = undefined;
    return false;
  }

  async listModels(): Promise<RuntimeModelDto[]> {
    const ids = await this.#models(10_000);
    return ids.map((id, index) => ({
      id,
      displayName: id,
      ...(index === 0 ? { isDefault: true } : {}),
    }));
  }

  async start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    // Text only: never a Builder, Verifier, Repair or repository Supervisor.
    if (input.role !== "supervisor" || input.workspace.branch !== ORCHESTRATOR_BRANCH)
      throw new Error("LOCAL_RUNTIME_ORCHESTRATOR_ONLY");
    const session: Session = {
      id: randomUUID(),
      input,
      state: "running",
      events: [],
      waiters: new Set(),
      abort: new AbortController(),
    };
    this.#sessions.set(session.id, session);
    this.#emit(session, "run.started", { nativeSessionId: session.id });
    void this.#turn(session);
    return this.#snapshot(session);
  }

  async resume(): Promise<RuntimeSessionSnapshot> {
    throw new Error("RUNTIME_RESUME_UNSUPPORTED");
  }
  async send(): Promise<void> {
    throw new Error("RUNTIME_MESSAGE_UNSUPPORTED");
  }

  async stop(input: { readonly nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (terminal(session)) return;
    session.abort.abort();
    this.#finish(session, "stopped", { reason: "Stopped" });
  }

  async inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot> {
    return this.#snapshot(this.#get(nativeSessionId));
  }

  async *subscribe(input: {
    nativeSessionId: string;
    afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto> {
    let cursor = input.afterSequence ?? 0;
    const session = this.#get(input.nativeSessionId);
    while (true) {
      for (const event of session.events)
        if (event.sequence > cursor) {
          cursor = event.sequence;
          yield structuredClone(event);
        }
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

  async #base(): Promise<string> {
    if (this.#active || (await this.reachable())) return this.#active as string;
    throw new Error("No local model server is running");
  }

  async #models(timeoutMs: number): Promise<string[]> {
    return this.#modelsAt(await this.#base(), timeoutMs);
  }

  async #modelsAt(baseUrl: string, timeoutMs: number): Promise<string[]> {
    const response = await this.#fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error("LOCAL_MODEL_UNAVAILABLE");
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    // Embedding models cannot chat.
    return (body.data ?? [])
      .map((model) => (typeof model.id === "string" ? model.id : ""))
      .filter((id) => id && !/embed/i.test(id))
      .slice(0, 100);
  }

  async #turn(session: Session): Promise<void> {
    const timeout = setTimeout(() => session.abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const model = session.input.model ?? (await this.#models(10_000))[0];
      if (!model) throw new Error("No local model is loaded");
      this.#emit(session, "run.activity", { label: "Writing a reply" });
      const response = await this.#fetch(`${await this.#base()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: session.abort.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: session.input.instruction }],
          temperature: 0.2,
        }),
      });
      if (!response.ok) throw new Error(`The local model server answered ${response.status}`);
      const body = (await response.json()) as {
        model?: unknown;
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      if (terminal(session)) return;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim())
        throw new Error("The local model returned no reply");
      const count = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
      const input = count(body.usage?.prompt_tokens);
      const output = count(body.usage?.completion_tokens);
      this.#emit(session, "run.usage", {
        modelActual: (typeof body.model === "string" ? body.model : model).slice(0, 256),
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {}),
        modelCalls: 1,
      });
      this.#finish(session, "completed", { summary: content.slice(0, REPLY_LIMIT) });
    } catch (error) {
      if (terminal(session)) return;
      const reason = error instanceof Error ? error.message : "request failed";
      this.#finish(session, "failed", {
        code: "LOCAL_MODEL_FAILED",
        message: `Local model failed: ${safeSummary(
          session.abort.signal.aborted ? "it took too long" : reason,
          400,
        )}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #finish(
    session: Session,
    state: "completed" | "failed" | "stopped",
    payload: Record<string, unknown>,
  ): void {
    session.state = state;
    this.#emit(session, `run.${state}`, payload);
  }

  #emit(session: Session, type: NormalizedRunEventDto["type"], payload: Record<string, unknown>) {
    const sequence = session.events.length + 1;
    session.events.push({
      type,
      payload,
      eventId: `${session.id}:${sequence}`,
      sequence,
      runId: session.input.runId,
      workspaceId: session.input.workspace.workspaceId,
      workstationId: session.input.workstationId,
      occurredAt: (this.options.now ?? Date.now)(),
    } as NormalizedRunEventDto);
    for (const wake of [...session.waiters]) wake();
  }

  #snapshot(session: Session): RuntimeSessionSnapshot {
    return {
      nativeSessionId: session.id,
      runId: session.input.runId,
      workspace: session.input.workspace,
      state: session.state,
      lastSequence: session.events.length,
    };
  }

  #get(nativeSessionId: string): Session {
    const session = this.#sessions.get(nativeSessionId);
    if (!session) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    return session;
  }
}
