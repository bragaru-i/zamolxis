import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { bounded, fail, load, ownSession, requireUser } from "./lib/access";
import { enqueue } from "./lib/commands";
import {
  assertRetentionDays,
  CLEANUP_BATCH,
  CLEANUP_SCAN,
  DAY,
  DEFAULT_RETENTION_DAYS,
  evaluateWorkspace,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  ONLINE_WITHIN,
  type RetentionCache,
  requestWorkspaceCleanup,
  retentionDays,
  scheduleCleanupBatch,
} from "./lib/retention";
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
    // A removed workspace is history, never a reusable assignment.
    const existing = (
      await ctx.db
        .query("workspaces")
        .withIndex("by_task", (q) => q.eq("taskId", task._id))
        .take(101)
    )
      .filter((workspace) => !["removed", "cleanup_pending"].includes(workspace.status))
      .slice(0, 2);
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
/** Requests cleanup of one worktree only if the retention rules allow it now. */
export const requestCleanup = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.id("commands"),
  handler: async (ctx, args) => {
    const workspace = await load(ctx, "workspaces", args.workspaceId);
    const device = await load(ctx, "workstations", workspace.workstationId);
    const now = Date.now();
    const eligibility = await evaluateWorkspace(
      ctx,
      workspace,
      now,
      (await retentionDays(ctx, device.ownerId)) * DAY,
    );
    if (!eligibility.eligible) fail("INVALID_STATE", eligibility.reason);
    return requestWorkspaceCleanup(ctx, workspace, eligibility, now);
  },
});

/** Hourly retention sweep (convex/crons.ts): a bounded batch per online Mac. */
export const sweepCleanup = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const online = await ctx.db
      .query("workstations")
      .withIndex("by_status_heartbeat", (q) =>
        q.eq("status", "online").gte("lastHeartbeatAt", now - ONLINE_WITHIN),
      )
      .take(100);
    let requested = 0;
    for (const workstation of online)
      requested += await scheduleCleanupBatch(ctx, workstation, now);
    return requested;
  },
});

async function ownWorkstation(ctx: QueryCtx, workstationId: Id<"workstations">) {
  const user = await requireUser(ctx);
  const device = await load(ctx, "workstations", workstationId);
  if (device.ownerId !== user._id) fail("FORBIDDEN");
  return device;
}

const MANAGED = [
  "requested",
  "provisioning",
  "ready",
  "in_use",
  "dirty",
  "integrating",
  "completed",
  "cleanup_pending",
  "error",
] as const;

/** Settings -> Storage: managed worktrees per Mac, what may be removed now, last cleanup. */
export const storage = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const days = await retentionDays(ctx, user._id);
    const now = Date.now();
    const devices = await ctx.db
      .query("workstations")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .take(20);
    const cache: RetentionCache = new Map();
    const macs = [];
    for (const device of devices) {
      if (device.status === "revoked") continue;
      let managed = 0;
      let pending = 0;
      let failed = 0;
      let eligible = 0;
      let truncated = false;
      for (const status of MANAGED) {
        const rows = await ctx.db
          .query("workspaces")
          .withIndex("by_workstation_status", (q) =>
            q.eq("workstationId", device._id).eq("status", status),
          )
          .take(CLEANUP_SCAN + 1);
        if (rows.length > CLEANUP_SCAN) truncated = true;
        managed += Math.min(rows.length, CLEANUP_SCAN);
        for (const row of rows.slice(0, CLEANUP_SCAN)) {
          if (row.cleanupStatus === "requested") pending += 1;
          else if (row.cleanupStatus === "failed") failed += 1;
          if (
            (status === "ready" || status === "completed") &&
            (await evaluateWorkspace(ctx, row, now, days * DAY, cache)).eligible
          )
            eligible += 1;
        }
      }
      const removed = await ctx.db
        .query("workspaces")
        .withIndex("by_workstation_status", (q) =>
          q.eq("workstationId", device._id).eq("status", "removed"),
        )
        .order("desc")
        .take(50);
      const lastCleanupAt = Math.max(0, ...removed.map((row) => row.removedAt ?? 0));
      macs.push({
        workstationId: device._id,
        name: device.name,
        online: device.status === "online" && (device.lastHeartbeatAt ?? 0) >= now - ONLINE_WITHIN,
        managed,
        eligible,
        pending,
        failed,
        truncated,
        ...(lastCleanupAt ? { lastCleanupAt } : {}),
      });
    }
    return {
      retentionDays: days,
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
      minRetentionDays: MIN_RETENTION_DAYS,
      maxRetentionDays: MAX_RETENTION_DAYS,
      batch: CLEANUP_BATCH,
      macs,
    };
  },
});

/** "Clean up now": the same bounded, rule-checked batch the hourly sweep requests. */
export const cleanupNow = mutation({
  args: { workstationId: v.id("workstations") },
  returns: v.object({ requested: v.number() }),
  handler: async (ctx, args) => {
    const device = await ownWorkstation(ctx, args.workstationId);
    const now = Date.now();
    if (device.status !== "online" || (device.lastHeartbeatAt ?? 0) < now - ONLINE_WITHIN)
      fail("WORKSTATION_OFFLINE");
    return { requested: await scheduleCleanupBatch(ctx, device, now) };
  },
});

export const setRetentionDays = mutation({
  args: { days: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    assertRetentionDays(args.days);
    const existing = await ctx.db
      .query("storageSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .unique();
    if (existing)
      await ctx.db.patch("storageSettings", existing._id, {
        retentionDays: args.days,
        updatedAt: Date.now(),
      });
    else
      await ctx.db.insert("storageSettings", {
        ownerId: user._id,
        retentionDays: args.days,
        updatedAt: Date.now(),
      });
    return null;
  },
});
