import { LocalChatRuntime } from "@zamolxis/runtime-local";

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
  return `✓ Local model: ${server?.name ?? runtime.baseUrl}${models.length ? ` (${models.slice(0, 3).join(", ")})` : ""}, optional; can answer as the Orchestrator (Settings → Agents → Orchestrator → Local model)`;
}
