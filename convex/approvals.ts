import { assertRunTransition, type RunStatus } from "@zamolxis/domain";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { bounded, fail, load, ownSession, requireUser } from "./lib/access";
import { enqueue } from "./lib/commands";

export const request = internalMutation({
  args: {
    workSessionId: v.id("workSessions"),
    runId: v.optional(v.id("agentRuns")),
    action: v.string(),
    risk: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    request: v.any(),
  },
  returns: v.id("approvals"),
  handler: async (ctx, args) => {
    const session = await load(ctx, "workSessions", args.workSessionId);
    if (JSON.stringify(args.request).length > 16384) fail("INVALID_ARGUMENT");
    if (args.runId) {
      const run = await load(ctx, "agentRuns", args.runId);
      if (run.workSessionId !== session._id) fail("FORBIDDEN");
    }
    return ctx.db.insert("approvals", {
      ...args,
      ownerId: session.ownerId,
      status: "pending",
      requestedAt: Date.now(),
    });
  },
});
export const listPending = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return ctx.db
      .query("approvals")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", user._id).eq("status", "pending"))
      .take(bounded(args.limit ?? 50));
  },
});
export const listPendingBySession = query({
  args: { workSessionId: v.id("workSessions"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    return ctx.db
      .query("approvals")
      .withIndex("by_session_status", (q) =>
        q.eq("workSessionId", args.workSessionId).eq("status", "pending"),
      )
      .take(bounded(args.limit ?? 50));
  },
});
const ACTIVE = ["running", "waiting", "needs_approval"];
export const resolve = mutation({
  args: {
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    scope: v.optional(v.union(v.literal("once"), v.literal("run"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const approval = await load(ctx, "approvals", args.approvalId);
    await ownSession(ctx, approval.workSessionId);
    const user = await requireUser(ctx);
    if (approval.ownerId !== user._id) fail("FORBIDDEN");
    const scope = args.scope ?? "once";
    const request =
      approval.request && typeof approval.request === "object"
        ? (approval.request as Record<string, unknown>)
        : {};
    if (
      scope === "run" &&
      (args.decision !== "approved" ||
        request.allowForSession !== true ||
        approval.action !== "command" ||
        !["low", "medium"].includes(approval.risk))
    )
      fail("INVALID_ARGUMENT");
    if (approval.status === args.decision) return null;
    if (approval.status !== "pending") fail("INVALID_STATE");
    if (approval.runId && approval.runtimeApprovalId) {
      // The decision travels to the run's own Node; the runtime confirms it with an event.
      const run = await load(ctx, "agentRuns", approval.runId);
      if (run.workSessionId !== approval.workSessionId) fail("FORBIDDEN");
      if (!ACTIVE.includes(run.status)) fail("INVALID_STATE");
      await enqueue(
        ctx,
        run.workstationId,
        "runtime.approval",
        "run",
        run._id,
        {
          runId: run._id,
          approvalId: approval.runtimeApprovalId,
          decision:
            args.decision === "rejected"
              ? "reject"
              : scope === "run"
                ? "approve_session"
                : "approve",
        },
        `approval:${approval._id}`,
      );
    }
    // Approval records permission only. It does not change evidence, trust, or execute integration.
    await ctx.db.patch("approvals", approval._id, {
      status: args.decision,
      resolvedAt: Date.now(),
      resolvedBy: user._id,
    });
    return null;
  },
});

const KINDS = ["command", "fileChange", "tool", "other"] as const;
const RISKS = ["low", "medium", "high", "critical"] as const;
const REASONS = ["user", "timeout", "stopped", "withdrawn"] as const;
function pick<T extends string>(values: readonly T[], value: unknown): T {
  const found = values.find((item) => item === value);
  if (!found) fail("INVALID_ARGUMENT");
  return found;
}
function boundedText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) fail("INVALID_ARGUMENT");
  return value;
}
async function runtimeApproval(ctx: MutationCtx, run: Doc<"agentRuns">, approvalId: string) {
  return ctx.db
    .query("approvals")
    .withIndex("by_run_runtime_approval", (q) =>
      q.eq("runId", run._id).eq("runtimeApprovalId", approvalId),
    )
    .unique();
}
/**
 * Applies a Node-reported approval event and returns the run's next status. A request
 * creates a pending approval and holds the run in needs_approval; the runtime's
 * confirmation returns it to running once nothing else is pending.
 */
export async function applyApprovalEvent(
  ctx: MutationCtx,
  run: Doc<"agentRuns">,
  event: { type: "approval.requested" | "approval.resolved"; payload: unknown; occurredAt: number },
): Promise<RunStatus> {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : fail("INVALID_ARGUMENT");
  const approvalId = boundedText(payload.approvalId, 256);
  if (event.type === "approval.requested") {
    const kind = pick(KINDS, payload.kind);
    const risk = pick(RISKS, payload.risk);
    const summary = boundedText(payload.summary, 2000);
    const allowForSession =
      payload.allowForSession === true &&
      kind === "command" &&
      (risk === "low" || risk === "medium");
    if (await runtimeApproval(ctx, run, approvalId)) fail("COMMAND_CONFLICT");
    const session = await load(ctx, "workSessions", run.workSessionId);
    await ctx.db.insert("approvals", {
      ownerId: session.ownerId,
      workSessionId: run.workSessionId,
      runId: run._id,
      workstationId: run.workstationId,
      action: kind,
      risk,
      request: { approvalId, kind, summary, ...(allowForSession ? { allowForSession: true } : {}) },
      runtimeApprovalId: approvalId,
      status: "pending",
      requestedAt: Date.now(),
    });
    if (run.status === "needs_approval" || run.status === "stopping") return run.status;
    assertRunTransition(run.status, "needs_approval");
    return "needs_approval";
  }
  const decision = pick(["approved", "rejected"] as const, payload.decision);
  const reason = pick(REASONS, payload.reason);
  const approval = await runtimeApproval(ctx, run, approvalId);
  if (!approval || approval.runtimeOutcome) fail("INVALID_STATE");
  await ctx.db.patch("approvals", approval._id, {
    runtimeOutcome: { decision, reason, at: event.occurredAt },
    // A human decision stays recorded; otherwise the runtime outcome settles the request.
    ...(approval.status === "pending"
      ? {
          status: reason === "user" ? decision : ("expired" as const),
          resolvedAt: Date.now(),
        }
      : {}),
  });
  if (run.status !== "needs_approval") {
    if (!["running", "waiting", "stopping"].includes(run.status)) fail("INVALID_STATE");
    return run.status;
  }
  const others = await ctx.db
    .query("approvals")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .take(101);
  if (others.length > 100) fail("LIMIT_EXCEEDED");
  const waiting = others.some(
    (item) => item._id !== approval._id && item.runtimeApprovalId && !item.runtimeOutcome,
  );
  return waiting ? "needs_approval" : "running";
}
/** A terminal run cannot act on anything it asked for. */
export async function expireRunApprovals(ctx: MutationCtx, run: Doc<"agentRuns">) {
  const pending = await ctx.db
    .query("approvals")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .take(101);
  for (const approval of pending)
    if (approval.status === "pending")
      await ctx.db.patch("approvals", approval._id, { status: "expired", resolvedAt: Date.now() });
}
