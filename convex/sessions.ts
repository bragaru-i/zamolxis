import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { fail, load, ownSession, requireUser } from "./lib/access";
import { stopRun } from "./lib/commands";
import { sessionStatus } from "./schema";
export const listMine = query({
  args: { status: v.optional(sessionStatus), paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      fail("INVALID_ARGUMENT");
    return args.status
      ? ctx.db
          .query("workSessions")
          .withIndex("by_owner_status_activity", (q) =>
            q.eq("ownerId", owner._id).eq("status", args.status!),
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : ctx.db
          .query("workSessions")
          .withIndex("by_owner_activity", (q) => q.eq("ownerId", owner._id))
          .order("desc")
          .paginate(args.paginationOpts);
  },
});
export const get = query({
  args: { workSessionId: v.id("workSessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const session = await ownSession(ctx, args.workSessionId);
    // The computer the Session's work runs on, named for the owner.
    const device = session.workstationId
      ? await ctx.db.get("workstations", session.workstationId)
      : null;
    const workflow = session.workflowId ? await ctx.db.get(session.workflowId) : null;
    return {
      ...session,
      ...(device ? { workstationName: device.name } : {}),
      ...(workflow ? { workflowName: workflow.name } : {}),
    };
  },
});
export const create = mutation({
  args: {
    title: v.string(),
    goal: v.string(),
    repositoryIds: v.optional(v.array(v.id("repositories"))),
  },
  returns: v.id("workSessions"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const ids = [...new Set(args.repositoryIds ?? [])];
    if (ids.length > 32) fail("INVALID_ARGUMENT");
    let productId: Id<"products"> | undefined;
    for (const id of ids) {
      const repository = await load(ctx, "repositories", id);
      if (repository.ownerId !== owner._id) fail("FORBIDDEN");
      if (productId !== undefined && repository.productId !== productId) fail("PRODUCT_MISMATCH");
      productId = repository.productId;
    }
    if (productId && ids.length > 1) {
      for (const id of ids)
        if ((await load(ctx, "repositories", id)).productId !== productId) fail("PRODUCT_MISMATCH");
    }
    const now = Date.now();
    const id = await ctx.db.insert("workSessions", {
      ownerId: owner._id,
      ...(productId ? { productId } : {}),
      title: args.title,
      goal: args.goal,
      status: "planning",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 0,
      needsInputCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    for (const repositoryId of ids)
      await ctx.db.insert("sessionRepositories", {
        workSessionId: id,
        repositoryId,
        role: "primary",
      });
    return id;
  },
});
// The owner is done with an idle Session: nothing is running, so nothing is interrupted.
// Unfinished Tasks are cancelled; a later message reopens the Session as usual.
export const close = mutation({
  args: { workSessionId: v.id("workSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ownSession(ctx, args.workSessionId);
    if (["completed", "cancelled"].includes(session.status)) return null;
    if (["planning", "running"].includes(session.status) || session.activeRunCount > 0)
      fail("INVALID_STATE");
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(101);
    if (tasks.length > 100) fail("LIMIT_EXCEEDED");
    const now = Date.now();
    for (const task of tasks)
      if (!["completed", "failed", "cancelled"].includes(task.status))
        await ctx.db.patch("tasks", task._id, { status: "cancelled", updatedAt: now });
    await ctx.db.patch("workSessions", session._id, {
      status: "completed",
      needsInputCount: 0,
      completedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
export const cancel = mutation({
  args: { workSessionId: v.id("workSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ownSession(ctx, args.workSessionId);
    if (["completed", "failed"].includes(session.status)) fail("INVALID_STATE");
    if (session.status === "cancelled") return null;
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_session_activity", (q) => q.eq("workSessionId", session._id))
      .take(101);
    if (runs.length > 100) fail("RECONCILIATION_REQUIRED");
    for (const run of runs) await stopRun(ctx, run._id);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(101);
    if (tasks.length > 100) fail("LIMIT_EXCEEDED");
    for (const task of tasks)
      if (!["completed", "failed", "cancelled"].includes(task.status))
        await ctx.db.patch("tasks", task._id, { status: "cancelled", updatedAt: Date.now() });
    await ctx.db.patch("workSessions", session._id, { status: "cancelled", updatedAt: Date.now() });
    return null;
  },
});
