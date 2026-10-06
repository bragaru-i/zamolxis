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
export async function resolveAgentProfile(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
  role: AgentRole,
  fallback = "codex",
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
  return { runtime: profile?.runtime ?? fallback, profile };
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
