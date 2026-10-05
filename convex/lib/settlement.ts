import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail, load } from "./access";

export async function refreshDependents(ctx: MutationCtx, taskId: Id<"tasks">) {
  const edges = await ctx.db
    .query("taskDependencies")
    .withIndex("by_dependency", (q) => q.eq("dependsOnTaskId", taskId))
    .take(101);
  if (edges.length > 100) fail("LIMIT_EXCEEDED");
  for (const edge of edges) {
    const task = await load(ctx, "tasks", edge.taskId);
    if (task.status !== "blocked") continue;
    const dependencies = await ctx.db
      .query("taskDependencies")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(33);
    if (dependencies.length > 32) fail("LIMIT_EXCEEDED");
    let ready = true;
    for (const dependency of dependencies) {
      const prerequisite = await load(ctx, "tasks", dependency.dependsOnTaskId);
      if (
        dependency.type === "success"
          ? prerequisite.status !== "completed"
          : !["completed", "failed", "cancelled"].includes(prerequisite.status)
      )
        ready = false;
    }
    if (ready) await ctx.db.patch("tasks", task._id, { status: "ready", updatedAt: Date.now() });
  }
}
export async function settleRun(
  ctx: MutationCtx,
  runId: Id<"agentRuns">,
  snapshot: { headSha: string; dirty: boolean; changedFileCount: number; summary?: string },
) {
  const run = await load(ctx, "agentRuns", runId);
  if (run.completedAt !== undefined) {
    if (run.finalHeadSha !== snapshot.headSha) fail("COMMAND_CONFLICT");
    return;
  }
  const workspace = await load(ctx, "workspaces", run.workspaceId);
  if (workspace.ownerRunId !== run._id || !["completed", "failed", "stopped"].includes(run.status))
    fail("INVALID_STATE");
  const task = await load(ctx, "tasks", run.taskId);
  const session = await load(ctx, "workSessions", run.workSessionId);
  const now = Date.now();
  const status =
    task.status === "cancelled"
      ? "cancelled"
      : run.status === "completed"
        ? "completed"
        : run.status === "stopped"
          ? "cancelled"
          : "failed";
  await ctx.db.patch("agentRuns", run._id, {
    completedAt: now,
    finalHeadSha: snapshot.headSha,
    ...(snapshot.summary ? { resultSummary: snapshot.summary } : {}),
  });
  await ctx.db.patch("workspaces", workspace._id, {
    currentHeadSha: snapshot.headSha,
    dirty: snapshot.dirty,
    changedFileCount: snapshot.changedFileCount,
    status: snapshot.dirty ? "dirty" : "ready",
    ownerRunId: undefined,
    updatedAt: now,
  });
  const isBuilderCandidate = (run.role ?? "builder") === "builder" && status === "completed";
  await ctx.db.patch("tasks", task._id, {
    status: isBuilderCandidate ? "waiting" : status,
    ...(isBuilderCandidate ? { candidateRunId: run._id } : { completedAt: now }),
    updatedAt: now,
  });
  if (!isBuilderCandidate) await refreshDependents(ctx, task._id);
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
    .take(101);
  if (tasks.length > 100) fail("LIMIT_EXCEEDED");
  const allTerminal = tasks.every((item) =>
    ["completed", "failed", "cancelled"].includes(item.status),
  );
  const activeRunCount = Math.max(0, session.activeRunCount - 1);
  // A completed implementation is a candidate, never proof of completion.
  // Keep successful Sessions open until independent verification/integration
  // has explicitly settled; task counters alone cannot authorize auto-close.
  const successfulCandidate = isBuilderCandidate || tasks.some((item) => item.status === "waiting" && item.candidateRunId);
  const canClose = allTerminal && activeRunCount === 0 && !successfulCandidate;
  const sessionStatus =
    session.status === "cancelled"
      ? "cancelled"
      : canClose
        ? tasks.some((item) => item.status === "failed")
          ? "failed"
          : "completed"
        : allTerminal && activeRunCount === 0
          ? "waiting"
          : session.status;
  await ctx.db.patch("workSessions", session._id, {
    status: sessionStatus,
    activeRunCount,
    completedTaskCount: session.completedTaskCount + (status === "completed" ? 1 : 0),
    lastActivityAt: now,
    updatedAt: now,
    ...(canClose ? { completedAt: now } : {}),
  });
}
