import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { fail, ownRun } from "./lib/access";
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
    return ctx.db
      .query("runEvents")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
