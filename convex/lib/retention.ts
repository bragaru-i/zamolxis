import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail, load } from "./access";
import { enqueue } from "./commands";

// Worktree retention (#8). The backend decides which managed worktrees may be removed;
// the Node still refuses dirty or busy worktrees and never forces removal.
export const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 3;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 30;
/** Read-only planning worktrees are kept one day after the Supervisor decided. */
export const PLANNING_RETENTION = DAY;
/** Cleanup commands requested per computer per sweep (cron or "Clean up now"). */
export const CLEANUP_BATCH = 10;
/** Ready worktrees examined per computer per sweep. */
export const CLEANUP_SCAN = 100;
export const MAX_CLEANUP_ATTEMPTS = 3;
/** Back-off before the next attempt after the n-th failure (n = 1, 2). */
export const CLEANUP_BACKOFF = [6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000] as const;
/** Failures that another attempt cannot fix: the Node does not know this worktree. */
const PERMANENT = new Set(["WORKSPACE_NOT_REGISTERED", "WORKSPACE_IDENTITY_MISMATCH"]);
/** A computer must have reported a heartbeat this recently to receive cleanup commands. */
export const ONLINE_WITHIN = 5 * 60 * 1000;

const SESSION_DONE = ["completed", "failed", "cancelled"];
const TASK_BUSY = ["planned", "ready", "running"];
const PHASE_BUSY = [
  "building",
  "waiting_for_verification",
  "verifying",
  "repairing",
  "ready_for_integration",
  "integrating",
];
const SHA = /^[a-f0-9]{40,64}$/;

export type Eligibility =
  | { eligible: true; deleteBranchAt?: string }
  | { eligible: false; reason: string };

export async function retentionDays(ctx: QueryCtx, ownerId: Id<"users">): Promise<number> {
  const settings = await ctx.db
    .query("storageSettings")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  return settings?.retentionDays ?? DEFAULT_RETENTION_DAYS;
}

function no(reason: string): Eligibility {
  return { eligible: false, reason };
}

/** Trusted commits of the Session's tasks and whether each was published to the remote. */
async function trustedCommits(ctx: QueryCtx, tasks: Doc<"tasks">[]) {
  const trusted = new Map<string, Doc<"tasks">>();
  for (const task of tasks) {
    const ids = new Set([task.trustDecisionId, task.lastTrustDecisionId]);
    for (const id of ids) {
      if (!id) continue;
      const decision = await ctx.db.get("trustDecisions", id);
      // An unpublished task wins when two tasks trusted the same commit.
      const known = decision && trusted.get(decision.subjectSha);
      if (known && known.publishStatus !== "published") continue;
      if (decision?.eligible && SHA.test(decision.subjectSha))
        trusted.set(decision.subjectSha, task);
    }
  }
  return trusted;
}

/**
 * Deterministic retention rules; the first failing rule is the reason a worktree is kept.
 * See README "Worktree retention" for the same rules in prose.
 */
export type RetentionCache = Map<string, Promise<unknown>>;
function cached<T>(cache: RetentionCache, key: string, read: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, read());
  return cache.get(key) as Promise<T>;
}

export async function evaluateWorkspace(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  now: number,
  retentionMs: number,
  // Per-sweep reads shared by worktrees of the same Session.
  cache: RetentionCache = new Map(),
): Promise<Eligibility> {
  if (workspace.kind === "canonical") return no("CANONICAL");
  if (workspace.cleanupStatus === "requested" || workspace.status === "cleanup_pending")
    return no("CLEANUP_REQUESTED");
  if (!["ready", "completed"].includes(workspace.status)) return no("STATUS");
  if (workspace.ownerRunId) return no("OWNER_RUN");
  if (workspace.dirty) return no("DIRTY");
  if (workspace.cleanupStatus === "failed") {
    if (
      (workspace.cleanupAttempts ?? 0) >= MAX_CLEANUP_ATTEMPTS ||
      PERMANENT.has(workspace.cleanupError ?? "")
    )
      return no("CLEANUP_EXHAUSTED");
    if ((workspace.cleanupNextAttemptAt ?? 0) > now) return no("CLEANUP_BACKOFF");
  }
  const runs = await ctx.db
    .query("agentRuns")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(51);
  if (runs.length > 50) return no("TOO_MANY_RUNS");
  if (runs.some((run) => run.completedAt === undefined)) return no("ACTIVE_RUN");
  const lastRunAt = Math.max(0, ...runs.map((run) => run.completedAt ?? 0));
  const session = await cached(cache, `session:${workspace.workSessionId}`, () =>
    load(ctx, "workSessions", workspace.workSessionId),
  );

  // Supervisor planning worktree: read-only, kept one day after the decision.
  if (!workspace.taskId) {
    const messages = await cached(cache, `messages:${session._id}`, () =>
      ctx.db
        .query("textCommands")
        .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
        .take(201),
    );
    const message = messages.find((row) => row.planningWorkspaceId === workspace._id);
    if (message) {
      const plan = await ctx.db
        .query("commands")
        .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `plan:${message._id}`))
        .unique();
      const finished =
        plan && ["completed", "failed", "expired"].includes(plan.status)
          ? (plan.completedAt ?? plan.createdAt)
          : undefined;
      const decidedAt = finished ?? message.stoppedAt;
      if (decidedAt === undefined) return no("PLAN_UNDECIDED");
      const window = Math.min(PLANNING_RETENTION, retentionMs);
      if (now - Math.max(decidedAt, lastRunAt) < window) return no("RETENTION_WINDOW");
      return { eligible: true };
    }
    if (messages.length > 200) return no("TOO_MANY_MESSAGES");
  }

  // Everything else waits until the Session is finished or idle.
  const idle = session.status === "waiting" && session.activeRunCount === 0;
  if (!SESSION_DONE.includes(session.status) && !idle) return no("SESSION_ACTIVE");
  const tasks = await cached(cache, `tasks:${session._id}`, () =>
    ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(101),
  );
  if (tasks.length > 100) return no("TOO_MANY_TASKS");
  if (tasks.some((task) => TASK_BUSY.includes(task.status))) return no("SESSION_ACTIVE");
  let lastUsedAt = Math.max(session.lastActivityAt, lastRunAt);
  const task = workspace.taskId ? tasks.find((row) => row._id === workspace.taskId) : undefined;
  if (task) {
    const settled = ["completed", "failed", "cancelled"].includes(task.status);
    if (!settled && task.phase && PHASE_BUSY.includes(task.phase)) return no("TASK_ACTIVE");
    if (
      !settled &&
      task.verifierWorkspaceId === workspace._id &&
      task.verificationRunId &&
      !task.trustDecisionId
    )
      return no("ACTIVE_VERIFICATION");
    if (task.integrationWorkspaceId === workspace._id) {
      if (task.publishStatus === "pending") return no("PUBLISH_PENDING");
      // Trusted work waits for the owner to publish it, however long that takes.
      if (task.publishStatus !== "published") return no("UNPUBLISHED_INTEGRATION");
      lastUsedAt = Math.max(lastUsedAt, task.publishedAt ?? 0);
    }
  }
  if (now - lastUsedAt < retentionMs) return no("RETENTION_WINDOW");

  // A trusted commit that is not on the remote must stay in a worktree and on its branch.
  const head = workspace.currentHeadSha;
  const trusted = await cached(cache, `trusted:${session._id}`, () => trustedCommits(ctx, tasks));
  const owner = head ? trusted.get(head) : undefined;
  if (owner && owner.publishStatus !== "published") {
    const holderId = owner.integrationWorkspaceId;
    const holder =
      holderId && holderId !== workspace._id ? await ctx.db.get("workspaces", holderId) : null;
    if (
      !holder ||
      !["ready", "completed"].includes(holder.status) ||
      holder.cleanupStatus !== undefined ||
      holder.dirty ||
      holder.currentHeadSha !== head
    )
      return no("ONLY_TRUSTED_COPY");
    // The integration worktree keeps it; this branch stays as a second reference.
    return { eligible: true };
  }
  return head && SHA.test(head) ? { eligible: true, deleteBranchAt: head } : { eligible: true };
}

/** Enqueues `workspace.cleanup` for one eligible worktree; one command per attempt. */
export async function requestWorkspaceCleanup(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  eligibility: Eligibility & { eligible: true },
  now: number,
) {
  const attempt = (workspace.cleanupAttempts ?? 0) + 1;
  const commandId = await enqueue(
    ctx,
    workspace.workstationId,
    "workspace.cleanup",
    "workspace",
    workspace._id,
    {
      workspaceId: workspace._id,
      ...(eligibility.deleteBranchAt ? { deleteBranchAt: eligibility.deleteBranchAt } : {}),
    },
    `cleanup:${workspace._id}:${attempt}`,
  );
  // cleanup_pending keeps dispatch from starting a run here until the Node answers.
  await ctx.db.patch("workspaces", workspace._id, {
    status: "cleanup_pending",
    cleanupStatus: "requested",
    cleanupCommandId: commandId,
    cleanupAttempts: attempt,
    cleanupRequestedAt: now,
    cleanupError: undefined,
    cleanupNextAttemptAt: undefined,
    updatedAt: now,
  });
  return commandId;
}

/** A bounded, idempotent batch of cleanup requests for one online computer. */
export async function scheduleCleanupBatch(
  ctx: MutationCtx,
  workstation: Doc<"workstations">,
  now: number,
): Promise<number> {
  if (workstation.status !== "online" || (workstation.lastHeartbeatAt ?? 0) < now - ONLINE_WITHIN)
    return 0;
  const retentionMs = (await retentionDays(ctx, workstation.ownerId)) * DAY;
  const cache: RetentionCache = new Map();
  let requested = 0;
  for (const status of ["ready", "completed"] as const) {
    const candidates = await ctx.db
      .query("workspaces")
      .withIndex("by_workstation_status", (q) =>
        q.eq("workstationId", workstation._id).eq("status", status),
      )
      .take(CLEANUP_SCAN);
    for (const workspace of candidates) {
      if (requested >= CLEANUP_BATCH) return requested;
      const eligibility = await evaluateWorkspace(ctx, workspace, now, retentionMs, cache);
      if (!eligibility.eligible) continue;
      await requestWorkspaceCleanup(ctx, workspace, eligibility, now);
      requested += 1;
    }
  }
  return requested;
}

/** The Node confirmed removal (directly or through command recovery). */
export async function recordCleanupRemoved(ctx: MutationCtx, workspace: Doc<"workspaces">) {
  const now = Date.now();
  await ctx.db.patch("workspaces", workspace._id, {
    status: "removed",
    cleanupStatus: "removed",
    cleanupError: undefined,
    cleanupNextAttemptAt: undefined,
    removedAt: workspace.removedAt ?? now,
    updatedAt: now,
  });
}

/** The Node refused or failed the removal: record the code and back off, bounded. */
export async function recordCleanupFailure(
  ctx: MutationCtx,
  command: Doc<"commands">,
  code: string,
) {
  const id = ctx.db.normalizeId("workspaces", command.targetId);
  if (!id) return;
  const workspace = await ctx.db.get("workspaces", id);
  if (!workspace || workspace.status === "removed") return;
  if (workspace.cleanupCommandId !== command._id || workspace.cleanupStatus !== "requested") return;
  const now = Date.now();
  const attempts = workspace.cleanupAttempts ?? 1;
  const dirty = code === "DIRTY_WORKSPACE_PRESERVED";
  const retry =
    !PERMANENT.has(code) && attempts < MAX_CLEANUP_ATTEMPTS
      ? now + (CLEANUP_BACKOFF[attempts - 1] ?? CLEANUP_BACKOFF[1])
      : undefined;
  await ctx.db.patch("workspaces", workspace._id, {
    // A worktree the Node found dirty is preserved as dirty; anything else stays usable.
    status: dirty ? "dirty" : "ready",
    ...(dirty ? { dirty: true } : {}),
    cleanupStatus: "failed",
    cleanupError: code.slice(0, 64),
    cleanupNextAttemptAt: retry,
    updatedAt: now,
  });
}

export function assertRetentionDays(days: number) {
  if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS)
    fail("INVALID_ARGUMENT", `Retention must be ${MIN_RETENTION_DAYS}..${MAX_RETENTION_DAYS} days`);
}
