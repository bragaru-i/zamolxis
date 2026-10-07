import { publishBranchName } from "@zamolxis/application";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, load, ownSession, requireNode } from "./lib/access";
import { enqueue } from "./lib/commands";
import { recordPublishStep } from "./traces";

// Publishing pushes a trusted integration branch and opens a pull request on the owner's
// explicit action. It never merges and never targets the default branch: merge stays human.
const MAX_PUBLISH_ATTEMPTS = 10;
const BASE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const FOOTER = "Opened by Zamolxis; merge is a human decision.";

interface Publishable {
  workspace: Doc<"workspaces">;
  decision: Doc<"trustDecisions">;
  base?: string;
}

// The task is complete on a local integration branch at exactly the trusted commit.
async function publishable(ctx: QueryCtx, task: Doc<"tasks">): Promise<Publishable | undefined> {
  const session = await load(ctx, "workSessions", task.workSessionId);
  if (
    session.status === "cancelled" ||
    task.status !== "completed" ||
    task.phase !== "completed" ||
    !task.integrationWorkspaceId ||
    !task.trustDecisionId
  )
    return undefined;
  const decision = await load(ctx, "trustDecisions", task.trustDecisionId);
  const workspace = await load(ctx, "workspaces", task.integrationWorkspaceId);
  const sha = decision.subjectSha;
  if (
    !decision.eligible ||
    decision.candidateRunId !== task.candidateRunId ||
    !/^[a-f0-9]{40,64}$/.test(sha) ||
    workspace.kind !== "integration" ||
    workspace.taskId !== task._id ||
    !["ready", "completed"].includes(workspace.status) ||
    workspace.dirty ||
    workspace.baseSha !== sha ||
    workspace.currentHeadSha !== sha
  )
    return undefined;
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .take(50);
  if (!artifacts.some((item) => item.kind === "integration_branch" && item.locator === sha))
    return undefined;
  const location = await load(ctx, "repositoryLocations", workspace.repositoryLocationId);
  const base = location.defaultBranch;
  return { workspace, decision, ...(base && BASE.test(base) ? { base } : {}) };
}

const CHECK_NAMES: Record<string, string> = {
  static: "Code hygiene",
  test: "Tests",
  behavioral: "Behaviour",
};
// Commit ids are shown short: the Node's secret filter hides any 32+ hex run (a full SHA).
const shortSha = (sha: string) => sha.slice(0, 12);
const oneLine = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * A pull request description for a reviewer: what the agents changed (in their own words),
 * the owner's request folded away, the checks in plain words, and the trusted commit.
 */
export function pullRequestText(input: {
  readonly request: string;
  readonly builder?: string;
  readonly repairs: readonly string[];
  readonly evidence: readonly { modality: string; result: string; summary: string }[];
  readonly sha: string;
  readonly reasons: readonly string[];
}): string {
  const summary = input.builder?.trim();
  return [
    "## Summary",
    summary ? summary.slice(0, 3000) : oneLine(input.request, 600),
    ...input.repairs
      .filter((text) => text.trim())
      .slice(-2)
      .flatMap((text) => ["", `**Fixed after a failed check:** ${text.trim().slice(0, 1500)}`]),
    "",
    "## Checks",
    ...(input.evidence.length
      ? input.evidence.map(
          (item) =>
            `- ${item.result === "passed" ? "✅" : "❌"} ${CHECK_NAMES[item.modality] ?? item.modality}: ${oneLine(item.summary, 200)}`,
        )
      : ["- No checks were recorded."]),
    "",
    "<details><summary>What was requested</summary>",
    "",
    input.request.slice(0, 4000),
    "",
    "</details>",
    "",
    `Checked independently at \`${shortSha(input.sha)}\`${
      input.reasons.length
        ? ` (${input.reasons
            .slice(0, 3)
            .map((reason) => oneLine(reason, 120))
            .join("; ")})`
        : ""
    }. ${FOOTER}`,
  ].join("\n");
}

async function pullRequestBody(ctx: QueryCtx, task: Doc<"tasks">, decision: Doc<"trustDecisions">) {
  // Earlier verification failures appended for repair are history, not the change.
  const request = task.description.split("\n\nVerification failure:")[0]?.trim() ?? "";
  const verificationRunId = task.verificationRunId;
  const evidence = verificationRunId
    ? await ctx.db
        .query("evidence")
        .withIndex("by_verification", (q) => q.eq("verificationRunId", verificationRunId))
        .take(16)
    : [];
  // The agents' own final words: the Builder's, then any Repair that followed it.
  const runs = (
    await ctx.db
      .query("agentRuns")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .take(50)
  )
    .filter((run) => run.status === "completed" && run.resultSummary?.trim())
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const builder = runs.filter((run) => (run.role ?? "builder") === "builder").at(-1);
  const repairs = runs
    .filter((run) => run.role === "repair" && (run.completedAt ?? 0) >= (builder?.completedAt ?? 0))
    .map((run) => run.resultSummary ?? "");
  return pullRequestText({
    request,
    ...(builder?.resultSummary ? { builder: builder.resultSummary } : {}),
    repairs,
    evidence,
    sha: decision.subjectSha,
    reasons: decision.reasons,
  });
}

export const publication = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await load(ctx, "tasks", args.taskId);
    await ownSession(ctx, task.workSessionId);
    const ready = await publishable(ctx, task);
    return {
      ready: ready !== undefined,
      status: task.publishStatus ?? "none",
      title: task.title,
      branch:
        task.publishBranch ??
        (ready ? publishBranchName(task.title, ready.decision.subjectSha) : undefined),
      base: task.publishBase ?? ready?.base,
      ...(task.prUrl ? { prUrl: task.prUrl } : {}),
      ...(task.compareUrl ? { compareUrl: task.compareUrl } : {}),
      ...(task.publishError ? { error: task.publishError } : {}),
    };
  },
});

/** The owner asks to publish a trusted task; the Node holding its integration branch does it. */
export const publish = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.object({ status: v.string(), branch: v.string() }),
  handler: async (ctx, args) => {
    const task = await load(ctx, "tasks", args.taskId);
    await ownSession(ctx, task.workSessionId);
    // Idempotent: an in-flight or finished publication is the answer to a repeated request.
    if (
      (task.publishStatus === "pending" || task.publishStatus === "published") &&
      task.publishBranch
    )
      return { status: task.publishStatus, branch: task.publishBranch };
    const ready = await publishable(ctx, task);
    if (!ready) fail("PUBLISH_NOT_READY", "Only trusted, integrated work can be published");
    const attempt = (task.publishAttempts ?? 0) + 1;
    if (attempt > MAX_PUBLISH_ATTEMPTS) fail("LIMIT_EXCEEDED");
    const sha = ready.decision.subjectSha;
    const branch = publishBranchName(task.title, sha);
    const payload = {
      taskId: task._id,
      workspaceId: ready.workspace._id,
      branch,
      ...(ready.base ? { base: ready.base } : {}),
      subjectSha: sha,
      title: task.title.slice(0, 200),
      body: await pullRequestBody(ctx, task, ready.decision),
    };
    const commandId = await enqueue(
      ctx,
      ready.workspace.workstationId,
      "integration.publish",
      "task",
      task._id,
      payload,
      `publish:${task._id}:${attempt}`,
    );
    await ctx.db.patch("tasks", task._id, {
      publishStatus: "pending",
      publishBranch: branch,
      ...(ready.base ? { publishBase: ready.base } : {}),
      publishCommandId: commandId,
      publishAttempts: attempt,
      publishError: undefined,
      updatedAt: Date.now(),
    });
    await recordPublishStep(ctx, ready.decision.candidateRunId, commandId, {
      status: "started",
      branch,
      sha,
    });
    return { status: "pending", branch };
  },
});

function link(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 512 || !/^https:\/\/[^\s/@]+\/\S*$/.test(value)) fail("INVALID_ARGUMENT");
  return value;
}

/** The Node reports a pushed branch (and pull request) for the publish command it ran. */
export const completePublish = mutation({
  args: {
    workstationId: v.id("workstations"),
    commandId: v.id("commands"),
    taskId: v.id("tasks"),
    subjectSha: v.string(),
    remoteBranch: v.string(),
    base: v.string(),
    prUrl: v.optional(v.string()),
    compareUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const command = await load(ctx, "commands", args.commandId);
    const task = await load(ctx, "tasks", args.taskId);
    const payload = command.payload as { branch?: unknown; subjectSha?: unknown; base?: unknown };
    if (
      command.workstationId !== args.workstationId ||
      command.type !== "integration.publish" ||
      command.targetId !== task._id ||
      !["claimed", "acknowledged", "completed"].includes(command.status) ||
      payload.subjectSha !== args.subjectSha ||
      payload.branch !== args.remoteBranch ||
      (payload.base !== undefined && payload.base !== args.base) ||
      !BASE.test(args.base) ||
      task.publishCommandId !== command._id
    )
      fail("INVALID_PUBLISH_PROVENANCE");
    const prUrl = link(args.prUrl);
    const compareUrl = link(args.compareUrl);
    if (task.publishStatus === "published") return null;
    await ctx.db.patch("tasks", task._id, {
      publishStatus: "published",
      publishBase: args.base,
      publishError: undefined,
      ...(prUrl ? { prUrl } : {}),
      ...(compareUrl ? { compareUrl } : {}),
      publishedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (task.candidateRunId)
      await recordPublishStep(ctx, task.candidateRunId, command._id, {
        status: "passed",
        branch: args.remoteBranch,
        base: args.base,
        sha: args.subjectSha,
        prUrl,
        compareUrl,
      });
    return null;
  },
});

/** A failed publish leaves the trusted local branch as it was; the owner can retry. */
export async function failPublish(ctx: MutationCtx, command: Doc<"commands">, code: string) {
  const id = ctx.db.normalizeId("tasks", command.targetId);
  if (!id) return;
  const task = await load(ctx, "tasks", id);
  if (task.publishCommandId !== command._id || task.publishStatus !== "pending") return;
  await ctx.db.patch("tasks", task._id, {
    publishStatus: "failed",
    publishError: code.slice(0, 64),
    updatedAt: Date.now(),
  });
  if (task.candidateRunId)
    await recordPublishStep(ctx, task.candidateRunId, command._id, {
      status: "failed",
      code: code.slice(0, 64),
    });
}

/** A publish command is complete once its result was recorded. */
export async function publishRecorded(ctx: QueryCtx, command: Doc<"commands">) {
  const id = ctx.db.normalizeId("tasks", command.targetId);
  if (!id) return false;
  const task = await load(ctx, "tasks", id);
  return task.publishCommandId === command._id && task.publishStatus === "published";
}
