import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, load, nodeRun, ownRun } from "./lib/access";
export const append = mutation({
  args: {
    workstationId: v.id("workstations"),
    runId: v.id("agentRuns"),
    subjectSha: v.string(),
    steps: v.array(
      v.object({
        eventId: v.string(),
        sequence: v.number(),
        type: v.string(),
        summary: v.string(),
        occurredAt: v.number(),
      }),
    ),
  },
  returns: v.id("traces"),
  handler: async (ctx, args) => {
    const run = await nodeRun(ctx, args.workstationId, args.runId);
    const workspace = await load(ctx, "workspaces", run.workspaceId);
    if (args.steps.length > 100 || args.subjectSha !== (run.finalHeadSha ?? workspace.baseSha))
      fail("INVALID_ARGUMENT");
    let trace = await ctx.db
      .query("traces")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .unique();
    if (!trace) {
      const id = await ctx.db.insert("traces", {
        runId: run._id,
        workspaceId: workspace._id,
        role: run.role ?? "builder",
        subjectSha: args.subjectSha,
        startedAt: Date.now(),
      });
      trace = await load(ctx, "traces", id);
    }
    if (trace.subjectSha !== args.subjectSha) fail("COMMAND_CONFLICT");
    let sequence =
      (
        await ctx.db
          .query("traceSteps")
          .withIndex("by_trace_sequence", (q) => q.eq("traceId", trace._id))
          .order("desc")
          .take(1)
      )[0]?.sequence ?? 0;
    for (const step of args.steps) {
      if (!Number.isSafeInteger(step.sequence) || step.summary.length > 8192)
        fail("INVALID_ARGUMENT");
      const previous = await ctx.db
        .query("traceSteps")
        .withIndex("by_trace_event", (q) => q.eq("traceId", trace!._id).eq("eventId", step.eventId))
        .unique();
      if (previous) {
        if (
          previous.sequence !== step.sequence ||
          previous.summary !== step.summary ||
          previous.type !== step.type ||
          previous.occurredAt !== step.occurredAt
        )
          fail("COMMAND_CONFLICT");
        continue;
      }
      if (step.sequence !== sequence + 1) fail("EVENT_SEQUENCE_CONFLICT");
      await ctx.db.insert("traceSteps", { traceId: trace._id, ...step });
      sequence = step.sequence;
    }
    return trace._id;
  },
});
export const listByRun = query({
  args: { runId: v.id("agentRuns"), paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, args) => {
    await ownRun(ctx, args.runId);
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      fail("INVALID_ARGUMENT");
    const trace = await ctx.db
      .query("traces")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (!trace) return { page: [], isDone: true, continueCursor: "" };
    return ctx.db
      .query("traceSteps")
      .withIndex("by_trace_sequence", (q) => q.eq("traceId", trace._id))
      .paginate(args.paginationOpts);
  },
});
