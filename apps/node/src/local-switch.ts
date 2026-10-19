import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keeps the local model the next run asks for loaded in LM Studio, with enough context
 * for Codex. Only one model fits next to the others on most computers, so a different one
 * is swapped in: after the loaded models are idle (a running agent is never cut off),
 * everything is unloaded and the requested model is loaded. Switches run one at a time.
 */
export interface LoadedModel {
  readonly identifier: string;
  readonly status?: string;
  readonly contextLength?: number;
}
export type Exec = (args: string[], timeoutMs: number) => Promise<string>;

const IDLE_WAIT_MS = 15 * 60_000;
const LOAD_TIMEOUT_MS = 10 * 60_000;

export function lmsPath(): string | undefined {
  const bundled = join(homedir(), ".lmstudio", "bin", "lms");
  return existsSync(bundled) ? bundled : undefined;
}

export function execLms(executable: string): Exec {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) =>
      execFile(
        executable,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
}

export class LocalModelSwitch {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      readonly exec: Exec;
      readonly minContext: number;
      readonly sleep?: (ms: number) => Promise<void>;
      readonly now?: () => number;
    },
  ) {}

  async loaded(): Promise<LoadedModel[]> {
    const parsed: unknown = JSON.parse(await this.options.exec(["ps", "--json"], 30_000));
    return Array.isArray(parsed)
      ? parsed.flatMap((item): LoadedModel[] =>
          item && typeof item.identifier === "string"
            ? [
                {
                  identifier: item.identifier,
                  ...(typeof item.status === "string" ? { status: item.status } : {}),
                  ...(typeof item.contextLength === "number"
                    ? { contextLength: item.contextLength }
                    : {}),
                },
              ]
            : [],
        )
      : [];
  }

  /** Resolves once `model` is loaded with enough context; switches one at a time. */
  ensure(model: string): Promise<void> {
    const next = this.#queue.then(() => this.#ensure(model));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #ensure(model: string): Promise<void> {
    const ready = (models: LoadedModel[]) =>
      models.some(
        (item) => item.identifier === model && (item.contextLength ?? 0) >= this.options.minContext,
      );
    let models = await this.loaded();
    if (ready(models)) return;
    const sleep = this.options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    const now = this.options.now ?? Date.now;
    const deadline = now() + IDLE_WAIT_MS;
    while (models.some((item) => item.status === "generating")) {
      if (now() > deadline) throw new Error("LOCAL_MODEL_BUSY");
      await sleep(3000);
      models = await this.loaded();
      if (ready(models)) return;
    }
    if (models.length) await this.options.exec(["unload", "--all"], 60_000);
    await this.options.exec(
      [
        "load",
        model,
        "--context-length",
        String(this.options.minContext),
        "--identifier",
        model,
        "--yes",
      ],
      LOAD_TIMEOUT_MS,
    );
    if (!ready(await this.loaded())) throw new Error("LOCAL_MODEL_SWITCH_FAILED");
  }
}
