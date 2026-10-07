import { v } from "convex/values";

/** A backup agent of a profile, tried in order when the ones before it cannot run. */
export const agentBackup = v.object({
  runtime: v.string(),
  model: v.optional(v.string()),
  reasoningEffort: v.optional(v.string()),
});
export const MAX_BACKUPS = 2;
