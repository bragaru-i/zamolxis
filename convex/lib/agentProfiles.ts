import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "./access";
export type AgentRole = "supervisor" | "builder" | "verifier" | "repair" | "integration";
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
