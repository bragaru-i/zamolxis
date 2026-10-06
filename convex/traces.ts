import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { fail, load, nodeRun, ownRun } from "./lib/access";

// Mirrors the TraceStepDto bounds in packages/contracts/src/trace/trace-step.ts.
export const TRACE_LIMITS = {
  stepId: 256,
  label: 200,
  detail: 2000,
  script: 64,
  runId: 128,
  batch: 100,
  stepsPerRun: 500,
} as const;
const SHA = /^[0-9a-f]{7,64}$/;
const SCRIPT = /^[a-zA-Z0-9:_-]{1,64}$/;

const traceStep = v.object({
  stepId: v.string(),
  kind: v.union(
    v.literal("discovery"),
    v.literal("supervisor"),
    v.literal("workspace"),
    v.literal("runtime"),
    v.literal("verification-check"),
    v.literal("trust"),
    v.literal("integration"),
  ),
  label: v.string(),
  status: v.union(
    v.literal("started"),
    v.literal("passed"),
    v.literal("failed"),
    v.literal("skipped"),
  ),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  detail: v.optional(v.string()),
  references: v.optional(
    v.object({
      runId: v.optional(v.string()),
      sha: v.optional(v.string()),
      script: v.optional(v.string()),
      exitCode: v.optional(v.number()),
    }),
  ),
});
type TraceStep = Infer<typeof traceStep>;

function validStep(step: TraceStep): boolean {
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
 * Appends a batch of trace steps for a Run of the calling Node's workstation. Steps are
 * ordered by first arrival. Re-delivering a step is a no-op; a step stored as "started"
 * is settled once by the same step with a final status (its start time is kept).
 */
export const append = mutation({
  args: {
    workstationId: v.id("workstations"),
    runId: v.id("agentRuns"),
    steps: v.array(traceStep),
  },
  returns: v.object({
    traceId: v.id("traces"),
    inserted: v.number(),
    settled: v.number(),
    dropped: v.number(),
  }),
  handler: async (ctx, args) => {
    const run = await nodeRun(ctx, args.workstationId, args.runId);
    if (args.steps.length < 1 || args.steps.length > TRACE_LIMITS.batch)
      fail("INVALID_ARGUMENT", "A trace batch holds 1..100 steps");
    for (const step of args.steps) if (!validStep(step)) fail("INVALID_ARGUMENT", "Invalid step");
    const workspace = await load(ctx, "workspaces", run.workspaceId);
    let trace = await ctx.db
      .query("traces")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .unique();
    if (!trace) {
      const id = await ctx.db.insert("traces", {
        runId: run._id,
        workspaceId: workspace._id,
        role: run.role ?? "builder",
        // The snapshot the Run started from; steps reference later SHAs themselves.
        subjectSha: run.initialHeadSha ?? workspace.baseSha ?? "",
        startedAt: Math.min(...args.steps.map((step) => step.startedAt)),
      });
      trace = await load(ctx, "traces", id);
    }
    const traceId = trace._id;
    let sequence =
      (
        await ctx.db
          .query("traceSteps")
          .withIndex("by_trace_sequence", (q) => q.eq("traceId", traceId))
          .order("desc")
          .take(1)
      )[0]?.sequence ?? 0;
    let inserted = 0;
    let settled = 0;
    let dropped = 0;
    let finishedAt: number | undefined;
    for (const step of args.steps) {
      const previous: Doc<"traceSteps"> | null = await ctx.db
        .query("traceSteps")
        .withIndex("by_trace_step", (q) => q.eq("traceId", traceId).eq("stepId", step.stepId))
        .unique();
      if (previous) {
        if (previous.status === "started" && step.status !== "started") {
          if (previous.kind !== step.kind) {
            dropped++;
            continue;
          }
          await ctx.db.patch("traceSteps", previous._id, {
            label: step.label,
            status: step.status,
            finishedAt: Math.max(previous.startedAt, step.finishedAt ?? step.startedAt),
            ...(step.detail !== undefined ? { detail: step.detail } : {}),
            ...(step.references !== undefined ? { references: step.references } : {}),
          });
          settled++;
          if (step.kind === "runtime") finishedAt = step.finishedAt;
        }
        // Anything else is a replay of a delivered step: append-only, first write wins.
        continue;
      }
      // A full trace keeps its first steps; refusing the batch would block the Node outbox.
      if (sequence >= TRACE_LIMITS.stepsPerRun) {
        dropped++;
        continue;
      }
      sequence++;
      await ctx.db.insert("traceSteps", { traceId, sequence, ...step });
      inserted++;
      if (step.kind === "runtime" && step.status !== "started") finishedAt = step.finishedAt;
    }
    if (finishedAt !== undefined) await ctx.db.patch("traces", traceId, { finishedAt });
    return { traceId, inserted, settled, dropped };
  },
});

/** Owner-scoped, oldest-first page of a Run's trace steps. */
export const listByRun = query({
  args: { runId: v.id("agentRuns"), paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    await ownRun(ctx, args.runId);
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      fail("INVALID_ARGUMENT");
    const trace = await ctx.db
      .query("traces")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (!trace) return { page: [], isDone: true, continueCursor: "" };
    return ctx.db
      .query("traceSteps")
      .withIndex("by_trace_sequence", (q) => q.eq("traceId", trace._id))
      .order("asc")
      .paginate(args.paginationOpts);
  },
});
