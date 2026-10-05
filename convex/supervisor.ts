import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { fail, load, ownSession, requireUser } from "./lib/access";
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
export const submit = mutation({
  args: {
    productId: v.id("products"),
    repositoryId: v.id("repositories"),
    text: v.string(),
    idempotencyKey: v.string(),
    sessionId: v.optional(v.id("workSessions")),
  },
  returns: v.id("workSessions"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (
      !args.text.trim() ||
      args.text.length > 16000 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args.idempotencyKey)
    )
      fail("INVALID_ARGUMENT");
    const repository = await load(ctx, "repositories", args.repositoryId);
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
          q.eq("workstationId", device._id).eq("runtime", "codex"),
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
      if (
        session.productId !== product._id ||
        ["completed", "failed", "cancelled"].includes(session.status)
      )
        fail("PRODUCT_MISMATCH");
      const relationship = await ctx.db
        .query("sessionRepositories")
        .withIndex("by_session_repository", (q) =>
          q.eq("workSessionId", session._id).eq("repositoryId", repository._id),
        )
        .unique();
      if (!relationship) fail("PRODUCT_MISMATCH");
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
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", sessionId!))
      .take(100);
    if (tasks.length >= 100) fail("LIMIT_EXCEEDED");
    const taskId = await ctx.db.insert("tasks", {
      workSessionId: sessionId,
      title: args.text.slice(0, 80),
      description: args.text,
      kind: "implementation",
      status: "ready",
      runtimePolicyMode: "forced",
      runtimePolicyRuntime: "codex",
      priority: 1,
      createdAt: now,
      updatedAt: now,
    });
    const session = await load(ctx, "workSessions", sessionId);
    await ctx.db.patch("workSessions", sessionId, {
      totalTaskCount: session.totalTaskCount + 1,
      updatedAt: now,
      lastActivityAt: now,
    });
    await allocateWorkspace(ctx, {
      workSessionId: sessionId,
      taskId,
      repositoryLocationId: location._id,
      baseRef: location.lastKnownHead ?? "HEAD",
      kind: "worktree",
    });
    await ctx.db.insert("textCommands", {
      ownerId: owner._id,
      idempotencyKey: args.idempotencyKey,
      text: args.text,
      productId: product._id,
      repositoryId: repository._id,
      workSessionId: sessionId,
      ...(args.sessionId ? { requestedSessionId: args.sessionId } : {}),
    });
    return sessionId;
  },
});
// Called by Node after workspace provisioning; capacity is reserved transactionally.
export const dispatch = mutation({
  args: { workstationId: v.id("workstations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { requireNode } = await import("./lib/access");
    await requireNode(ctx, args.workstationId);
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_workstation_status", (q) =>
        q.eq("workstationId", args.workstationId).eq("status", "ready"),
      )
      .take(100);
    for (const workspace of workspaces) {
      if (!workspace.taskId) continue;
      const task = await load(ctx, "tasks", workspace.taskId);
      if (task.status !== "ready" || task.runtimePolicyRuntime !== "codex") continue;
      // Count first: a thrown capacity error rolls back this entire mutation.
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_workstation_status", (q) => q.eq("workstationId", args.workstationId))
        .take(1001);
      if (runs.length > 1000) fail("RECONCILIATION_REQUIRED");
      if (
        runs.filter((run) => (run.role ?? "builder") === "builder" && run.completedAt === undefined)
          .length >= 3
      )
        break;
      await queueRun(ctx, { taskId: task._id, workspaceId: workspace._id, runtime: "codex" });
    }
    return null;
  },
});
