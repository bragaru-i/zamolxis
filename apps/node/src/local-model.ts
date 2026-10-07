import { LocalChatRuntime } from "@zamolxis/runtime-local";

/** Codex driving the model served on this computer (read-only roles). */
export const CODEX_LOCAL_RUNTIME_ID = "codex-local";

/**
 * Where a model served on this computer is looked for, in order: an explicit address
 * (`ZAMOLXIS_LOCAL_MODEL_URL`), then LM Studio, Ollama and mlx_lm.server on their default
 * ports. Only this computer's loopback address: a local model never leaves the machine.
 */
export const LOCAL_MODEL_SERVERS: readonly { name: string; url: string }[] = [
  ...(process.env.ZAMOLXIS_LOCAL_MODEL_URL
    ? [{ name: "Configured server", url: process.env.ZAMOLXIS_LOCAL_MODEL_URL }]
    : []),
  { name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  { name: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { name: "MLX (mlx_lm.server)", url: "http://127.0.0.1:8080/v1" },
];

export function localModelRuntime(): LocalChatRuntime {
  return new LocalChatRuntime({ baseUrls: LOCAL_MODEL_SERVERS.map((server) => server.url) });
}

/** One line for setup and doctor: what local model this computer offers, if any. */
export async function localModelStatus(runtime = localModelRuntime()): Promise<string> {
  if (!(await runtime.reachable()))
    return "– No local model server found (optional: start LM Studio, Ollama or mlx_lm.server with a chat model, and choose it for the Orchestrator in Settings → Agents)";
  const server = LOCAL_MODEL_SERVERS.find(
    (item) => item.url.replace(/\/+$/, "") === runtime.baseUrl,
  );
  const models = (await runtime.listModels().catch(() => [])).map((model) => model.id);
  const codex = await codexLocalReady(runtime);
  return `✓ Local model: ${server?.name ?? runtime.baseUrl}${models.length ? ` (${models.slice(0, 3).join(", ")})` : ""}, optional; can answer as the Orchestrator${
    codex.ready
      ? ", and plan and check through Codex (Codex + local model)"
      : `; Codex + local model not available: ${codex.reason}`
  }`;
}

/** Codex's built-in provider for the local server in use, if Codex can drive it. */
export function codexProvider(baseUrl: string | undefined): "lmstudio" | "ollama" | undefined {
  if (!baseUrl) return undefined;
  const port = new URL(baseUrl).port;
  return port === "1234" ? "lmstudio" : port === "11434" ? "ollama" : undefined;
}

/** Codex's own instructions and tools need about this many tokens of context to start. */
export const CODEX_LOCAL_MIN_CONTEXT = 32_768;

/**
 * The largest context a loaded model has in LM Studio (its /api/v0 REST API), else
 * undefined (other servers do not report it).
 */
export async function loadedContext(baseUrl: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${new URL(baseUrl).origin}/api/v0/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: { state?: string; loaded_context_length?: unknown }[];
    };
    const sizes = (body.data ?? [])
      .filter((model) => model.state === "loaded")
      .map((model) => model.loaded_context_length)
      .filter((size): size is number => typeof size === "number");
    return sizes.length ? Math.max(...sizes) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether Codex can use the local model now: a server Codex supports answers and, for LM
 * Studio, a loaded model has enough context for Codex's instructions.
 */
export async function codexLocalReady(runtime: {
  reachable(): Promise<boolean>;
  readonly baseUrl: string | undefined;
}): Promise<{ ready: boolean; provider?: "lmstudio" | "ollama"; reason?: string }> {
  if (!(await runtime.reachable())) return { ready: false, reason: "no local model server" };
  const provider = codexProvider(runtime.baseUrl);
  if (!provider) return { ready: false, reason: "Codex works with LM Studio or Ollama only" };
  if (provider === "lmstudio" && runtime.baseUrl) {
    const context = await loadedContext(runtime.baseUrl);
    if (context !== undefined && context < CODEX_LOCAL_MIN_CONTEXT)
      return {
        ready: false,
        provider,
        reason: `the model is loaded with ${context} tokens of context; Codex needs ${CODEX_LOCAL_MIN_CONTEXT} (LM Studio → model → Context Length)`,
      };
  }
  return { ready: true, provider };
}
