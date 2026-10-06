import { assertCanQueueRun } from "@zamolxis/application";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { bounded, fail, load, ownRun, ownSession, requireUser } from "./lib/access";
import { ownerInstructionsSection, resolveAgentProfile } from "./lib/agentProfiles";
import { enqueue, stopRun } from "./lib/commands";
export async function queueRun(
  ctx: MutationCtx,
  input: {
    taskId: Id<"tasks">;
    workspaceId: Id<"workspaces">;
    runtime?: string;
    role?: "builder" | "verifier" | "repair";
  },
) {
  const task = await load(ctx, "tasks", input.taskId);
  const session = await load(ctx, "workSessions", task.workSessionId);
  const role = input.role ?? "builder";
  const workspace = await load(ctx, "workspaces", input.workspaceId);
  if (workspace.kind === "canonical") fail("CANONICAL_WORKSPACE_FORBIDDEN");
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
      (input.runtime !== undefined && run.runtime !== input.runtime) ||
      run.role !== (input.role ?? "builder")
    )
      fail("COMMAND_CONFLICT");
    return run._id;
  }
  const { profile, runtime } = await resolveAgentProfile(
    ctx,
    session.ownerId,
    session.productId,
    role,
    input.runtime,
  );
  if (input.runtime && input.runtime !== runtime) fail("AGENT_PROFILE_RUNTIME_MISMATCH");
  assertCanQueueRun(
    role === "verifier" && task.status === "waiting" ? "ready" : task.status,
    workspace.status,
    !!workspace.ownerRunId,
  );
  if (role === "verifier" && (!task.candidateRunId || task.verifierWorkspaceId !== workspace._id))
    fail("INVALID_VERIFICATION_PROVENANCE");
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
  if (
    role !== "verifier" &&
    !profile &&
    task.runtimePolicyMode === "forced" &&
    task.runtimePolicyRuntime !== runtime
  )
    fail("RUNTIME_UNAVAILABLE");
  // Queued and uncertain runs reserve capacity too: restart cannot oversubscribe.
  const reservations = await ctx.db
    .query("agentRuns")
    .withIndex("by_workstation_status", (q) => q.eq("workstationId", device._id))
    .take(1001);
  if (reservations.length > 1000) fail("RECONCILIATION_REQUIRED");
  let occupied = 0;
  for (const run of reservations) {
    if ((run.role === "verifier") !== (role === "verifier") || run.completedAt !== undefined)
      continue;
    const reservedWorkspace = await load(ctx, "workspaces", run.workspaceId);
    if (reservedWorkspace.ownerRunId === run._id) occupied++;
  }
  if (occupied >= (role === "verifier" ? 1 : 3)) fail("NODE_CAPACITY_EXCEEDED");
  if (profile?.maxConcurrency !== undefined) {
    const profileRuns = await ctx.db
      .query("agentRuns")
      .withIndex("by_profile", (q) => q.eq("agentProfileId", profile._id))
      .take(1001);
    if (profileRuns.length > 1000) fail("RECONCILIATION_REQUIRED");
    if (profileRuns.filter((run) => run.completedAt === undefined).length >= profile.maxConcurrency)
      fail("AGENT_PROFILE_CAPACITY_EXCEEDED");
  }
  const now = Date.now();
  const runId = await ctx.db.insert("agentRuns", {
    workSessionId: session._id,
    taskId: task._id,
    workspaceId: workspace._id,
    workstationId: device._id,
    runtime,
    role,
    ...(task.candidateRunId && role !== "builder" ? { parentRunId: task.candidateRunId } : {}),
    ...(workspace.currentHeadSha ? { initialHeadSha: workspace.currentHeadSha } : {}),
    ...(profile
      ? {
          agentProfileId: profile._id,
          agentProfileRevision: profile.revision,
          ...(profile.instructionsDigest ? { instructionsDigest: profile.instructionsDigest } : {}),
          ...(profile.model ? { modelRequested: profile.model } : {}),
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
        }
      : {}),
    ...(installation.version ? { runtimeVersion: installation.version } : {}),
    status: "queued",
    attempt: (task.repairAttempts ?? 0) + 1,
    lastActivityAt: now,
  });
  await ctx.db.patch("workspaces", workspace._id, {
    ownerRunId: runId,
    status: "in_use",
    updatedAt: now,
  });
  await ctx.db.patch("tasks", task._id, {
    status: role === "verifier" ? "waiting" : "running",
    phase: role === "verifier" ? "verifying" : role === "repair" ? "repairing" : "building",
    startedAt: now,
    updatedAt: now,
  });
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
      instruction:
        (role === "verifier"
          ? `Independently review exact SHA ${workspace.baseSha}. Do not modify files or Git state. Acceptance: ${task.description}. Provide a concise review; deterministic Node checks establish trust.`
          : `${task.description}
Leave all intended implementation edits in your assigned worktree. Zamolxis captures the candidate commit. Do not publish, merge, or modify other checkouts.`) +
        // Owner text is appended last and labelled; it cannot change trust or approval.
        ownerInstructionsSection(profile?.instructions),
      ...(role === "verifier"
        ? {
            verificationScripts: task.verificationScripts ?? [],
            requiredModalities: task.requiredModalities ?? ["static", "behavioral"],
          }
        : {}),
    },
    `start:${runId}`,
  );
  if (role === "verifier") {
    const candidate = await load(ctx, "agentRuns", task.candidateRunId!);
    if (
      !["builder", "repair"].includes(candidate.role ?? "builder") ||
      candidate.status !== "completed" ||
      candidate.completedAt === undefined ||
      candidate.workSessionId !== session._id ||
      !candidate.finalHeadSha ||
      candidate.finalHeadSha !== workspace.baseSha ||
      candidate.workspaceId === workspace._id
    )
      fail("INVALID_VERIFICATION_PROVENANCE");
    const verificationId = await ctx.db.insert("verificationRuns", {
      candidateRunId: candidate._id,
      verifierRunId: runId,
      subjectSha: candidate.finalHeadSha,
      createdAt: now,
    });
    await ctx.db.patch("tasks", task._id, { verificationRunId: verificationId });
  }
  return runId;
}
export const start = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workspaceId: v.id("workspaces"),
    runtime: v.optional(v.string()),
    role: v.optional(v.union(v.literal("builder"), v.literal("verifier"), v.literal("repair"))),
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
    if (
      !args.message.trim() ||
      args.message.length > 16000 ||
      !args.idempotencyKey ||
      args.idempotencyKey.length > 128
    )
      fail("INVALID_ARGUMENT");
    // Only a Node that advertises working steering for this runtime receives messages.
    const installation = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation_runtime", (q) =>
        q.eq("workstationId", run.workstationId).eq("runtime", run.runtime),
      )
      .unique();
    if (installation?.status !== "available" || !installation.capabilities.includes("message"))
      fail("RUNTIME_MESSAGE_UNSUPPORTED");
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
const ACTIVE_RUN = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
]);
const IN_FLIGHT_PLAN = new Set(["pending", "claimed", "acknowledged"]);
const ACTIVE_SESSIONS = 10;
const RUNS_PER_SESSION = 20;
const TEXTS_PER_SESSION = 5;
/**
 * Every agent working for the owner right now, across Sessions: active Builder, Verifier and
 * Repair runs plus Supervisor turns still deciding, each with its model and usage so far.
 * Bounded to the most recently active Sessions that are running or planning.
 */
export const listActive = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const agents = [];
    for (const status of ["running", "planning"] as const) {
      const sessions = await ctx.db
        .query("workSessions")
        .withIndex("by_owner_status_activity", (q) =>
          q.eq("ownerId", owner._id).eq("status", status),
        )
        .order("desc")
        .take(ACTIVE_SESSIONS);
      for (const session of sessions) {
        const runs = await ctx.db
          .query("agentRuns")
          .withIndex("by_session_activity", (q) => q.eq("workSessionId", session._id))
          .order("desc")
          .take(RUNS_PER_SESSION);
        for (const run of runs) {
          if (!ACTIVE_RUN.has(run.status)) continue;
          const task = await ctx.db.get("tasks", run.taskId);
          agents.push({
            kind: "run",
            _id: run._id,
            workSessionId: session._id,
            sessionTitle: session.title,
            ...(task ? { taskTitle: task.title } : {}),
            role: run.role ?? "builder",
            runtime: run.runtime,
            status: run.status,
            ...(run.modelRequested !== undefined ? { modelRequested: run.modelRequested } : {}),
            ...(run.modelActual !== undefined ? { modelActual: run.modelActual } : {}),
            ...(run.totalTokens !== undefined ? { totalTokens: run.totalTokens } : {}),
            ...(run.estimatedCostUsd !== undefined ? { costUsd: run.estimatedCostUsd } : {}),
            ...(run.activityLabel !== undefined ? { activityLabel: run.activityLabel } : {}),
            startedAt: run.startedAt ?? run._creationTime,
            lastActivityAt: run.lastActivityAt,
          });
        }
        if (status !== "planning") continue;
        const texts = await ctx.db
          .query("textCommands")
          .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
          .order("desc")
          .take(TEXTS_PER_SESSION);
        for (const text of texts) {
          if (text.stoppedAt !== undefined || text.planDigest !== undefined) continue;
          const plan = await ctx.db
            .query("commands")
            .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `plan:${text._id}`))
            .unique();
          if (!plan || !IN_FLIGHT_PLAN.has(plan.status)) continue;
          agents.push({
            kind: "supervisor",
            _id: text._id,
            workSessionId: session._id,
            sessionTitle: session.title,
            role: "supervisor",
            status: text.stopRequestedAt !== undefined ? "stopping" : "running",
            ...(text.modelActual !== undefined ? { modelActual: text.modelActual } : {}),
            ...(text.totalTokens !== undefined ? { totalTokens: text.totalTokens } : {}),
            ...(text.supervisorActivity !== undefined
              ? { activityLabel: text.supervisorActivity }
              : {}),
            startedAt: text.supervisorStartedAt ?? text._creationTime,
            lastActivityAt: text.supervisorProgressAt ?? text._creationTime,
          });
        }
      }
    }
    return agents.sort((a, b) => a.startedAt - b.startedAt);
  },
});
