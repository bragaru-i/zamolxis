import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { fail, load, requireNode, requireUser } from "./lib/access";

// Same limits as the Node (packages/node-core/src/control-plane/proof.ts).
export const PROOF_MAX_FILES = 8;
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const KIND = "proof_image";

async function nodeRun(
  ctx: MutationCtx,
  workstationId: Id<"workstations">,
  runId: Id<"agentRuns">,
) {
  const device = await requireNode(ctx, workstationId);
  const run = await load(ctx, "agentRuns", runId);
  if (run.workstationId !== device._id) fail("FORBIDDEN");
  return run;
}

async function proofOf(ctx: MutationCtx, runId: Id<"agentRuns">) {
  return (
    await ctx.db
      .query("artifacts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(100)
  ).filter((row) => row.kind === KIND);
}

/** A one-time upload address for one proof image of a run this Node executes. */
export const uploadUrl = mutation({
  args: { workstationId: v.id("workstations"), runId: v.id("agentRuns") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await nodeRun(ctx, args.workstationId, args.runId);
    if ((await proofOf(ctx, args.runId)).length >= PROOF_MAX_FILES) fail("LIMIT_EXCEEDED");
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Records an uploaded proof image. The stored file's own size and type are checked (not the
 * Node's claim); a file that breaks the limits is deleted. Idempotent per run and content.
 */
export const record = mutation({
  args: {
    workstationId: v.id("workstations"),
    runId: v.id("agentRuns"),
    storageId: v.id("_storage"),
    name: v.string(),
    source: v.union(v.literal("proof"), v.literal("changed")),
    contentType: v.string(),
  },
  // "rejected" is a result, not an error: the file is deleted and the delete must persist.
  returns: v.union(v.literal("recorded"), v.literal("duplicate"), v.literal("rejected")),
  handler: async (ctx, args) => {
    const run = await nodeRun(ctx, args.workstationId, args.runId);
    const stored = await ctx.db.system.get(args.storageId);
    if (!stored) fail("NOT_FOUND");
    const existing = await proofOf(ctx, run._id);
    const same = existing.find((row) => row.metadata?.sha256 === stored.sha256);
    if (same) {
      if (same.locator !== args.storageId) await ctx.storage.delete(args.storageId);
      return "duplicate";
    }
    // The type the storage recorded from the upload wins over the Node's declaration.
    const contentType = stored.contentType ?? args.contentType;
    const name = args.name.trim().slice(0, 200);
    if (
      !name ||
      existing.length >= PROOF_MAX_FILES ||
      stored.size > PROOF_MAX_BYTES ||
      !PROOF_TYPES.has(contentType) ||
      !PROOF_TYPES.has(args.contentType)
    ) {
      await ctx.storage.delete(args.storageId);
      return "rejected";
    }
    await ctx.db.insert("artifacts", {
      workSessionId: run.workSessionId,
      taskId: run.taskId,
      runId: run._id,
      kind: KIND,
      name,
      storage: "convex_storage",
      locator: args.storageId,
      metadata: { source: args.source, contentType, size: stored.size, sha256: stored.sha256 },
      createdAt: Date.now(),
    });
    return "recorded";
  },
});

export interface ProofImage {
  _id: Id<"artifacts">;
  runId: Id<"agentRuns">;
  taskId?: Id<"tasks">;
  name: string;
  source: "proof" | "changed";
  url: string;
  createdAt: number;
}

/** Proof images of a Session, for its owner only, with short-lived download addresses. */
export const listForSession = query({
  args: { workSessionId: v.id("workSessions") },
  returns: v.array(v.any()),
  handler: async (ctx, args): Promise<ProofImage[]> => {
    const owner = await requireUser(ctx);
    const session = await ctx.db.get(args.workSessionId);
    if (!session || session.ownerId !== owner._id) fail("FORBIDDEN");
    const rows = (
      await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("workSessionId", args.workSessionId))
        .take(500)
    ).filter((row): row is Doc<"artifacts"> & { runId: Id<"agentRuns"> } =>
      Boolean(row.kind === KIND && row.runId),
    );
    const images: ProofImage[] = [];
    for (const row of rows) {
      const url = await ctx.storage.getUrl(row.locator as Id<"_storage">);
      if (!url) continue;
      images.push({
        _id: row._id,
        runId: row.runId,
        ...(row.taskId ? { taskId: row.taskId } : {}),
        name: row.name,
        source: row.metadata?.source === "changed" ? "changed" : "proof",
        url,
        createdAt: row.createdAt,
      });
    }
    return images;
  },
});
