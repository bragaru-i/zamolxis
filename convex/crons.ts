import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Worktree retention (#8): every hour, a bounded batch of eligible managed worktrees per
// online computer is handed to its Node for removal. Rules: convex/lib/retention.ts.
crons.hourly("workspace retention", { minuteUTC: 17 }, internal.workspaces.sweepCleanup, {});

export default crons;
