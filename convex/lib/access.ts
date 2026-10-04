import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
export function fail(code: string, message = code): never {
  throw new ConvexError({ code, message });
}
export function bounded(limit: number, max = 100): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
    fail("INVALID_ARGUMENT", `Limit must be 1..${max}`);
  return limit;
}
export async function load<T extends TableNames>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  const document = await ctx.db.get(table, id);
  if (!document) fail("NOT_FOUND");
  return document;
}
export async function requireUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("FORBIDDEN");
  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_subject", (q) => q.eq("authSubject", identity.tokenIdentifier))
    .unique();
  if (!user) fail("FORBIDDEN", "User profile is required");
  return user;
}
export async function requireNode(ctx: QueryCtx, workstationId: Id<"workstations">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("FORBIDDEN");
  const workstation = await load(ctx, "workstations", workstationId);
  const owner = await load(ctx, "users", workstation.ownerId);
  if (
    workstation.status === "revoked" ||
    workstation.nodeAuthSubject !== identity.tokenIdentifier ||
    identity.ownerSubject !== owner.authSubject
  )
    fail("FORBIDDEN");
  return workstation;
}
export async function ownSession(ctx: QueryCtx, id: Id<"workSessions">) {
  const user = await requireUser(ctx);
  const session = await load(ctx, "workSessions", id);
  if (session.ownerId !== user._id) fail("FORBIDDEN");
  return session;
}
export async function ownRun(ctx: QueryCtx, id: Id<"agentRuns">) {
  const run = await load(ctx, "agentRuns", id);
  await ownSession(ctx, run.workSessionId);
  return run;
}
export async function nodeRun(
  ctx: QueryCtx,
  workstationId: Id<"workstations">,
  runId: Id<"agentRuns">,
) {
  await requireNode(ctx, workstationId);
  const run = await load(ctx, "agentRuns", runId);
  if (run.workstationId !== workstationId) fail("FORBIDDEN");
  return run;
}
