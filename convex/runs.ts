import { assertCanQueueRun } from "@zamolxis/application";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { bounded, fail, load, ownRun, ownSession } from "./lib/access";
import { enqueue, stopRun } from "./lib/commands";
export async function queueRun(
  ctx: MutationCtx,
  input: {
    taskId: Id<"tasks">;
    workspaceId: Id<"workspaces">;
    runtime?: string;
    role?: "builder" | "verifier";
  },
) {
  const task = await load(ctx, "tasks", input.taskId);
  const session = await load(ctx, "workSessions", task.workSessionId);
  const role = input.role ?? "builder";
  const productProfiles = session.productId
    ? await ctx.db.query("agentProfiles").withIndex("by_product_role", (q) => q.eq("productId", session.productId).eq("role", role)).take(2)
    : [];
  if (productProfiles.length > 1) fail("AGENT_PROFILE_CONFLICT");
  const globalProfiles = productProfiles.length
    ? []
    : await ctx.db.query("agentProfiles").withIndex("by_owner_role", (q) => q.eq("ownerId", session.ownerId).eq("role", role)).take(10);
  const enabledGlobals = globalProfiles.filter((profile) => profile.productId === undefined && profile.enabled);
  if (enabledGlobals.length > 1) fail("AGENT_PROFILE_CONFLICT");
  const profile = productProfiles.find((candidate) => candidate.enabled) ?? enabledGlobals[0];
  const runtime = profile?.runtime ?? input.runtime ?? "codex";
  if (input.runtime && input.runtime !== runtime) fail("AGENT_PROFILE_RUNTIME_MISMATCH");
  const workspace = await load(ctx, "workspaces", input.workspaceId);
  if (workspace.taskId !== task._id || workspace.workSessionId !== task.workSessionId)
    fail("WORKSPACE_MISMATCH");
  const existing = await ctx.db
    .query("agentRuns")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(2);
  if (existing.length) {
    const run = existing[0]!;
    if (
      existing.length !== 1 ||
      run.taskId !== task._id ||
      run.runtime !== runtime ||
      run.role !== (input.role ?? "builder")
    )
      fail("COMMAND_CONFLICT");
    return run._id;
  }
  assertCanQueueRun(task.status, workspace.status, !!workspace.ownerRunId);
  if (["completed", "failed", "cancelled"].includes(session.status)) fail("INVALID_STATE");
  const device = await load(ctx, "workstations", workspace.workstationId);
  if (device.status !== "online") fail("WORKSTATION_OFFLINE");
  const installation = await ctx.db
    .query("runtimeInstallations")
    .withIndex("by_workstation_runtime", (q) =>
      q.eq("workstationId", device._id).eq("runtime", runtime),
    )
    .unique();
  if (
    !installation ||
    installation.status !== "available" ||
    !installation.capabilities.includes("start")
  )
    fail("RUNTIME_UNAVAILABLE");
  if (task.runtimePolicyMode === "forced" && task.runtimePolicyRuntime !== runtime)
    fail("RUNTIME_UNAVAILABLE");
  // Queued and uncertain runs reserve capacity too: restart cannot oversubscribe.
  const reservations = await ctx.db
    .query("agentRuns")
    .withIndex("by_workstation_status", (q) => q.eq("workstationId", device._id))
    .take(1001);
  if (reservations.length > 1000) fail("RECONCILIATION_REQUIRED");
  let occupied = 0;
  for (const run of reservations) {
    if ((run.role ?? "builder") !== role || run.completedAt !== undefined) continue;
    const reservedWorkspace = await load(ctx, "workspaces", run.workspaceId);
    if (reservedWorkspace.ownerRunId === run._id) occupied++;
  }
  if (occupied >= (role === "verifier" ? 1 : 3)) fail("NODE_CAPACITY_EXCEEDED");
  const now = Date.now();
  const runId = await ctx.db.insert("agentRuns", {
    workSessionId: session._id,
    taskId: task._id,
    workspaceId: workspace._id,
    workstationId: device._id,
    runtime,
    role,
    ...(profile ? { agentProfileId: profile._id, agentProfileRevision: profile.revision, modelRequested: profile.model, reasoningEffort: profile.reasoningEffort } : {}),
    runtimeVersion: installation.version,
    status: "queued",
    attempt: 1,
    lastActivityAt: now,
  });
  await ctx.db.patch("workspaces", workspace._id, {
    ownerRunId: runId,
    status: "in_use",
    updatedAt: now,
  });
  await ctx.db.patch("tasks", task._id, { status: "running", startedAt: now, updatedAt: now });
  await ctx.db.patch("workSessions", session._id, {
    status: "running",
    activeRunCount: session.activeRunCount + 1,
    lastActivityAt: now,
    updatedAt: now,
  });
  await enqueue(
    ctx,
    device._id,
    "runtime.start",
    "run",
    runId,
    {
      runId,
      taskId: task._id,
      workspaceId: workspace._id,
      runtime,
      role,
      ...(profile?.model ? { model: profile.model } : {}),
      ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      instruction: task.description,
    },
    `start:${runId}`,
  );
  return runId;
}
export const start = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workspaceId: v.id("workspaces"),
    runtime: v.optional(v.string()),
    role: v.optional(v.union(v.literal("builder"), v.literal("verifier"))),
  },
  returns: v.id("agentRuns"),
  handler: queueRun,
});
export const request = mutation({
  args: { taskId: v.id("tasks"), workspaceId: v.id("workspaces"), runtime: v.string() },
  returns: v.id("agentRuns"),
  handler: async (ctx, args) => {
    const task = await load(ctx, "tasks", args.taskId);
    await ownSession(ctx, task.workSessionId);
    return queueRun(ctx, args);
  },
});
export const get = query({
  args: { runId: v.id("agentRuns") },
  returns: v.any(),
  handler: (ctx, args) => ownRun(ctx, args.runId),
});
export const listBySession = query({
  args: { workSessionId: v.id("workSessions"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    return ctx.db
      .query("agentRuns")
      .withIndex("by_session_activity", (q) => q.eq("workSessionId", args.workSessionId))
      .order("desc")
      .take(bounded(args.limit ?? 100));
  },
});
export const sendMessage = mutation({
  args: { runId: v.id("agentRuns"), message: v.string(), idempotencyKey: v.string() },
  returns: v.id("commands"),
  handler: async (ctx, args) => {
    const run = await ownRun(ctx, args.runId);
    if (!["running", "waiting", "needs_approval"].includes(run.status)) fail("INVALID_STATE");
    return enqueue(
      ctx,
      run.workstationId,
      "runtime.send",
      "run",
      run._id,
      { runId: run._id, message: args.message },
      `send:${run._id}:${args.idempotencyKey}`,
    );
  },
});
export const stop = mutation({
  args: { runId: v.id("agentRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ownRun(ctx, args.runId);
    await stopRun(ctx, args.runId);
    return null;
  },
});
