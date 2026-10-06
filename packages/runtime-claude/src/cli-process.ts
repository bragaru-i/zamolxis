import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { withoutGitHubTokens } from "@zamolxis/runtime-core";

/** A launched `claude -p` process speaking stream-json (NDJSON) on stdin/stdout. */
export interface ClaudeProcess {
  /** Writes one frame; throws CLAUDE_TRANSPORT_CLOSED once closed. */
  write(frame: Record<string, unknown>): void;
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  /** Called once when the process exits or the transport fails. */
  onClose(listener: () => void): () => void;
  /** Ends stdin (the CLI exits when idle) and kills the process after a grace period. */
  close(): void;
  /** Kills the process now. */
  kill(): void;
}
export interface ClaudeLaunch {
  readonly cwd: string;
  readonly args: readonly string[];
}
export interface ChildLike {
  readonly stdout: Readable;
  readonly stdin: Writable;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export interface ClaudeCliProcessOptions extends ClaudeLaunch {
  readonly executable?: string;
  /** Lines longer than this are skipped (large tool output is never needed). */
  readonly maxFrameBytes?: number;
  readonly killAfterMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnChild?: (executable: string, args: readonly string[], cwd: string) => ChildLike;
}

// The owner's Claude subscription login is used, never an API key: these variables would
// make the CLI bill an API account instead, so they never reach the child. A base URL is
// dropped too, so the owner's login is never sent to a gateway or proxy.
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;
/**
 * The child environment: the Node's own, without API credentials and without GitHub
 * tokens (agents never publish; only the Node does, with each repository's own token).
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = withoutGitHubTokens(env);
  for (const name of STRIPPED_ENV) delete copy[name];
  return copy;
}

/**
 * Local stdio transport for the Claude Code CLI. Frames are NDJSON objects; anything that
 * is not a JSON object is ignored (the CLI only writes frames to stdout). stderr is
 * discarded so CLI diagnostics never reach events.
 */
export class ClaudeCliProcess implements ClaudeProcess {
  readonly #child: ChildLike;
  readonly #frames = new Set<(frame: Record<string, unknown>) => void>();
  readonly #closers = new Set<() => void>();
  #buffer = "";
  #skipping = false;
  #closed = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: ClaudeCliProcessOptions) {
    if (!options.cwd.startsWith("/")) throw new Error("ABSOLUTE_WORKSPACE_REQUIRED");
    const executable = options.executable ?? "claude";
    this.#child = (
      options.spawnChild ??
      ((file, args, cwd) =>
        spawn(file, [...args], {
          cwd,
          env: claudeEnv(options.env),
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
        }))
    )(executable, options.args, options.cwd);
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#receive(chunk));
    this.#child.stdout.on("error", () => this.#end());
    this.#child.stdin.on("error", () => this.#end());
    this.#child.on("error", () => this.#end());
    this.#child.on("exit", () => this.#end());
  }
  write(frame: Record<string, unknown>): void {
    if (this.#closed) throw new Error("CLAUDE_TRANSPORT_CLOSED");
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.#frames.add(listener);
    return () => this.#frames.delete(listener);
  }
  onClose(listener: () => void): () => void {
    if (this.#closed) listener();
    else this.#closers.add(listener);
    return () => this.#closers.delete(listener);
  }
  close(): void {
    if (this.#closed || this.#killTimer) return;
    try {
      this.#child.stdin.end();
    } catch {
      /* already closed */
    }
    this.#killTimer = setTimeout(() => this.kill(), this.options.killAfterMs ?? 5000);
    this.#killTimer.unref?.();
  }
  kill(): void {
    try {
      this.#child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    this.#end();
  }
  #receive(chunk: string): void {
    if (this.#closed) return;
    const limit = this.options.maxFrameBytes ?? 16 * 1024 * 1024;
    this.#buffer += chunk;
    while (true) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (!line.trim() || line.length > limit) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
      for (const listener of this.#frames) listener(frame as Record<string, unknown>);
      if (this.#closed) return;
    }
    // An oversized line is dropped up to its end rather than buffered.
    if (this.#buffer.length > limit) {
      this.#buffer = "";
      this.#skipping = true;
    }
  }
  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#frames.clear();
    for (const listener of this.#closers) listener();
    this.#closers.clear();
  }
}
