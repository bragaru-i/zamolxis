import { evaluateTrust } from "@zamolxis/application";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail, load } from "./access";
import { enqueue } from "./commands";
import { allocateWorkspace } from "../workspaces";
export const MAX_REPAIR_ATTEMPTS = 2;
export async function refreshSession(ctx: MutationCtx, sessionId: Id<"workSessions">) {
  const session = await load(ctx, "workSessions", sessionId);
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_session", (q) => q.eq("workSessionId", sessionId))
    .take(101);
  if (tasks.length > 100) fail("LIMIT_EXCEEDED");
  const complete =
    tasks.length > 0 &&
    tasks.every((task) => task.status === "completed" && task.phase === "completed");
  const needsInput = tasks.some((task) => task.phase === "needs_input");
  const failed = tasks.some((task) => task.status === "failed");
  const active = session.activeRunCount;
  await ctx.db.patch("workSessions", sessionId, {
    status:
      session.status === "cancelled"
        ? "cancelled"
        : active
          ? "running"
          : needsInput
            ? "needs_input"
            : failed
              ? "failed"
              : complete
                ? "completed"
                : "waiting",
    completedTaskCount: tasks.filter((task) => task.status === "completed").length,
    needsInputCount: tasks.filter((task) => task.phase === "needs_input").length,
    ...(complete && !active ? { completedAt: Date.now() } : {}),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
  });
}
export async function decideVerification(ctx: MutationCtx, verifierId: Id<"agentRuns">) {
  const verifier = await load(ctx, "agentRuns", verifierId);
  const task = await load(ctx, "tasks", verifier.taskId);
  const verification = await ctx.db
    .query("verificationRuns")
    .withIndex("by_verifier", (q) => q.eq("verifierRunId", verifierId))
    .unique();
  if (verification?.trustDecisionId) return;
  if (
    !verification ||
    task.verificationRunId !== verification._id ||
    task.candidateRunId !== verification.candidateRunId
  )
    fail("INVALID_VERIFICATION_PROVENANCE");
  if (task.trustDecisionId) return;
  const candidate = await load(ctx, "agentRuns", verification.candidateRunId);
  const candidateWorkspace = await load(ctx, "workspaces", candidate.workspaceId);
  const workspace = await load(ctx, "workspaces", verifier.workspaceId);
  const records = await ctx.db
    .query("evidence")
    .withIndex("by_verification", (q) => q.eq("verificationRunId", verification._id))
    .take(33);
  if (records.length > 32) fail("LIMIT_EXCEEDED");
  const decision = evaluateTrust(
    candidate._id,
    verification.subjectSha,
    records.map((record) => ({ ...record, origin: "independent-verifier" as const })),
    task.requiredModalities ?? ["static", "behavioral"],
  );
  if (
    !["builder", "repair"].includes(candidate.role ?? "builder") ||
    candidate.status !== "completed" ||
    candidate.completedAt === undefined ||
    candidate.workSessionId !== verifier.workSessionId ||
    candidate.workspaceId === verifier.workspaceId ||
    verifier.status !== "completed" ||
    !verifier.completedAt ||
    verifier.finalHeadSha !== verification.subjectSha ||
    workspace.dirty ||
    workspace.currentHeadSha !== verification.subjectSha ||
    candidate.finalHeadSha !== verification.subjectSha ||
    candidateWorkspace.dirty ||
    candidateWorkspace.currentHeadSha !== verification.subjectSha
  ) {
    decision.eligible = false;
    decision.reasons.push("Candidate or verifier snapshot is incomplete or changed");
  }
  const trustDecisionId = await ctx.db.insert("trustDecisions", {
    candidateRunId: candidate._id,
    subjectSha: verification.subjectSha,
    ...decision,
    createdAt: Date.now(),
  });
  await ctx.db.patch("verificationRuns", verification._id, { trustDecisionId });
  await ctx.db.patch("tasks", task._id, {
    trustDecisionId,
    lastTrustDecisionId: trustDecisionId,
    phase: decision.eligible ? "ready_for_integration" : "trust_failed",
    updatedAt: Date.now(),
  });
  if (task.status === "cancelled") return;
  if (decision.eligible) {
    const integrationWorkspaceId = await allocateWorkspace(ctx, {
      workSessionId: task.workSessionId,
      taskId: task._id,
      repositoryLocationId: candidateWorkspace.repositoryLocationId,
      baseRef: verification.subjectSha,
      kind: "integration",
      fresh: true,
    });
    await ctx.db.patch("tasks", task._id, { integrationWorkspaceId, phase: "integrating" });
    await enqueue(
      ctx,
      workspace.workstationId,
      "integration.prepare",
      "task",
      task._id,
      {
        taskId: task._id,
        workspaceId: integrationWorkspaceId,
        subjectSha: verification.subjectSha,
        trustDecisionId,
      },
      `integrate:${trustDecisionId}`,
    );
  } else if ((task.repairAttempts ?? 0) < MAX_REPAIR_ATTEMPTS) {
    const nextWorkspaceId = await allocateWorkspace(ctx, {
      workSessionId: task.workSessionId,
      taskId: task._id,
      repositoryLocationId: candidateWorkspace.repositoryLocationId,
      baseRef: verification.subjectSha,
      kind: "worktree",
      fresh: true,
    });
    const reasons = records
      .map((record) => `${record.modality}: ${record.result}: ${record.summary}`)
      .join("\n")
      .slice(0, 8000);
    await ctx.db.patch("tasks", task._id, {
      status: "ready",
      phase: "repairing",
      nextWorkspaceId,
      repairAttempts: (task.repairAttempts ?? 0) + 1,
      description: `${task.description.split("\n\nVerification failure:")[0]}\n\nVerification failure:\n${decision.reasons.join("; ")}\n${reasons}`,
      verifierWorkspaceId: undefined,
      verificationRunId: undefined,
      trustDecisionId: undefined,
    });
  } else {
    await ctx.db.patch("tasks", task._id, {
      status: "waiting",
      phase: "needs_input",
      failureReason: `Repair exhausted after ${MAX_REPAIR_ATTEMPTS} attempts: ${decision.reasons.join("; ")}`,
    });
  }
  await refreshSession(ctx, task.workSessionId);
}
