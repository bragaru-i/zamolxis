import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

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

/** Local stdio only. Server-initiated operations require a later approval bridge. */
export class AppServerClient {
  readonly #process: AppServerProcess;
  readonly #pending = new Map<number, PendingRequest>();
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
        // Never auto-approve commands, file changes, tools or credential requests.
        this.#write({
          id: frame.id,
          error: { code: -32601, message: "Approval bridge unavailable" },
        });
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
  #fail(code: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#process.kill();
  }
}
