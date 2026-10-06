import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
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
    for (const step of args.steps)
      if (!validStep(step) || step.stepId.startsWith(BACKEND_PREFIX))
        fail("INVALID_ARGUMENT", "Invalid step");
    return writeSteps(ctx, run, args.steps);
  },
});

// Steps the backend records itself (trust, integration, publish) use this id prefix, which
// a Node may not use: it can neither pre-empt nor settle them.
const BACKEND_PREFIX = "backend:";

async function writeSteps(ctx: MutationCtx, run: Doc<"agentRuns">, steps: TraceStep[]) {
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
      startedAt: Math.min(...steps.map((step) => step.startedAt)),
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
  for (const step of steps) {
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
}

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/**
 * Records one backend-side step (trust, integration, publish) on a Run's trace, with the
 * same contract, bounds and idempotency as Node steps: `key` names the step once (a
 * replay is a no-op) and a "started" step is settled once. Text is clipped and an invalid
 * reference is left out rather than failing the decision being traced.
 */
export async function recordStep(
  ctx: MutationCtx,
  runId: Id<"agentRuns">,
  key: string,
  step: Omit<TraceStep, "stepId">,
) {
  const run = await ctx.db.get("agentRuns", runId);
  if (!run) return;
  const references = Object.fromEntries(
    Object.entries(step.references ?? {}).filter(
      ([name, value]) => value !== undefined && (name !== "sha" || SHA.test(String(value))),
    ),
  ) as NonNullable<TraceStep["references"]>;
  const { references: _, ...rest } = step;
  const value: TraceStep = {
    ...rest,
    stepId: clip(`${BACKEND_PREFIX}${key}`, TRACE_LIMITS.stepId),
    label: clip(step.label, TRACE_LIMITS.label),
    ...(step.detail !== undefined ? { detail: clip(step.detail, TRACE_LIMITS.detail) } : {}),
    ...(Object.keys(references).length ? { references } : {}),
  };
  if (!validStep(value)) return;
  await writeSteps(ctx, run, [value]);
}

const short = (sha: string) => sha.slice(0, 12);

/** The trust decision about a candidate, on the candidate Run's trace (once per decision). */
export async function recordTrustStep(
  ctx: MutationCtx,
  decision: {
    id: Id<"trustDecisions">;
    candidateRunId: Id<"agentRuns">;
    subjectSha: string;
    eligible: boolean;
    reasons: readonly string[];
  },
  evidence: ReadonlyArray<{ modality: string; result: string }>,
  required: readonly string[],
  context: { startedAt?: number; verifierRunId?: Id<"agentRuns"> } = {},
) {
  const now = Date.now();
  const passed = evidence.filter((item) => item.result === "passed").length;
  const detail = [
    `Independent evidence: ${passed} passed, ${evidence.length - passed} failed${
      evidence.length
        ? ` (${evidence.map((item) => `${item.modality} ${item.result}`).join(", ")})`
        : ""
    }.`,
    `Required: ${required.join(", ") || "none"}.`,
    ...(decision.reasons.length ? [`Reasons: ${decision.reasons.join("; ")}`] : []),
  ].join("\n");
  await recordStep(ctx, decision.candidateRunId, `trust:${decision.id}`, {
    kind: "trust",
    label: decision.eligible
      ? `Trusted at ${short(decision.subjectSha)}`
      : decision.subjectSha
        ? `Not trusted at ${short(decision.subjectSha)}`
        : "Not trusted",
    status: decision.eligible ? "passed" : "failed",
    startedAt: Math.min(context.startedAt ?? now, now),
    finishedAt: now,
    detail,
    references: {
      sha: decision.subjectSha,
      ...(context.verifierRunId ? { runId: context.verifierRunId } : {}),
    },
  });
}

/** The local integration branch prepared at the trusted SHA (once per trust decision). */
export async function recordIntegrationStep(
  ctx: MutationCtx,
  decision: Doc<"trustDecisions">,
  branchName: string,
) {
  const now = Date.now();
  await recordStep(ctx, decision.candidateRunId, `integration:${decision._id}`, {
    kind: "integration",
    label: `Integration prepared at ${short(decision.subjectSha)}`,
    status: "passed",
    startedAt: Math.min(decision.createdAt, now),
    finishedAt: now,
    detail: `Local branch ${branchName} at ${decision.subjectSha}. Merging stays a human decision.`,
    references: { sha: decision.subjectSha },
  });
}

/**
 * Publishing one trusted task (once per publish command): started when the owner asks,
 * settled once with the pull request (or pushed branch) or the failure code.
 */
export async function recordPublishStep(
  ctx: MutationCtx,
  candidateRunId: Id<"agentRuns">,
  commandId: Id<"commands">,
  outcome:
    | { status: "started"; branch: string; sha: string }
    | {
        status: "passed";
        branch: string;
        base: string;
        sha: string;
        prUrl?: string | undefined;
        compareUrl?: string | undefined;
      }
    | { status: "failed"; code: string },
) {
  const now = Date.now();
  const step =
    outcome.status === "started"
      ? {
          label: `Publishing ${outcome.branch}`,
          detail: `Pushing ${outcome.branch} and opening a pull request.`,
          references: { sha: outcome.sha },
        }
      : outcome.status === "passed"
        ? {
            label: outcome.prUrl ? "Pull request opened" : "Branch pushed",
            detail: [
              `${outcome.branch} → ${outcome.base}`,
              outcome.prUrl ?? outcome.compareUrl ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
            references: { sha: outcome.sha },
            finishedAt: now,
          }
        : { label: "Publish failed", detail: `Failure: ${outcome.code}`, finishedAt: now };
  await recordStep(ctx, candidateRunId, `publish:${commandId}`, {
    kind: "integration",
    status: outcome.status,
    startedAt: now,
    ...step,
  });
}

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
