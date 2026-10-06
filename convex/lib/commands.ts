import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail, load } from "./access";
import { settleRun } from "./settlement";
import { valueKey } from "./value";
export async function enqueue(
  ctx: MutationCtx,
  workstationId: Id<"workstations">,
  type: string,
  targetType: string,
  targetId: string,
  payload: unknown,
  key: string,
) {
  const existing = await ctx.db
    .query("commands")
    .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", key))
    .unique();
  if (existing) {
    if (
      existing.workstationId !== workstationId ||
      existing.type !== type ||
      existing.targetId !== targetId ||
      existing.targetType !== targetType ||
      valueKey(existing.payload) !== valueKey(payload)
    )
      fail("COMMAND_CONFLICT");
    return existing._id;
  }
  return ctx.db.insert("commands", {
    workstationId,
    type,
    targetType,
    targetId,
    payload,
    idempotencyKey: key,
    status: "pending",
    createdAt: Date.now(),
  });
}
export async function stopRun(ctx: MutationCtx, runId: Id<"agentRuns">) {
  const run = await load(ctx, "agentRuns", runId);
  if (["completed", "failed", "stopped"].includes(run.status)) return;
  // A lost run has no live session the Node can interrupt; the owner's stop is the human
  // reconciliation that settles it and releases its capacity. The stop command below still
  // reaches the Node in case the session turns out to be alive.
  const next = run.status === "queued" || run.status === "lost" ? "stopped" : "stopping";
  const { assertRunTransition } = await import("@zamolxis/domain");
  if (run.status !== next) assertRunTransition(run.status, next);
  await ctx.db.patch("agentRuns", runId, { status: next });
  if (next === "stopped") {
    const start = await ctx.db
      .query("commands")
      .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `start:${runId}`))
      .unique();
    if (start?.status === "pending")
      await ctx.db.patch("commands", start._id, { status: "expired", completedAt: Date.now() });
    const workspace = await load(ctx, "workspaces", run.workspaceId);
    await settleRun(ctx, runId, {
      headSha: workspace.currentHeadSha ?? workspace.baseSha ?? "",
      dirty: workspace.dirty,
      changedFileCount: workspace.changedFileCount,
    });
  }
  if (next === "stopping" || run.status === "lost")
    await enqueue(ctx, run.workstationId, "runtime.stop", "run", runId, { runId }, `stop:${runId}`);
}
