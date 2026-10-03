import { assertCanCancelTask } from "@zamolxis/application";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { bounded, fail, load, ownSession } from "./lib/access";
import { refreshDependents } from "./lib/settlement";
import { stopRun } from "./lib/commands";
export const listBySession = query({
  args: { workSessionId: v.id("workSessions"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    return ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", args.workSessionId))
      .take(bounded(args.limit ?? 100));
  },
});
export const create = mutation({
  args: {
    workSessionId: v.id("workSessions"),
    title: v.string(),
    description: v.string(),
    kind: v.string(),
    priority: v.number(),
    runtimePolicy: v.object({
      mode: v.union(v.literal("auto"), v.literal("preferred"), v.literal("forced")),
      runtime: v.optional(v.string()),
    }),
    dependencies: v.optional(
      v.array(
        v.object({
          taskId: v.id("tasks"),
          type: v.union(v.literal("completion"), v.literal("success")),
        }),
      ),
    ),
  },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const session = await ownSession(ctx, args.workSessionId);
    if (["completed", "failed", "cancelled"].includes(session.status)) fail("INVALID_STATE");
    const existing = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(100);
    if (existing.length >= 100) fail("LIMIT_EXCEEDED");
    const dependencies = args.dependencies ?? [];
    if (
      dependencies.length > 32 ||
      new Set(dependencies.map((item) => item.taskId)).size !== dependencies.length
    )
      fail("INVALID_ARGUMENT");
    let blocked = false;
    for (const dependency of dependencies) {
      const task = await load(ctx, "tasks", dependency.taskId);
      if (task.workSessionId !== session._id) fail("FORBIDDEN");
      if (
        dependency.type === "success"
          ? task.status !== "completed"
          : !["completed", "failed", "cancelled"].includes(task.status)
      )
        blocked = true;
    }
    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      workSessionId: session._id,
      title: args.title,
      description: args.description,
      kind: args.kind,
      priority: args.priority,
      status: blocked ? "blocked" : "ready",
      runtimePolicyMode: args.runtimePolicy.mode,
      ...(args.runtimePolicy.runtime ? { runtimePolicyRuntime: args.runtimePolicy.runtime } : {}),
      createdAt: now,
      updatedAt: now,
    });
    // Edges point only from a newly inserted task to existing tasks, so insertion cannot create a cycle.
    for (const dependency of dependencies)
      await ctx.db.insert("taskDependencies", {
        workSessionId: session._id,
        taskId: id,
        dependsOnTaskId: dependency.taskId,
        type: dependency.type,
      });
    await ctx.db.patch("workSessions", session._id, {
      totalTaskCount: session.totalTaskCount + 1,
      updatedAt: now,
      lastActivityAt: now,
    });
    return id;
  },
});
export const cancel = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await load(ctx, "tasks", args.taskId);
    await ownSession(ctx, task.workSessionId);
    if (task.status === "cancelled") return null;
    assertCanCancelTask(task.status);
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(101);
    if (runs.length > 100) fail("RECONCILIATION_REQUIRED");
    for (const run of runs) await stopRun(ctx, run._id);
    await ctx.db.patch("tasks", task._id, { status: "cancelled", updatedAt: Date.now() });
    await refreshDependents(ctx, task._id);
    return null;
  },
});
