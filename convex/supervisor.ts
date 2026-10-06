import { validatePlan } from "@zamolxis/application";
import { USAGE_COUNTERS } from "@zamolxis/runtime-core";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, load, ownSession, requireNode, requireUser } from "./lib/access";
import { resolveAgentProfile } from "./lib/agentProfiles";
import { enqueue } from "./lib/commands";
import { explicitlyRequestsWork } from "./lib/orchestration";
import { canonicalRepository } from "./lib/repositories";
import {
  SUPERVISOR_LOG_LIMITS,
  supervisorLogStep,
  validLogStep,
  writeLogSteps,
} from "./lib/supervisorLog";
import { queueRun } from "./runs";
import { allocateWorkspace } from "./workspaces";
export const products = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const rows = await ctx.db
      .query("products")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(100);
    return rows.filter((row) => !row.archivedAt);
  },
});
// The user's messages in a Session, with the planning outcome for each.
export const messages = query({
  args: { workSessionId: v.id("workSessions") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    const rows = await ctx.db
      .query("textCommands")
      .withIndex("by_session", (q) => q.eq("workSessionId", args.workSessionId))
      .take(100);
    return Promise.all(
      rows.map(async (row) => {
        const plan = await ctx.db
          .query("commands")
          .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `plan:${row._id}`))
          .unique();
        return {
          _id: row._id,
          text: row.text,
          createdAt: row._creationTime,
          productId: row.productId,
          repositoryId: row.repositoryId,
          planned: row.planDigest !== undefined,
          planTaskCount: row.planDigest ? (JSON.parse(row.planDigest) as unknown[]).length : 0,
          ...(row.decision === "propose" && row.planDigest
            ? {
                proposedTasks: (JSON.parse(row.planDigest) as ProposedTask[]).map(
                  ({ key, title, description }) => ({ key, title, description }),
                ),
              }
            : {}),
          planStatus: plan?.status ?? "pending",
          ...(plan?.error ? { planError: plan.error } : {}),
          ...(row.decision ? { decision: row.decision } : {}),
          ...(row.reply !== undefined ? { reply: row.reply } : {}),
          ...(row.modelActual !== undefined || row.totalTokens !== undefined
            ? {
                supervisor: {
                  ...(row.modelActual !== undefined ? { modelActual: row.modelActual } : {}),
                  ...(row.totalTokens !== undefined ? { totalTokens: row.totalTokens } : {}),
                },
              }
            : {}),
          ...(row.supervisorStartedAt !== undefined
            ? {
                progress: {
                  startedAt: row.supervisorStartedAt,
                  ...(row.supervisorActivity !== undefined
                    ? { activity: row.supervisorActivity }
                    : {}),
                },
              }
            : {}),
          ...(row.stoppedAt !== undefined ? { stopped: true } : {}),
          ...(row.stopRequestedAt !== undefined &&
          row.stoppedAt === undefined &&
          row.planDigest === undefined
            ? { stopping: true }
            : {}),
        };
      }),
    );
  },
});
const submitArgs = {
  productId: v.id("products"),
  repositoryId: v.id("repositories"),
  text: v.string(),
  idempotencyKey: v.string(),
  sessionId: v.optional(v.id("workSessions")),
};
export async function submitText(
  ctx: MutationCtx,
  args: {
    productId: Id<"products">;
    repositoryId: Id<"repositories">;
    text: string;
    idempotencyKey: string;
    sessionId?: Id<"workSessions">;
  },
) {
  const owner = await requireUser(ctx);
  if (
    !args.text.trim() ||
    args.text.length > 16000 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(args.idempotencyKey)
  )
    fail("INVALID_ARGUMENT");
  const repository = await canonicalRepository(ctx, args.repositoryId);
  const product = await load(ctx, "products", args.productId);
  if (
    repository.ownerId !== owner._id ||
    product.ownerId !== owner._id ||
    repository.productId !== product._id ||
    product.archivedAt
  )
    fail("PRODUCT_MISMATCH");
  const previous = await ctx.db
    .query("textCommands")
    .withIndex("by_owner_key", (q) =>
      q.eq("ownerId", owner._id).eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (previous) {
    if (
      previous.text !== args.text ||
      previous.repositoryId !== repository._id ||
      previous.productId !== product._id ||
      previous.requestedSessionId !== args.sessionId
    )
      fail("COMMAND_CONFLICT");
    return previous.workSessionId;
  }
  const effective = await resolveAgentProfile(ctx, owner._id, product._id, "builder");
  // The Supervisor runtime is a snapshot for the Node; it is not required to be
  // installed here because older Nodes plan deterministically without it.
  const supervisor = await resolveAgentProfile(ctx, owner._id, product._id, "supervisor");
  const locations = await ctx.db
    .query("repositoryLocations")
    .withIndex("by_repository", (q) => q.eq("repositoryId", repository._id))
    .take(33);
  if (locations.length > 32) fail("LIMIT_EXCEEDED");
  let location: Doc<"repositoryLocations"> | undefined;
  for (const item of locations) {
    const device = await load(ctx, "workstations", item.workstationId);
    const runtime = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation_runtime", (q) =>
        q.eq("workstationId", device._id).eq("runtime", effective.runtime),
      )
      .unique();
    if (
      device.ownerId === owner._id &&
      device.status === "online" &&
      (device.lastHeartbeatAt ?? 0) > Date.now() - 45000 &&
      item.status === "available" &&
      runtime?.status === "available"
    ) {
      location = item;
      break;
    }
  }
  if (!location) fail("NODE_OR_RUNTIME_OFFLINE");
  const now = Date.now();
  let sessionId = args.sessionId;
  if (sessionId) {
    const session = await ownSession(ctx, sessionId);
    if (session.productId !== product._id || session.status === "cancelled")
      fail("PRODUCT_MISMATCH");
    const relationship = await ctx.db
      .query("sessionRepositories")
      .withIndex("by_session_repository", (q) =>
        q.eq("workSessionId", session._id).eq("repositoryId", repository._id),
      )
      .unique();
    if (!relationship) fail("PRODUCT_MISMATCH");
    // A follow-up reopens a finished Session; the Supervisor decides what it needs.
    const reopen = session.status === "completed" || session.status === "failed";
    await ctx.db.patch("workSessions", session._id, {
      ...(reopen ? { status: "planning" as const, completedAt: undefined, reopenedAt: now } : {}),
      updatedAt: now,
      lastActivityAt: now,
    });
  } else {
    sessionId = await ctx.db.insert("workSessions", {
      ownerId: owner._id,
      productId: product._id,
      title: args.text.slice(0, 80),
      goal: args.text,
      status: "planning",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 0,
      needsInputCount: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    await ctx.db.insert("sessionRepositories", {
      workSessionId: sessionId,
      repositoryId: repository._id,
      role: "primary",
    });
  }
  const effectiveSessionId = sessionId;
  if (!effectiveSessionId) fail("INVALID_STATE");
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_session", (q) => q.eq("workSessionId", effectiveSessionId))
    .take(100);
  if (tasks.length >= 100) fail("LIMIT_EXCEEDED");
  if (args.sessionId)
    // A new message answers any earlier clarifying question.
    await ctx.db.patch("workSessions", sessionId, {
      needsInputCount: tasks.filter((task) => task.phase === "needs_input").length,
    });
  const history = await ctx.db
    .query("textCommands")
    .withIndex("by_session", (q) => q.eq("workSessionId", effectiveSessionId))
    .order("desc")
    .take(CONVERSATION_LIMIT);
  const conversation = history
    .reverse()
    .flatMap((row) => [
      { role: "user" as const, text: row.text },
      ...(row.reply !== undefined ? [{ role: "supervisor" as const, text: row.reply }] : []),
    ])
    .slice(-CONVERSATION_LIMIT)
    .map((entry) => ({ ...entry, text: entry.text.slice(0, CONVERSATION_TEXT_LIMIT) }));
  const planningWorkspaceId = await allocateWorkspace(ctx, {
    workSessionId: sessionId,
    repositoryLocationId: location._id,
    baseRef: location.lastKnownHead ?? "HEAD",
    kind: "worktree",
  });
  const commandId = await ctx.db.insert("textCommands", {
    ownerId: owner._id,
    idempotencyKey: args.idempotencyKey,
    text: args.text,
    productId: product._id,
    repositoryId: repository._id,
    workSessionId: sessionId,
    planningWorkspaceId,
    ...(args.sessionId ? { requestedSessionId: args.sessionId } : {}),
  });
  await enqueue(
    ctx,
    location.workstationId,
    "repository.plan",
    "textCommand",
    commandId,
    {
      textCommandId: commandId,
      workspaceId: planningWorkspaceId,
      text: args.text,
      supervisor: {
        runtime: supervisor.runtime,
        ...(supervisor.profile?.model ? { model: supervisor.profile.model } : {}),
        ...(supervisor.profile?.reasoningEffort
          ? { reasoningEffort: supervisor.profile.reasoningEffort }
          : {}),
        ...(supervisor.profile?.instructions
          ? { instructions: supervisor.profile.instructions }
          : {}),
      },
      conversation,
    },
    `plan:${commandId}`,
  );
  return sessionId;
}
export const submit = mutation({
  args: submitArgs,
  returns: v.id("workSessions"),
  handler: submitText,
});
const CONVERSATION_LIMIT = 20;
const CONVERSATION_TEXT_LIMIT = 4000;
const REPLY_LIMIT = 8000;
const ACTIVITY_LIMIT = 200;
// Progress writes closer together than this are dropped (the Node sends every 2 s at most).
const PROGRESS_MIN_INTERVAL_MS = 500;
const IN_FLIGHT = ["claimed", "acknowledged"];

// Usage counters as runtimes report them (USAGE_COUNTERS in runtime-core): every value is
// cumulative for the run. `modelCalls` counts model responses; cache-write and reasoning
// tokens are present only when the provider reports them.
export const usageArgs = v.object({
  modelActual: v.optional(v.string()),
  inputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  cacheWriteInputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  reasoningOutputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  modelCalls: v.optional(v.number()),
});
type Usage = typeof usageArgs.type;
export function assertUsage(usage: Usage) {
  if (usage.modelActual !== undefined && (!usage.modelActual || usage.modelActual.length > 256))
    fail("INVALID_ARGUMENT");
  for (const counter of USAGE_COUNTERS) {
    const value = usage[counter];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      fail("INVALID_ARGUMENT");
  }
}
async function planCommandFor(ctx: QueryCtx, textCommandId: Id<"textCommands">) {
  return ctx.db
    .query("commands")
    .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `plan:${textCommandId}`))
    .unique();
}
/**
 * Records that the Supervisor stopped before answering and idles the Session unless
 * other work (runs, tasks or another message being planned) is still active.
 */
export async function settleStoppedText(ctx: MutationCtx, textCommandId: Id<"textCommands">) {
  const text = await load(ctx, "textCommands", textCommandId);
  if (text.planDigest !== undefined || text.stoppedAt !== undefined) return;
  const now = Date.now();
  await ctx.db.patch("textCommands", text._id, {
    stoppedAt: now,
    stopRequestedAt: text.stopRequestedAt ?? now,
  });
  const session = await load(ctx, "workSessions", text.workSessionId);
  if (["completed", "cancelled", "failed"].includes(session.status)) return;
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
    .take(101);
  const texts = await ctx.db
    .query("textCommands")
    .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
    .take(101);
  let planning = false;
  for (const other of texts) {
    if (other._id === text._id || other.planDigest !== undefined || other.stoppedAt !== undefined)
      continue;
    const plan = await planCommandFor(ctx, other._id);
    if (plan && ["pending", ...IN_FLIGHT].includes(plan.status)) planning = true;
  }
  const active =
    session.activeRunCount > 0 ||
    tasks.length > 100 ||
    tasks.some((task) => ["planned", "ready", "running", "waiting"].includes(task.status));
  await ctx.db.patch("workSessions", session._id, {
    ...(planning
      ? {}
      : active
        ? session.status === "planning"
          ? { status: "running" as const }
          : {}
        : { status: "waiting" as const }),
    updatedAt: now,
    lastActivityAt: now,
  });
}
/**
 * Stops the Supervisor working on one of the owner's messages. Idempotent; once the
 * Supervisor finished (answered, planned or failed) the stop changes nothing.
 */
export const stop = mutation({
  args: { textCommandId: v.id("textCommands") },
  returns: v.union(v.literal("stopping"), v.literal("stopped"), v.literal("finished")),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const text = await load(ctx, "textCommands", args.textCommandId);
    if (text.ownerId !== owner._id) fail("FORBIDDEN");
    if (text.stoppedAt !== undefined) return "stopped";
    const plan = await planCommandFor(ctx, text._id);
    if (text.planDigest !== undefined || !plan || !["pending", ...IN_FLIGHT].includes(plan.status))
      return "finished";
    if (plan.status === "pending") {
      // Not claimed by the Node yet: withdraw it so the Supervisor never starts.
      await ctx.db.patch("commands", plan._id, { status: "expired", completedAt: Date.now() });
      await settleStoppedText(ctx, text._id);
      return "stopped";
    }
    if (text.stopRequestedAt === undefined)
      await ctx.db.patch("textCommands", text._id, { stopRequestedAt: Date.now() });
    await enqueue(
      ctx,
      plan.workstationId,
      "supervisor.stop",
      "textCommand",
      text._id,
      { textCommandId: text._id },
      `supervisor-stop:${text._id}`,
    );
    return "stopping";
  },
});
/**
 * Node-only: bounded progress of the Supervisor planning a text command. Reports for a
 * command that is no longer in flight on this Node are ignored, never stored.
 */
export const reportProgress = mutation({
  args: {
    workstationId: v.id("workstations"),
    textCommandId: v.id("textCommands"),
    activity: v.optional(v.string()),
    usage: v.optional(usageArgs),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    if (
      args.activity !== undefined &&
      (!args.activity.trim() || args.activity.length > ACTIVITY_LIMIT)
    )
      fail("INVALID_ARGUMENT");
    assertUsage(args.usage ?? {});
    const text = await load(ctx, "textCommands", args.textCommandId);
    const plan = await planCommandFor(ctx, text._id);
    if (!plan || plan.workstationId !== args.workstationId) fail("FORBIDDEN");
    if (
      !IN_FLIGHT.includes(plan.status) ||
      text.planDigest !== undefined ||
      text.stoppedAt !== undefined
    )
      return null;
    const now = Date.now();
    if (
      text.supervisorProgressAt !== undefined &&
      now - text.supervisorProgressAt < PROGRESS_MIN_INTERVAL_MS
    )
      return null;
    await ctx.db.patch("textCommands", text._id, {
      supervisorStartedAt: text.supervisorStartedAt ?? now,
      supervisorProgressAt: now,
      ...(args.activity !== undefined ? { supervisorActivity: args.activity.trim() } : {}),
      ...args.usage,
    });
    return null;
  },
});
const planTask = v.object({
  key: v.string(),
  title: v.string(),
  description: v.string(),
  dependencies: v.array(v.string()),
  verificationScripts: v.array(v.string()),
  requiredModalities: v.array(v.string()),
});
type ProposedTask = typeof planTask.type;

async function openTasks(
  ctx: MutationCtx,
  session: Doc<"workSessions">,
  workspace: Doc<"workspaces">,
  contextSha: string,
  contextDigest: string,
  tasks: ProposedTask[],
) {
  if (session.totalTaskCount + tasks.length > 100) fail("LIMIT_EXCEEDED");
  const ids = new Map<string, Id<"tasks">>();
  for (const proposed of tasks) {
    const taskId = await ctx.db.insert("tasks", {
      workSessionId: session._id,
      title: proposed.title,
      description: proposed.description,
      kind: "implementation",
      status: proposed.dependencies.length ? "blocked" : "ready",
      phase: proposed.dependencies.length ? "blocked" : "building",
      runtimePolicyMode: "auto",
      priority: 1,
      verificationScripts: proposed.verificationScripts,
      requiredModalities: proposed.requiredModalities,
      repairAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    ids.set(proposed.key, taskId);
    for (const key of proposed.dependencies)
      await ctx.db.insert("taskDependencies", {
        workSessionId: session._id,
        taskId,
        dependsOnTaskId: ids.get(key)!,
        type: "success",
      });
    if (!proposed.dependencies.length) {
      const nextWorkspaceId = await allocateWorkspace(ctx, {
        workSessionId: session._id,
        taskId,
        repositoryLocationId: workspace.repositoryLocationId,
        baseRef: contextSha,
        kind: "worktree",
        fresh: true,
      });
      await ctx.db.patch("tasks", taskId, { nextWorkspaceId });
    }
  }
  const now = Date.now();
  await ctx.db.patch("workSessions", session._id, {
    status: "running",
    ...(["completed", "failed"].includes(session.status)
      ? { reopenedAt: now, completedAt: undefined }
      : {}),
    totalTaskCount: session.totalTaskCount + tasks.length,
    contextSummary: `Repository context ${contextSha} (${contextDigest})`,
    currentPlanSummary: tasks.map((task) => task.title).join("; "),
    updatedAt: now,
    lastActivityAt: now,
  });
}

export const acceptPlan = mutation({
  args: {
    workstationId: v.id("workstations"),
    textCommandId: v.id("textCommands"),
    contextSha: v.string(),
    contextDigest: v.string(),
    tasks: v.array(planTask),
    // Optional for compatibility: older Nodes send only a plan.
    decision: v.optional(
      v.union(
        v.literal("answer"),
        v.literal("plan"),
        v.literal("propose"),
        v.literal("delegate"),
        v.literal("ask"),
      ),
    ),
    reply: v.optional(v.string()),
    usage: v.optional(usageArgs),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const requestedDecision = args.decision ?? "plan";
    if (args.reply !== undefined && (!args.reply.trim() || args.reply.length > REPLY_LIMIT))
      fail("INVALID_ARGUMENT");
    const hasTasks =
      requestedDecision === "plan" ||
      requestedDecision === "propose" ||
      requestedDecision === "delegate";
    if (!hasTasks && (args.tasks.length > 0 || args.reply === undefined)) fail("INVALID_ARGUMENT");
    if (hasTasks && args.tasks.length === 0) fail("INVALID_PLAN");
    const usage = args.usage ?? {};
    assertUsage(usage);
    const command = await load(ctx, "textCommands", args.textCommandId);
    const decision =
      (requestedDecision === "plan" || requestedDecision === "delegate") &&
      !explicitlyRequestsWork(command.text)
        ? "propose"
        : requestedDecision;
    const workspace = await load(ctx, "workspaces", command.planningWorkspaceId!);
    if (
      workspace.workstationId !== args.workstationId ||
      workspace.status !== "ready" ||
      workspace.currentHeadSha !== args.contextSha ||
      workspace.dirty ||
      !/^[a-f0-9]{64}$/.test(args.contextDigest)
    )
      fail("STALE_REPOSITORY_CONTEXT");
    if (hasTasks) validatePlan(args.tasks);
    const planDigest = JSON.stringify(args.tasks);
    if (command.planDigest) {
      if (
        command.planDigest !== planDigest ||
        (command.decision ?? "plan") !== decision ||
        command.reply !== args.reply ||
        command.contextSha !== args.contextSha ||
        command.contextDigest !== args.contextDigest
      )
        fail("COMMAND_CONFLICT");
      return null;
    }
    const session = await load(ctx, "workSessions", command.workSessionId);
    if (["completed", "cancelled", "failed"].includes(session.status)) fail("INVALID_STATE");
    await ctx.db.patch("textCommands", command._id, {
      planDigest,
      contextSha: args.contextSha,
      contextDigest: args.contextDigest,
      decision,
      ...(args.reply !== undefined ? { reply: args.reply } : {}),
      ...usage,
    });
    const now = Date.now();
    if (decision === "plan" || decision === "delegate") {
      await openTasks(ctx, session, workspace, args.contextSha, args.contextDigest, args.tasks);
      return null;
    }
    // Answer, question or proposal: no new work. Idle the Session unless earlier work is active.
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(101);
    if (tasks.length > 100) fail("LIMIT_EXCEEDED");
    const active =
      session.activeRunCount > 0 ||
      tasks.some((task) => ["planned", "ready", "running", "waiting"].includes(task.status));
    await ctx.db.patch("workSessions", session._id, {
      ...(active
        ? session.status === "planning"
          ? { status: "running" as const }
          : {}
        : { status: "waiting" as const }),
      ...(decision === "ask" ? { needsInputCount: Math.max(1, session.needsInputCount) } : {}),
      contextSummary: `Repository context ${args.contextSha} (${args.contextDigest})`,
      updatedAt: now,
      lastActivityAt: now,
    });
    return null;
  },
});

/** Owner-only explicit transition from a conversational proposal to executable work. */
export const openProposal = mutation({
  args: { textCommandId: v.id("textCommands") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const command = await load(ctx, "textCommands", args.textCommandId);
    if (command.ownerId !== owner._id) fail("FORBIDDEN");
    if (command.decision === "delegate" || command.decision === "plan") return null;
    if (
      command.decision !== "propose" ||
      !command.planDigest ||
      !command.contextSha ||
      !command.planningWorkspaceId
    )
      fail("INVALID_STATE");
    const tasks = JSON.parse(command.planDigest) as ProposedTask[];
    validatePlan(tasks);
    const session = await load(ctx, "workSessions", command.workSessionId);
    if (session.status === "cancelled") fail("INVALID_STATE");
    const workspace = await load(ctx, "workspaces", command.planningWorkspaceId);
    if (!command.contextDigest) fail("INVALID_STATE");
    await openTasks(ctx, session, workspace, command.contextSha, command.contextDigest, tasks);
    await ctx.db.patch("textCommands", command._id, { decision: "delegate" });
    return null;
  },
});

const DISPATCH_WORKSPACE_STATUSES = [
  "requested",
  "provisioning",
  "ready",
  "in_use",
  "dirty",
  "integrating",
  "completed",
  "error",
] as const;
const UNFINISHED_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
  "lost",
] as const;
const TERMINAL_RUN_STATUSES = ["completed", "failed", "stopped"] as const;
type RunStatus = Doc<"agentRuns">["status"];
type RunQuery = {
  take(n: number): Promise<Doc<"agentRuns">[]>;
  order(order: "asc" | "desc"): { take(n: number): Promise<Doc<"agentRuns">[]> };
};
// Runs that still reserve capacity: every unfinished status, plus terminal runs whose
// outcome has not been settled yet (always recent, so only the newest are read).
// Settled runs accumulate forever and must not be scanned.
async function unfinishedRuns(_ctx: MutationCtx, query: (status: RunStatus) => RunQuery) {
  const runs: Doc<"agentRuns">[] = [];
  for (const status of UNFINISHED_RUN_STATUSES) {
    const rows = await query(status).take(1001);
    if (rows.length > 1000) fail("RECONCILIATION_REQUIRED");
    runs.push(...rows);
  }
  for (const status of TERMINAL_RUN_STATUSES) {
    const recent = await query(status).order("desc").take(50);
    runs.push(...recent.filter((run) => run.completedAt === undefined));
  }
  return runs;
}

// Each Node poll advances persisted intent; transactions reserve capacity.
export const dispatch = mutation({
  args: { workstationId: v.id("workstations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    // Removed and cleanup-pending workspaces accumulate forever; only live states matter here.
    const workspaces: Doc<"workspaces">[] = [];
    for (const status of DISPATCH_WORKSPACE_STATUSES) {
      const rows = await ctx.db
        .query("workspaces")
        .withIndex("by_workstation_status", (q) =>
          q.eq("workstationId", args.workstationId).eq("status", status),
        )
        .take(1001);
      if (rows.length > 1000) fail("LIMIT_EXCEEDED");
      workspaces.push(...rows);
    }
    const taskIds = new Set(
      workspaces.flatMap((workspace) => (workspace.taskId ? [workspace.taskId] : [])),
    );
    const sessionIds = new Set(workspaces.map((workspace) => workspace.workSessionId));
    for (const sessionId of sessionIds) {
      const ready = await ctx.db
        .query("tasks")
        .withIndex("by_session_status", (q) =>
          q.eq("workSessionId", sessionId).eq("status", "ready"),
        )
        .take(101);
      if (ready.length > 100) fail("LIMIT_EXCEEDED");
      for (const task of ready) taskIds.add(task._id);
    }
    for (const taskId of taskIds) {
      const task = await load(ctx, "tasks", taskId);
      const session = await load(ctx, "workSessions", task.workSessionId);
      if (
        ["completed", "cancelled", "failed", "needs_input"].includes(session.status) ||
        ["completed", "failed", "cancelled", "blocked"].includes(task.status)
      )
        continue;
      if (
        task.phase === "waiting_for_verification" &&
        task.candidateRunId &&
        !task.verifierWorkspaceId
      ) {
        const candidate = await load(ctx, "agentRuns", task.candidateRunId);
        const candidateWorkspace = await load(ctx, "workspaces", candidate.workspaceId);
        if (!candidate.finalHeadSha || candidateWorkspace.dirty) continue;
        const verifierWorkspaceId = await allocateWorkspace(ctx, {
          workSessionId: session._id,
          taskId,
          repositoryLocationId: candidateWorkspace.repositoryLocationId,
          baseRef: candidate.finalHeadSha,
          kind: "worktree",
          fresh: true,
        });
        await ctx.db.patch("tasks", taskId, { verifierWorkspaceId });
      }
      if (task.status === "ready" && !task.nextWorkspaceId) {
        const dependencies = await ctx.db
          .query("taskDependencies")
          .withIndex("by_task", (q) => q.eq("taskId", task._id))
          .take(33);
        if (!dependencies.length) continue;
        if (dependencies.length > 32) fail("INVALID_PLAN");
        const candidates = [];
        for (const dependency of dependencies) {
          const prerequisite = await load(ctx, "tasks", dependency.dependsOnTaskId);
          if (
            prerequisite.status !== "completed" ||
            !prerequisite.candidateRunId ||
            !prerequisite.trustDecisionId
          )
            fail("INVALID_INTEGRATION_PROVENANCE");
          const decision = await load(ctx, "trustDecisions", prerequisite.trustDecisionId);
          const run = await load(ctx, "agentRuns", prerequisite.candidateRunId);
          if (!decision.eligible || run.finalHeadSha !== decision.subjectSha)
            fail("INVALID_INTEGRATION_PROVENANCE");
          candidates.push(run);
        }
        const parent = candidates[0]!;
        const parentWorkspace = await load(ctx, "workspaces", parent.workspaceId);
        const nextWorkspaceId = await allocateWorkspace(ctx, {
          workSessionId: session._id,
          taskId,
          repositoryLocationId: parentWorkspace.repositoryLocationId,
          baseRef: parent.finalHeadSha!,
          kind: "worktree",
          fresh: true,
          mergeShas: candidates.slice(1).map((run) => run.finalHeadSha!),
        });
        await ctx.db.patch("tasks", taskId, { nextWorkspaceId });
      }
      const fresh = await load(ctx, "tasks", taskId);
      const role =
        fresh.phase === "waiting_for_verification"
          ? "verifier"
          : fresh.phase === "repairing"
            ? "repair"
            : "builder";
      const workspaceId = role === "verifier" ? fresh.verifierWorkspaceId : fresh.nextWorkspaceId;
      if (
        !workspaceId ||
        (role === "verifier" ? fresh.verificationRunId !== undefined : fresh.status !== "ready")
      )
        continue;
      const workspace = await load(ctx, "workspaces", workspaceId);
      if (workspace.status !== "ready") continue;
      const reservations = await unfinishedRuns(ctx, (status) =>
        ctx.db
          .query("agentRuns")
          .withIndex("by_workstation_status", (q) =>
            q.eq("workstationId", args.workstationId).eq("status", status),
          ),
      );
      if (
        reservations.filter((run) => (run.role === "verifier") === (role === "verifier")).length >=
        (role === "verifier" ? 1 : 3)
      )
        continue;
      const effective = await resolveAgentProfile(ctx, session.ownerId, session.productId, role);
      if (effective.profile?.maxConcurrency) {
        const profileId = effective.profile._id;
        const profileRuns = await unfinishedRuns(ctx, (status) =>
          ctx.db
            .query("agentRuns")
            .withIndex("by_profile_status", (q) =>
              q.eq("agentProfileId", profileId).eq("status", status),
            ),
        );
        if (profileRuns.length >= effective.profile.maxConcurrency) continue;
      }
      const installation = await ctx.db
        .query("runtimeInstallations")
        .withIndex("by_workstation_runtime", (q) =>
          q.eq("workstationId", args.workstationId).eq("runtime", effective.runtime),
        )
        .unique();
      if (installation?.status !== "available") continue;
      await queueRun(ctx, { taskId, workspaceId, role });
    }
    return null;
  },
});
// Compatibility for older Nodes: the dispatch poll performs provisioning.
export const scheduleVerification = dispatch;
/**
 * Node-only: appends steps to the Supervisor log of a message this Node planned. Steps are
 * already redacted and bounded on the Node; the backend enforces the same bounds, keeps at
 * most SUPERVISOR_LOG_LIMITS.stepsPerMessage steps and treats replays as no-ops.
 */
export const appendLog = mutation({
  args: {
    workstationId: v.id("workstations"),
    textCommandId: v.id("textCommands"),
    steps: v.array(supervisorLogStep),
  },
  returns: v.object({ inserted: v.number(), settled: v.number(), dropped: v.number() }),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    if (args.steps.length < 1 || args.steps.length > SUPERVISOR_LOG_LIMITS.batch)
      fail("INVALID_ARGUMENT", "A log batch holds 1..100 steps");
    for (const step of args.steps)
      if (!validLogStep(step)) fail("INVALID_ARGUMENT", "Invalid step");
    const text = await load(ctx, "textCommands", args.textCommandId);
    // Only the Node the plan command was sent to ran this Supervisor.
    const plan = await planCommandFor(ctx, text._id);
    if (!plan || plan.workstationId !== args.workstationId) fail("FORBIDDEN");
    return writeLogSteps(ctx, text, args.steps);
  },
});
/** Owner-only: the Supervisor log of one message, oldest step first. */
export const log = query({
  args: { textCommandId: v.id("textCommands") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const text = await load(ctx, "textCommands", args.textCommandId);
    if (text.ownerId !== owner._id) fail("FORBIDDEN");
    const steps = await ctx.db
      .query("supervisorLogSteps")
      .withIndex("by_text_sequence", (q) => q.eq("textCommandId", text._id))
      .order("asc")
      .take(SUPERVISOR_LOG_LIMITS.stepsPerMessage);
    return steps.map(({ ownerId: _owner, textCommandId: _text, ...step }) => step);
  },
});
