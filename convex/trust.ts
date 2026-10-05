import { evaluateTrust, type TrustEvidence } from "@zamolxis/application";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { bounded, fail, load, nodeRun, ownRun } from "./lib/access";
export const linkVerification = internalMutation({
  args: { candidateRunId: v.id("agentRuns"), verifierRunId: v.id("agentRuns") },
  returns: v.id("verificationRuns"),
  handler: async (ctx, args) => {
    const candidate = await load(ctx, "agentRuns", args.candidateRunId);
    const verifier = await load(ctx, "agentRuns", args.verifierRunId);
    const workspace = await load(ctx, "workspaces", verifier.workspaceId);
    if (
      !["builder", "repair"].includes(candidate.role ?? "builder") ||
      candidate.status !== "completed" ||
      !candidate.finalHeadSha ||
      verifier.role !== "verifier" ||
      verifier._id === candidate._id ||
      verifier.workspaceId === candidate.workspaceId ||
      verifier.workSessionId !== candidate.workSessionId ||
      workspace.baseSha !== candidate.finalHeadSha
    )
      fail("INVALID_VERIFICATION_PROVENANCE");
    const previous = await ctx.db
      .query("verificationRuns")
      .withIndex("by_verifier", (q) => q.eq("verifierRunId", verifier._id))
      .unique();
    if (previous) {
      if (
        previous.candidateRunId !== candidate._id ||
        previous.subjectSha !== candidate.finalHeadSha
      )
        fail("COMMAND_CONFLICT");
      return previous._id;
    }
    return ctx.db.insert("verificationRuns", {
      candidateRunId: candidate._id,
      verifierRunId: verifier._id,
      subjectSha: candidate.finalHeadSha,
      createdAt: Date.now(),
    });
  },
});
export const recordEvidence = mutation({
  args: {
    workstationId: v.id("workstations"),
    verificationRunId: v.id("verificationRuns"),
    modality: v.union(
      v.literal("static"),
      v.literal("test"),
      v.literal("behavioral"),
      v.literal("visual"),
      v.literal("interaction"),
      v.literal("mutation"),
      v.literal("security"),
    ),
    result: v.union(v.literal("passed"), v.literal("failed")),
    summary: v.string(),
  },
  returns: v.id("evidence"),
  handler: async (ctx, args) => {
    const verification = await load(ctx, "verificationRuns", args.verificationRunId);
    const verifier = await nodeRun(ctx, args.workstationId, verification.verifierRunId);
    const workspace = await load(ctx, "workspaces", verifier.workspaceId);
    if (
      verifier.role !== "verifier" ||
      verifier.status !== "completed" ||
      verifier.finalHeadSha !== verification.subjectSha ||
      workspace.currentHeadSha !== verification.subjectSha ||
      workspace.dirty ||
      args.summary.length > 8192
    )
      fail("INVALID_VERIFICATION_PROVENANCE");
    const evidence = await ctx.db
      .query("evidence")
      .withIndex("by_verification", (q) => q.eq("verificationRunId", verification._id))
      .take(33);
    if (evidence.length >= 32) fail("LIMIT_EXCEEDED");
    const duplicate = evidence.find((item) => item.modality === args.modality);
    if (duplicate) {
      if (duplicate.result !== args.result || duplicate.summary !== args.summary)
        fail("COMMAND_CONFLICT");
      return duplicate._id;
    }
    return ctx.db.insert("evidence", {
      verificationRunId: verification._id,
      verifierRunId: verifier._id,
      subjectSha: verification.subjectSha,
      modality: args.modality,
      result: args.result,
      summary: args.summary,
      createdAt: Date.now(),
    });
  },
});
export const evaluate = internalMutation({
  args: { candidateRunId: v.id("agentRuns") },
  returns: v.id("trustDecisions"),
  handler: async (ctx, args) => {
    const candidate = await load(ctx, "agentRuns", args.candidateRunId);
    const workspace = await load(ctx, "workspaces", candidate.workspaceId);
    const evidence: TrustEvidence[] = [];
    const verifications = await ctx.db
      .query("verificationRuns")
      .withIndex("by_candidate", (q) => q.eq("candidateRunId", candidate._id))
      .take(33);
    if (verifications.length > 32) fail("LIMIT_EXCEEDED");
    for (const verification of verifications) {
      const verifier = await load(ctx, "agentRuns", verification.verifierRunId);
      const verifiedWorkspace = await load(ctx, "workspaces", verifier.workspaceId);
      if (
        verifier.role !== "verifier" ||
        verifier.status !== "completed" ||
        verifier.finalHeadSha !== verification.subjectSha ||
        verifiedWorkspace.currentHeadSha !== verification.subjectSha ||
        verifiedWorkspace.dirty
      )
        continue;
      const records = await ctx.db
        .query("evidence")
        .withIndex("by_verification", (q) => q.eq("verificationRunId", verification._id))
        .take(33);
      if (records.length > 32) fail("LIMIT_EXCEEDED");
      for (const record of records) evidence.push({ ...record, origin: "independent-verifier" });
    }
    const task = await load(ctx, "tasks", candidate.taskId);
    const decision = evaluateTrust(
      candidate._id,
      candidate.finalHeadSha ?? "",
      evidence,
      task.requiredModalities ?? ["static", "behavioral"],
    );
    if (
      !["builder", "repair"].includes(candidate.role ?? "builder") ||
      candidate.status !== "completed" ||
      !candidate.finalHeadSha ||
      workspace.currentHeadSha !== candidate.finalHeadSha ||
      workspace.dirty
    ) {
      decision.eligible = false;
      decision.reasons.push("Candidate snapshot is incomplete or stale");
    }
    return ctx.db.insert("trustDecisions", {
      candidateRunId: candidate._id,
      subjectSha: candidate.finalHeadSha ?? "",
      ...decision,
      createdAt: Date.now(),
    });
  },
});
export const listByRun = query({
  args: { runId: v.id("agentRuns"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await ownRun(ctx, args.runId);
    return ctx.db
      .query("trustDecisions")
      .withIndex("by_candidate", (q) => q.eq("candidateRunId", args.runId))
      .order("desc")
      .take(bounded(args.limit ?? 20));
  },
});
