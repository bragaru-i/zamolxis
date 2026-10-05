import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { bounded, fail, load, ownSession } from "./lib/access";
import { enqueue } from "./lib/commands";
export async function allocateWorkspace(
  ctx: MutationCtx,
  input: {
    workSessionId: Id<"workSessions">;
    taskId?: Id<"tasks">;
    repositoryLocationId: Id<"repositoryLocations">;
    baseRef: string;
    kind: "worktree" | "integration";
    fresh?: boolean;
    mergeShas?: string[];
  },
) {
  const session = await load(ctx, "workSessions", input.workSessionId);
  if (["completed", "failed", "cancelled"].includes(session.status)) fail("INVALID_STATE");
  const location = await load(ctx, "repositoryLocations", input.repositoryLocationId);
  const repository = await load(ctx, "repositories", location.repositoryId);
  const device = await load(ctx, "workstations", location.workstationId);
  if (repository.ownerId !== session.ownerId || device.ownerId !== session.ownerId)
    fail("FORBIDDEN");
  if (device.status !== "online" || location.status !== "available") fail("WORKSTATION_OFFLINE");
  const relationship = await ctx.db
    .query("sessionRepositories")
    .withIndex("by_session_repository", (q) =>
      q.eq("workSessionId", session._id).eq("repositoryId", repository._id),
    )
    .unique();
  if (!relationship) fail("FORBIDDEN");
  if (input.taskId) {
    const task = await load(ctx, "tasks", input.taskId);
    if (task.workSessionId !== session._id) fail("FORBIDDEN");
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(2);
    if (existing.length && !input.fresh) {
      const workspace = existing[0]!;
      if (
        existing.length !== 1 ||
        workspace.repositoryLocationId !== location._id ||
        workspace.baseRef !== input.baseRef ||
        workspace.kind !== input.kind
      )
        fail("COMMAND_CONFLICT");
      return workspace._id;
    }
    if (!input.fresh && task.status !== "ready") fail("INVALID_STATE");
  }
  const now = Date.now();
  const workspaceId = await ctx.db.insert("workspaces", {
    workSessionId: session._id,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    repositoryId: repository._id,
    repositoryLocationId: location._id,
    workstationId: device._id,
    kind: input.kind,
    status: "requested",
    baseRef: input.baseRef,
    dirty: false,
    changedFileCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  await enqueue(
    ctx,
    device._id,
    "workspace.provision",
    "workspace",
    workspaceId,
    {
      workspaceId,
      repositoryLocationId: location._id,
      repositoryId: repository._id,
      baseRef: input.baseRef,
      kind: input.kind,
      ...(input.mergeShas?.length ? { mergeShas: input.mergeShas } : {}),
    },
    `provision:${workspaceId}`,
  );
  return workspaceId;
}
const allocationArgs = {
  workSessionId: v.id("workSessions"),
  taskId: v.optional(v.id("tasks")),
  repositoryLocationId: v.id("repositoryLocations"),
  baseRef: v.string(),
  kind: v.union(v.literal("worktree"), v.literal("integration")),
};
export const allocate = internalMutation({
  args: allocationArgs,
  returns: v.id("workspaces"),
  handler: allocateWorkspace,
});
export const request = mutation({
  args: {
    taskId: v.id("tasks"),
    repositoryLocationId: v.id("repositoryLocations"),
    baseRef: v.string(),
  },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const task = await load(ctx, "tasks", args.taskId);
    await ownSession(ctx, task.workSessionId);
    return allocateWorkspace(ctx, { ...args, workSessionId: task.workSessionId, kind: "worktree" });
  },
});
export const listBySession = query({
  args: { workSessionId: v.id("workSessions"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    return ctx.db
      .query("workspaces")
      .withIndex("by_session", (q) => q.eq("workSessionId", args.workSessionId))
      .take(bounded(args.limit ?? 100));
  },
});
export const requestCleanup = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    artifactsCaptured: v.boolean(),
    integrationPending: v.boolean(),
    retentionAllows: v.boolean(),
  },
  returns: v.id("commands"),
  handler: async (ctx, args) => {
    const workspace = await load(ctx, "workspaces", args.workspaceId);
    if (
      workspace.ownerRunId ||
      workspace.dirty ||
      !args.artifactsCaptured ||
      args.integrationPending ||
      !args.retentionAllows
    )
      fail("INVALID_STATE");
    return enqueue(
      ctx,
      workspace.workstationId,
      "workspace.cleanup",
      "workspace",
      workspace._id,
      { workspaceId: workspace._id },
      `cleanup:${workspace._id}`,
    );
  },
});
