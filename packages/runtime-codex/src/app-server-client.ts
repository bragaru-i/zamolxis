import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { withoutGitHubTokens } from "@zamolxis/runtime-core";

export interface AppServerProcess {
  readonly stdout: Readable;
  readonly stdin: Writable;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}
export interface AppServerNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}
export type AppServerRequestId = string | number;
export interface AppServerRequest {
  readonly id: AppServerRequestId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}
// Returns true when the handler holds the request and will answer it with respond().
export type AppServerRequestHandler = (request: AppServerRequest) => boolean;
// Credential, login and attestation requests are refused here, before any handler sees them.
const CREDENTIAL_METHOD = /(auth|token|credential|login|attestation|secret|password|account)/i;
export function isCredentialRequest(method: string): boolean {
  return CREDENTIAL_METHOD.test(method);
}
export interface AppServerClientOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly launch?: (executable: string, cwd: string) => AppServerProcess;
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The Codex app-server environment: the Node's own plus `overrides`, without GitHub
 * tokens. Agents never publish; only the Node does, with each repository's own token.
 */
export function codexEnv(
  overrides: NodeJS.ProcessEnv = {},
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return withoutGitHubTokens({ ...env, ...overrides });
}

/**
 * Local stdio only. Server-initiated requests are refused unless a handler explicitly holds
 * them; credential requests are always refused. Nothing is answered automatically with an
 * approval.
 */
export class AppServerClient {
  readonly #process: AppServerProcess;
  readonly #pending = new Map<number, PendingRequest>();
  // Server requests held by a handler and not answered yet.
  readonly #held = new Set<AppServerRequestId>();
  #requestHandler: AppServerRequestHandler | undefined;
  readonly #closeListeners = new Set<() => void>();
  readonly #listeners = new Set<(event: AppServerNotification) => void>();
  #nextId = 0;
  #buffer = "";
  #closed = false;
  constructor(private readonly options: AppServerClientOptions) {
    if (!options.cwd.startsWith("/")) throw new Error("ABSOLUTE_WORKSPACE_REQUIRED");
    this.#process = (
      options.launch ??
      ((executable, cwd) =>
        spawn(executable, ["app-server", "--listen", "stdio://"], {
          cwd,
          env: codexEnv(),
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
        }))
    )(options.executable ?? "codex", options.cwd);
    this.#process.stdout.setEncoding("utf8");
    this.#process.stdout.on("data", (chunk: string) => this.#receive(chunk));
    this.#process.stdout.on("error", () => this.#fail("CODEX_TRANSPORT_FAILED"));
    this.#process.stdin.on("error", () => this.#fail("CODEX_TRANSPORT_FAILED"));
    this.#process.on("error", () => this.#fail("CODEX_PROCESS_FAILED"));
    this.#process.on("exit", () => this.#fail("CODEX_PROCESS_EXITED"));
  }
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "zamolxis", title: "Zamolxis", version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    this.#write({ method: "initialized" });
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("CODEX_TRANSPORT_CLOSED"));
    if (this.#pending.size >= 64) return Promise.reject(new Error("CODEX_REQUEST_LIMIT"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail("CODEX_REQUEST_TIMEOUT");
      }, this.options.timeoutMs ?? 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch {
        this.#fail("CODEX_TRANSPORT_FAILED");
      }
    });
  }
  onNotification(listener: (event: AppServerNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onServerRequest(handler: AppServerRequestHandler): () => void {
    this.#requestHandler = handler;
    return () => {
      if (this.#requestHandler === handler) this.#requestHandler = undefined;
    };
  }
  /** Answers a held server request exactly once. */
  respond(id: AppServerRequestId, result: Record<string, unknown>): void {
    if (!this.#held.delete(id)) throw new Error("CODEX_REQUEST_NOT_HELD");
    this.#write({ id, result });
  }
  onClose(listener: () => void): () => void {
    if (this.#closed) listener();
    else this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }
  close(): void {
    this.#fail("CODEX_TRANSPORT_CLOSED");
  }
  #write(frame: unknown): void {
    if (this.#closed) throw new Error("CODEX_TRANSPORT_CLOSED");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? 1_048_576))
      throw new Error("CODEX_FRAME_TOO_LARGE");
    this.#process.stdin.write(line);
  }
  #receive(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    const limit = this.options.maxFrameBytes ?? 1_048_576;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (Buffer.byteLength(line) > limit) {
        this.#fail("CODEX_FRAME_TOO_LARGE");
        return;
      }
      if (!line.trim()) continue;
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          this.#fail("CODEX_INVALID_FRAME");
          return;
        }
        this.#dispatch(frame as Record<string, unknown>);
      } catch {
        this.#fail("CODEX_INVALID_FRAME");
        return;
      }
    }
    if (Buffer.byteLength(this.#buffer) > limit) this.#fail("CODEX_FRAME_TOO_LARGE");
  }
  #dispatch(frame: Record<string, unknown>): void {
    if (typeof frame.method === "string") {
      if (frame.id !== undefined) {
        this.#serverRequest(frame);
        return;
      }
      if (!frame.params || typeof frame.params !== "object" || Array.isArray(frame.params)) {
        this.#fail("CODEX_INVALID_FRAME");
        return;
      }
      const event = { method: frame.method, params: frame.params as Record<string, unknown> };
      for (const listener of this.#listeners) listener(event);
      return;
    }
    if (typeof frame.id !== "number") {
      this.#fail("CODEX_INVALID_FRAME");
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if ("error" in frame) pending.reject(new Error("CODEX_REQUEST_REJECTED"));
    else if ("result" in frame) pending.resolve(frame.result);
    else {
      pending.reject(new Error("CODEX_INVALID_FRAME"));
      this.#fail("CODEX_INVALID_FRAME");
    }
  }
  #serverRequest(frame: Record<string, unknown>): void {
    const id = frame.id;
    const method = String(frame.method);
    const refuse = (message: string) => this.#write({ id, error: { code: -32601, message } });
    if ((typeof id !== "string" && typeof id !== "number") || this.#held.has(id)) {
      this.#fail("CODEX_INVALID_FRAME");
      return;
    }
    // Never auto-approve; credential requests are never delegated to anyone.
    if (isCredentialRequest(method)) {
      refuse("Credential requests are not supported");
      return;
    }
    const handler = this.#requestHandler;
    const params = frame.params;
    if (
      !handler ||
      this.#held.size >= 64 ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      refuse("Approval bridge unavailable");
      return;
    }
    this.#held.add(id);
    let held = false;
    try {
      held = handler({ id, method, params: params as Record<string, unknown> });
    } catch {
      held = false;
    }
    if (!held && this.#held.delete(id)) refuse("Request not supported");
  }
  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.#pending.clear();
    this.#held.clear();
    this.#requestHandler = undefined;
    this.#listeners.clear();
    this.#process.kill();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }
}
