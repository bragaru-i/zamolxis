import {
  type AgentRuntime,
  boundRuntimeModels,
  type RuntimeModelDto,
} from "@zamolxis/runtime-core";

export const MODEL_REFRESH_MS = 30 * 60 * 1000;
const MODEL_WAIT_MS = 10_000;
export interface RuntimeModelCatalogOptions {
  /** Minimum time between two model fetches of one runtime (default 30 minutes). */
  readonly refreshMs?: number;
  /** How long a heartbeat waits for a fetch before sending the previous list (10 s). */
  readonly waitMs?: number;
  readonly now?: () => number;
}
export interface RuntimeHeartbeatEntry {
  readonly runtime: string;
  readonly capabilities: readonly string[];
  readonly version?: string;
}
interface CatalogEntry {
  models?: RuntimeModelDto[];
  attemptedAt?: number;
  inflight?: Promise<void> | undefined;
}

/**
 * Caches the models each runtime reports. A runtime is asked at most once per refresh
 * interval, whether the previous attempt succeeded or failed; a failure keeps the previous
 * list. Nothing here ever throws into the heartbeat.
 */
export class RuntimeModelCatalog {
  readonly #entries = new Map<string, CatalogEntry>();
  constructor(
    private readonly runtimes: (id: string) => AgentRuntime | undefined,
    private readonly options: RuntimeModelCatalogOptions = {},
  ) {}
  /** The last known models of a runtime, refreshing them first when they are stale. */
  async models(runtimeId: string): Promise<RuntimeModelDto[] | undefined> {
    const runtime = this.runtimes(runtimeId);
    if (!runtime?.listModels) return undefined;
    const entry = this.#entries.get(runtimeId) ?? {};
    this.#entries.set(runtimeId, entry);
    const now = (this.options.now ?? Date.now)();
    if (
      !entry.inflight &&
      (entry.attemptedAt === undefined ||
        now - entry.attemptedAt >= (this.options.refreshMs ?? MODEL_REFRESH_MS))
    ) {
      entry.attemptedAt = now;
      entry.inflight = Promise.resolve()
        .then(() => runtime.listModels?.())
        .then(
          (models) => {
            if (Array.isArray(models)) entry.models = boundRuntimeModels(models);
          },
          () => {
            console.error("RUNTIME_MODELS_UNAVAILABLE");
          },
        )
        .finally(() => {
          entry.inflight = undefined;
        });
    }
    if (entry.inflight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        entry.inflight,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.waitMs ?? MODEL_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return entry.models;
  }
  /** Heartbeat entries with each runtime's models attached when known. */
  async advertise<T extends RuntimeHeartbeatEntry>(
    entries: readonly T[],
  ): Promise<(T & { models?: RuntimeModelDto[] })[]> {
    return Promise.all(
      entries.map(async (entry) => {
        let models: RuntimeModelDto[] | undefined;
        try {
          models = await this.models(entry.runtime);
        } catch {
          models = undefined;
        }
        return models ? { ...entry, models } : entry;
      }),
    );
  }
}
