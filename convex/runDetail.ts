// Owner-scoped read model for the Run detail view (historical inspection, Level 2/3).
// Everything is reached from one owned run; linked runs must share its Work Session.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { ownRun } from "./lib/access";

const MAX_VERIFICATIONS = 8;
const MAX_EVIDENCE = 32;
const MAX_DECISIONS = 5;
const MAX_SCANNED_EVENTS = 2000;
const MAX_PATHS = 200;
const REPAIR_LIMIT = 2;

function evidenceView(record: Doc<"evidence">) {
  return {
    modality: record.modality,
    result: record.result,
    summary: record.summary,
    subjectSha: record.subjectSha,
    createdAt: record.createdAt,
  };
}

export const get = query({
  args: { runId: v.id("agentRuns") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const run = await ownRun(ctx, args.runId);
    const task = await ctx.db.get("tasks", run.taskId);
    const workspace = await ctx.db.get("workspaces", run.workspaceId);
    const role = run.role ?? "builder";
    const links =
      role === "verifier"
        ? await ctx.db
            .query("verificationRuns")
            .withIndex("by_verifier", (q) => q.eq("verifierRunId", run._id))
            .take(1)
        : await ctx.db
            .query("verificationRuns")
            .withIndex("by_candidate", (q) => q.eq("candidateRunId", run._id))
            .order("desc")
            .take(MAX_VERIFICATIONS);
    const verifications = [];
    for (const link of links) {
      const verifier = await ctx.db.get("agentRuns", link.verifierRunId);
      const candidate = await ctx.db.get("agentRuns", link.candidateRunId);
      // Provenance links are created server-side within one session; refuse anything else.
      if (
        !verifier ||
        !candidate ||
        verifier.workSessionId !== run.workSessionId ||
        candidate.workSessionId !== run.workSessionId
      )
        continue;
      const evidence = await ctx.db
        .query("evidence")
        .withIndex("by_verification", (q) => q.eq("verificationRunId", link._id))
        .take(MAX_EVIDENCE);
      verifications.push({
        _id: link._id,
        subjectSha: link.subjectSha,
        createdAt: link.createdAt,
        candidateRunId: candidate._id,
        candidateRole: candidate.role ?? "builder",
        verifierRunId: verifier._id,
        verifierStatus: verifier.status,
        evidence: evidence.map(evidenceView),
      });
    }
    const candidateRunId = role === "verifier" ? verifications[0]?.candidateRunId : run._id;
    const decisions = candidateRunId
      ? await ctx.db
          .query("trustDecisions")
          .withIndex("by_candidate", (q) => q.eq("candidateRunId", candidateRunId))
          .order("desc")
          .take(MAX_DECISIONS)
      : [];
    return {
      run: {
        _id: run._id,
        _creationTime: run._creationTime,
        taskId: run.taskId,
        role,
        status: run.status,
        runtime: run.runtime,
        runtimeVersion: run.runtimeVersion,
        agentProfileRevision: run.agentProfileRevision,
        instructionsDigest: run.instructionsDigest,
        modelRequested: run.modelRequested,
        modelActual: run.modelActual,
        reasoningEffort: run.reasoningEffort,
        inputTokens: run.inputTokens,
        cachedInputTokens: run.cachedInputTokens,
        cacheWriteInputTokens: run.cacheWriteInputTokens,
        outputTokens: run.outputTokens,
        reasoningOutputTokens: run.reasoningOutputTokens,
        totalTokens: run.totalTokens,
        modelCalls: run.modelCalls,
        estimatedCostUsd: run.estimatedCostUsd,
        attempt: run.attempt,
        parentRunId: run.parentRunId,
        activityLabel: run.activityLabel,
        resultSummary: run.resultSummary,
        exitReason: run.exitReason,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        lastActivityAt: run.lastActivityAt,
        initialHeadSha: run.initialHeadSha,
        finalHeadSha: run.finalHeadSha,
        finalDirty: run.finalDirty,
        finalChangedFileCount: run.finalChangedFileCount,
      },
      task: task
        ? {
            title: task.title,
            status: task.status,
            phase: task.phase,
            repairAttempts: task.repairAttempts ?? 0,
            repairLimit: REPAIR_LIMIT,
            requiredModalities: task.requiredModalities ?? ["static", "behavioral"],
            failureReason: task.failureReason,
          }
        : null,
      workspace: workspace
        ? {
            kind: workspace.kind,
            status: workspace.status,
            baseRef: workspace.baseRef,
            baseSha: workspace.baseSha,
            branchName: workspace.branchName,
            currentHeadSha: workspace.currentHeadSha,
          }
        : null,
      verifications,
      trustDecisions: decisions.map((decision) => ({
        _id: decision._id,
        candidateRunId: decision.candidateRunId,
        subjectSha: decision.subjectSha,
        eligible: decision.eligible,
        reasons: decision.reasons,
        createdAt: decision.createdAt,
      })),
    };
  },
});

// Distinct paths reported by files.changed events, oldest first. Bounded scan.
export const changedFiles = query({
  args: { runId: v.id("agentRuns") },
  returns: v.object({
    paths: v.array(v.string()),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await ownRun(ctx, args.runId);
    const paths = new Set<string>();
    let scanned = 0;
    let truncated = false;
    for await (const event of ctx.db
      .query("runEvents")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))) {
      if (++scanned > MAX_SCANNED_EVENTS) {
        truncated = true;
        break;
      }
      if (event.type !== "files.changed" || !Array.isArray(event.payload?.paths)) continue;
      for (const path of event.payload.paths) {
        if (typeof path !== "string" || !path) continue;
        if (paths.size >= MAX_PATHS && !paths.has(path)) {
          truncated = true;
          continue;
        }
        paths.add(path);
      }
    }
    return { paths: [...paths], truncated };
  },
});
