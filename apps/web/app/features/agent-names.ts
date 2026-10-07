/** One model of an agent: the runtime that drives it and, optionally, the model id. */
export interface ChainEntry {
  runtime: string;
  model?: string;
  reasoningEffort?: string;
}

const RUNTIMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  local: "Local model",
  "codex-local": "Local model",
  hermes: "Hermes",
};
// Where a model runs, when that is worth saying.
const WHERE: Record<string, string> = {
  local: "on your computer",
  "codex-local": "via Codex, on your computer",
};

/**
 * A model id in words: "claude-haiku-4-5-20251001" → "Claude Haiku 4.5",
 * "qwen/qwen3-coder-30b" → "Qwen3 Coder 30B", "gpt-6.1-sol" → "GPT 6.1 Sol".
 */
export function modelName(runtime: string, model?: string): string {
  if (!model) return runtime === "codex" ? "Codex" : (RUNTIMES[runtime] ?? runtime);
  const claude = model.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (claude?.[1] && claude[2] && claude[3])
    return `Claude ${claude[1][0]?.toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  if (/^(opus|sonnet|haiku)$/i.test(model))
    return `Claude ${model[0]?.toUpperCase()}${model.slice(1).toLowerCase()}`;
  const base = model.split("/").at(-1) ?? model;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      /^gpt$/i.test(part)
        ? "GPT"
        : /^\d+(\.\d+)?b$/i.test(part)
          ? part.toUpperCase()
          : `${part[0]?.toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

/** "Qwen3 Coder 30B (via Codex, on your computer)", "Claude Haiku 4.5", "Codex". */
export function agentStep(entry: ChainEntry): string {
  const name = modelName(entry.runtime, entry.model);
  const where = WHERE[entry.runtime];
  const prefix = entry.runtime === "codex" && entry.model ? "Codex · " : "";
  return `${prefix}${name}${where ? ` (${where})` : ""}`;
}

/** The whole agent: its first model, then its backups. */
export function chainText(chain: readonly ChainEntry[], checksOnly = false): string {
  if (checksOnly) return "Runs the project's checks; no AI model";
  return chain.map(agentStep).join(" → ");
}

/** The jobs, in the owner's words, in the order work moves. */
export const JOBS = [
  { role: "orchestrator", label: "Chat with you", help: "Answers you in Home chat." },
  { role: "supervisor", label: "Plan the work", help: "Reads the code and splits the work." },
  { role: "builder", label: "Write the code", help: "Makes the change." },
  { role: "verifier", label: "Check it", help: "Checks the change independently." },
  { role: "repair", label: "Fix failures", help: "Fixes what the check found." },
] as const;
export type Job = (typeof JOBS)[number]["role"];
