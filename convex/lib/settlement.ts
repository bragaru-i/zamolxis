import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { refreshSession } from "./lifecycle";
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
    if (
      run.finalHeadSha !== snapshot.headSha ||
      (run.finalDirty !== undefined && run.finalDirty !== snapshot.dirty) ||
      (run.finalChangedFileCount !== undefined &&
        run.finalChangedFileCount !== snapshot.changedFileCount)
    )
      fail("COMMAND_CONFLICT");
    return;
  }
  const workspace = await load(ctx, "workspaces", run.workspaceId);
  if (workspace.ownerRunId !== run._id || !["completed", "failed", "stopped"].includes(run.status))
    fail("INVALID_STATE");
  const task = await load(ctx, "tasks", run.taskId);
  const session = await load(ctx, "workSessions", run.workSessionId);
  const now = Date.now();
  let unchangedRepair = false;
  if (run.role === "repair" && run.status === "completed" && task.candidateRunId) {
    const previous = await load(ctx, "agentRuns", task.candidateRunId);
    if (previous.finalHeadSha === snapshot.headSha) {
      unchangedRepair = true;
    }
  }
  const builder = (run.role ?? "builder") !== "verifier";
  const status =
    task.status === "cancelled"
      ? "cancelled"
      : run.status === "completed"
        ? "waiting"
        : run.role === "verifier"
          ? "waiting"
          : run.status === "stopped"
            ? "cancelled"
            : "failed";
  await ctx.db.patch("agentRuns", run._id, {
    completedAt: now,
    finalHeadSha: snapshot.headSha,
    finalDirty: snapshot.dirty,
    finalChangedFileCount: snapshot.changedFileCount,
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
  await ctx.db.patch("tasks", task._id, {
    status,
    updatedAt: now,
    ...(builder && run.status === "completed" && task.status !== "cancelled"
      ? {
          candidateRunId: run._id,
          phase: snapshot.dirty || unchangedRepair ? "needs_input" : "waiting_for_verification",
          ...(unchangedRepair ? { failureReason: "Repair produced no new candidate SHA" } : {}),
          ...(snapshot.dirty
            ? {
                failureReason:
                  "Builder left uncommitted changes; commit a candidate before verification",
              }
            : {}),
          verifierWorkspaceId: undefined,
          verificationRunId: undefined,
          trustDecisionId: undefined,
        }
      : {}),
    ...(status === "failed"
      ? { phase: "failed", failureReason: "Implementation runtime failed" }
      : {}),
  });
  await ctx.db.patch("workSessions", session._id, {
    activeRunCount: Math.max(0, session.activeRunCount - 1),
  });
  await refreshDependents(ctx, task._id);
  await refreshSession(ctx, session._id);
}
