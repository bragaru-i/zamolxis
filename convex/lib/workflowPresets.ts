import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { runtimeAllowedFor } from "./agentProfiles";

/**
 * Recommended workflows, offered under "Start from" when a workflow is created. Each role has
 * a chain: the first agent, then backups used when a computer cannot run the one before.
 * `model` is a hint matched against the models the owner's computers report ("haiku" picks
 * the Claude Haiku model the owner's login offers); without a match the agent's default
 * model is used. Agents no computer offers are left out of the chain.
 */
export const WORKFLOW_PRESETS = [
  "save_tokens",
  "balanced",
  "max_quality",
  "codex_only",
  "local_first",
] as const;
export type WorkflowPreset = (typeof WORKFLOW_PRESETS)[number];
export const workflowPreset = v.union(...WORKFLOW_PRESETS.map((preset) => v.literal(preset)));

type PresetRole = "orchestrator" | "supervisor" | "builder" | "verifier" | "repair";
interface PresetAgent {
  runtime: string;
  model?: string;
}
interface PresetRoleSettings {
  chain: PresetAgent[];
  checksOnly?: true;
}

const CODEX: PresetAgent = { runtime: "codex" };
const LOCAL: PresetAgent = { runtime: "local", model: "qwen" };
// The local model with Codex's tools: it can read the repository to plan or check.
const CODEX_LOCAL: PresetAgent = { runtime: "codex-local", model: "qwen" };
const claude = (model: "haiku" | "sonnet" | "opus"): PresetAgent => ({ runtime: "claude", model });

export const PRESETS: Record<
  WorkflowPreset,
  { name: string; roles: Record<PresetRole, PresetRoleSettings> }
> = {
  save_tokens: {
    name: "Save tokens",
    roles: {
      orchestrator: { chain: [LOCAL, CODEX] },
      supervisor: { chain: [CODEX_LOCAL, claude("haiku"), CODEX] },
      builder: { chain: [claude("sonnet"), CODEX] },
      verifier: { chain: [CODEX], checksOnly: true },
      repair: { chain: [claude("sonnet"), CODEX] },
    },
  },
  balanced: {
    name: "Balanced",
    roles: {
      orchestrator: { chain: [LOCAL, claude("sonnet")] },
      supervisor: { chain: [claude("sonnet"), CODEX] },
      builder: { chain: [claude("opus"), CODEX] },
      verifier: { chain: [CODEX, claude("sonnet")] },
      repair: { chain: [claude("opus"), CODEX] },
    },
  },
  max_quality: {
    name: "Max quality",
    roles: {
      orchestrator: { chain: [claude("opus"), CODEX] },
      supervisor: { chain: [claude("opus"), CODEX] },
      builder: { chain: [claude("opus"), CODEX] },
      verifier: { chain: [CODEX, claude("opus")] },
      repair: { chain: [claude("opus"), CODEX] },
    },
  },
  codex_only: {
    name: "Codex only",
    roles: {
      orchestrator: { chain: [CODEX] },
      supervisor: { chain: [CODEX] },
      builder: { chain: [CODEX] },
      verifier: { chain: [CODEX] },
      repair: { chain: [CODEX] },
    },
  },
  local_first: {
    name: "Local first",
    roles: {
      orchestrator: { chain: [LOCAL, CODEX] },
      supervisor: { chain: [CODEX_LOCAL, CODEX] },
      builder: { chain: [CODEX] },
      verifier: { chain: [CODEX], checksOnly: true },
      repair: { chain: [CODEX] },
    },
  },
};

/** The runtimes the owner's computers offer and the model ids each reports. */
export async function offeredModels(
  ctx: QueryCtx,
  ownerId: Id<"users">,
): Promise<Map<string, string[]>> {
  const workstations = await ctx.db
    .query("workstations")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(50);
  const offered = new Map<string, string[]>();
  for (const workstation of workstations) {
    if (workstation.status === "revoked" || workstation.revokedAt !== undefined) continue;
    const installations = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation", (q) => q.eq("workstationId", workstation._id))
      .take(32);
    for (const installation of installations) {
      if (installation.status !== "available" || !installation.capabilities.includes("start"))
        continue;
      const ids = offered.get(installation.runtime) ?? [];
      for (const model of installation.models ?? [])
        if (!ids.includes(model.id)) ids.push(model.id);
      offered.set(installation.runtime, ids);
    }
  }
  return offered;
}

export interface PresetProfile {
  role: PresetRole;
  runtime: string;
  model?: string;
  backups: { runtime: string; model?: string }[];
  checksOnly: boolean;
}

/**
 * The profiles a preset becomes for this owner: each chain keeps only agents some computer
 * offers (and the role may use), with model hints matched to reported model ids. A role
 * whose chain is empty is left out, so it uses the product's Default.
 */
export function presetProfiles(
  preset: WorkflowPreset,
  offered: Map<string, string[]>,
): PresetProfile[] {
  const result: PresetProfile[] = [];
  for (const [role, settings] of Object.entries(PRESETS[preset].roles) as [
    PresetRole,
    PresetRoleSettings,
  ][]) {
    const chain = settings.chain
      .filter((agent) => offered.has(agent.runtime) && runtimeAllowedFor(role, agent.runtime))
      .map((agent) => {
        const hint = agent.model?.toLowerCase();
        const model = hint
          ? offered.get(agent.runtime)?.find((id) => id.toLowerCase().includes(hint))
          : undefined;
        return { runtime: agent.runtime, ...(model ? { model } : {}) };
      })
      // The same agent twice adds nothing.
      .filter(
        (agent, index, all) =>
          all.findIndex(
            (other) => other.runtime === agent.runtime && other.model === agent.model,
          ) === index,
      );
    const [first, ...backups] = chain;
    if (!first) continue;
    result.push({
      role,
      ...first,
      backups: backups.slice(0, 2),
      checksOnly: role === "verifier" && settings.checksOnly === true,
    });
  }
  return result;
}
