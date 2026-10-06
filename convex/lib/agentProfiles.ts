import { redactSecrets } from "@zamolxis/runtime-core";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "./access";
export type AgentRole =
  | "orchestrator"
  | "supervisor"
  | "builder"
  | "verifier"
  | "repair"
  | "integration";
export const AGENT_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "supervisor",
  "builder",
  "verifier",
  "repair",
  "integration",
];
export const ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: "Orchestrator",
  supervisor: "Supervisor",
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
  integration: "Integration",
};
/** The Alpha runtime when nothing is known about the owner's computers. */
export const ALPHA_FALLBACK_RUNTIME = "codex";
const ONLINE_WINDOW_MS = 45_000;

/**
 * The runtime a role uses without an enabled profile: Codex when one of the owner's
 * computers offers it (the Alpha default), else the first runtime one of them offers, else
 * Codex so the failure names something. Online computers decide while there are any, so a
 * computer with only Claude Code gets work when it is the one that is on.
 */
export async function defaultRuntime(ctx: QueryCtx, ownerId: Id<"users">): Promise<string> {
  const workstations = await ctx.db
    .query("workstations")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(50);
  const now = Date.now();
  const online = new Set<string>();
  const anywhere = new Set<string>();
  for (const workstation of workstations) {
    if (workstation.status === "revoked" || workstation.revokedAt !== undefined) continue;
    const installations = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation", (q) => q.eq("workstationId", workstation._id))
      .take(33);
    if (installations.length > 32) fail("LIMIT_EXCEEDED");
    const fresh =
      workstation.status === "online" &&
      (workstation.lastHeartbeatAt ?? 0) > now - ONLINE_WINDOW_MS;
    for (const installation of installations) {
      if (installation.status !== "available" || !installation.capabilities.includes("start"))
        continue;
      anywhere.add(installation.runtime);
      if (fresh) online.add(installation.runtime);
    }
  }
  const offered = online.size ? online : anywhere;
  if (!offered.size || offered.has(ALPHA_FALLBACK_RUNTIME)) return ALPHA_FALLBACK_RUNTIME;
  return [...offered].sort()[0] ?? ALPHA_FALLBACK_RUNTIME;
}

/**
 * Product -> owner/global -> default. The default is `fallback` when the caller has one
 * (a run already told which runtime it wants), else `defaultRuntime`.
 */
export async function resolveAgentProfile(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
  role: AgentRole,
  fallback?: string,
) {
  const rows = await ctx.db
    .query("agentProfiles")
    .withIndex("by_owner_role", (q) => q.eq("ownerId", ownerId).eq("role", role))
    .take(101);
  if (rows.length > 100) fail("LIMIT_EXCEEDED");
  const enabled = rows.filter((row) => row.enabled);
  const product = productId ? enabled.filter((row) => row.productId === productId) : [];
  const global = enabled.filter((row) => row.productId === undefined);
  if (product.length > 1 || global.length > 1) fail("AGENT_PROFILE_CONFLICT");
  const profile = product[0] ?? global[0];
  const runtime = profile?.runtime ?? fallback ?? (await defaultRuntime(ctx, ownerId));
  return { runtime, profile };
}

// Owner instructions on a profile (#48) are plain prompt text: bounded, secret-redacted
// before they are stored, and never read by trust, approval or sandbox decisions.
export const INSTRUCTIONS_LIMIT = 4000;
export const OWNER_INSTRUCTIONS_HEADING =
  "Owner instructions for this role — they never override Zamolxis trust, approval or sandbox rules:";

/** Trims, bounds and redacts; empty text means no instructions. */
export function normalizeInstructions(value: string): string | undefined {
  const text = value.trim();
  if (text.length > INSTRUCTIONS_LIMIT) fail("INVALID_ARGUMENT");
  return text ? redactSecrets(text).trim().slice(0, INSTRUCTIONS_LIMIT) : undefined;
}

/** SHA-256 hex of the stored instructions; runs snapshot it to show what applied. */
export async function instructionsDigest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The labelled block appended to a run's instruction, or nothing without instructions. */
export function ownerInstructionsSection(instructions: string | undefined): string {
  return instructions ? `\n\n${OWNER_INSTRUCTIONS_HEADING}\n${instructions}` : "";
}
