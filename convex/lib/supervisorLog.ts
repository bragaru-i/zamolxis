import { type Infer, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { supervisorLogKind, supervisorLogReferences, supervisorLogStatus } from "../schema";
import { TRACE_LIMITS } from "../traces";

// Mirrors packages/contracts/src/trace/supervisor-log.ts: the TraceStepDto bounds with the
// Supervisor log's own step kinds.
export const SUPERVISOR_LOG_LIMITS = { batch: 100, stepsPerMessage: 300 } as const;
const SHA = /^[0-9a-f]{7,64}$/;
const SCRIPT = /^[a-zA-Z0-9:_-]{1,64}$/;

export const supervisorLogStep = v.object({
  stepId: v.string(),
  kind: supervisorLogKind,
  label: v.string(),
  status: supervisorLogStatus,
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  detail: v.optional(v.string()),
  references: v.optional(supervisorLogReferences),
});
export type SupervisorLogStep = Infer<typeof supervisorLogStep>;

export function validLogStep(step: SupervisorLogStep): boolean {
  const { references } = step;
  return (
    step.stepId.length > 0 &&
    step.stepId.length <= TRACE_LIMITS.stepId &&
    step.label.trim().length > 0 &&
    step.label.length <= TRACE_LIMITS.label &&
    (step.detail === undefined || step.detail.length <= TRACE_LIMITS.detail) &&
    Number.isFinite(step.startedAt) &&
    step.startedAt > 0 &&
    (step.finishedAt === undefined ||
      (Number.isFinite(step.finishedAt) && step.finishedAt >= step.startedAt)) &&
    (step.status === "started" || step.finishedAt !== undefined) &&
    (references === undefined ||
      ((references.runId === undefined ||
        (references.runId.length > 0 && references.runId.length <= TRACE_LIMITS.runId)) &&
        (references.sha === undefined || SHA.test(references.sha)) &&
        (references.script === undefined || SCRIPT.test(references.script)) &&
        (references.exitCode === undefined || Number.isSafeInteger(references.exitCode))))
  );
}

/**
 * Appends steps to a message's Supervisor log in first-arrival order. A replayed step is
 * a no-op; a "started" step is settled once by the same step with a final status (its
 * start time is kept). A full log keeps its first steps: refusing the batch would block
 * the Node outbox.
 */
export async function writeLogSteps(
  ctx: MutationCtx,
  text: Doc<"textCommands">,
  steps: readonly SupervisorLogStep[],
) {
  let sequence =
    (
      await ctx.db
        .query("supervisorLogSteps")
        .withIndex("by_text_sequence", (q) => q.eq("textCommandId", text._id))
        .order("desc")
        .take(1)
    )[0]?.sequence ?? 0;
  let inserted = 0;
  let settled = 0;
  let dropped = 0;
  for (const step of steps) {
    const previous = await ctx.db
      .query("supervisorLogSteps")
      .withIndex("by_text_step", (q) => q.eq("textCommandId", text._id).eq("stepId", step.stepId))
      .unique();
    if (previous) {
      if (previous.status === "started" && step.status !== "started") {
        if (previous.kind !== step.kind) {
          dropped++;
          continue;
        }
        await ctx.db.patch("supervisorLogSteps", previous._id, {
          label: step.label,
          status: step.status,
          finishedAt: Math.max(previous.startedAt, step.finishedAt ?? step.startedAt),
          ...(step.detail !== undefined ? { detail: step.detail } : {}),
          ...(step.references !== undefined ? { references: step.references } : {}),
        });
        settled++;
      }
      continue;
    }
    if (sequence >= SUPERVISOR_LOG_LIMITS.stepsPerMessage) {
      dropped++;
      continue;
    }
    sequence++;
    await ctx.db.insert("supervisorLogSteps", {
      textCommandId: text._id,
      ownerId: text.ownerId,
      sequence,
      ...step,
    });
    inserted++;
  }
  return { inserted, settled, dropped };
}
