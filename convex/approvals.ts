import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { bounded, fail, load, ownSession, requireUser } from "./lib/access";
export const request = internalMutation({
  args: {
    workSessionId: v.id("workSessions"),
    runId: v.optional(v.id("agentRuns")),
    action: v.string(),
    risk: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    request: v.any(),
  },
  returns: v.id("approvals"),
  handler: async (ctx, args) => {
    const session = await load(ctx, "workSessions", args.workSessionId);
    if (JSON.stringify(args.request).length > 16384) fail("INVALID_ARGUMENT");
    if (args.runId) {
      const run = await load(ctx, "agentRuns", args.runId);
      if (run.workSessionId !== session._id) fail("FORBIDDEN");
    }
    return ctx.db.insert("approvals", {
      ...args,
      ownerId: session.ownerId,
      status: "pending",
      requestedAt: Date.now(),
    });
  },
});
export const listPending = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return ctx.db
      .query("approvals")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", user._id).eq("status", "pending"))
      .take(bounded(args.limit ?? 50));
  },
});
export const resolve = mutation({
  args: {
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const approval = await load(ctx, "approvals", args.approvalId);
    await ownSession(ctx, approval.workSessionId);
    const user = await requireUser(ctx);
    if (approval.ownerId !== user._id) fail("FORBIDDEN");
    if (approval.status === args.decision) return null;
    if (approval.status !== "pending") fail("INVALID_STATE");
    // Approval records permission only. It does not change evidence, trust, or execute integration.
    await ctx.db.patch("approvals", approval._id, {
      status: args.decision,
      resolvedAt: Date.now(),
      resolvedBy: user._id,
    });
    return null;
  },
});
