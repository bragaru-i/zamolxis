import { applyRunEvent, GITHUB_LOGIN } from "@zamolxis/application";
import { assertRunTransition, type RunStatus } from "@zamolxis/domain";
import {
  boundRuntimeModels,
  RUNTIME_MODEL_LIMITS,
  USAGE_COUNTERS,
  type UsageCounter,
} from "@zamolxis/runtime-core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { applyApprovalEvent, expireRunApprovals } from "./approvals";
import { failPublish, publishRecorded } from "./integration";
import { bounded, fail, load, nodeRun, requireNode } from "./lib/access";
import { boundFailure, failureDetail } from "./lib/failure";
import { decideVerification, refreshSession } from "./lib/lifecycle";
import { canonicalRepository } from "./lib/repositories";
import { recordCleanupFailure, recordCleanupRemoved } from "./lib/retention";
import { refreshDependents, settleRun } from "./lib/settlement";
import { valueKey } from "./lib/value";
import { settleFailedAnswer } from "./orchestrator";
import { githubAccess, runtimeModel } from "./schema";
import { settleStoppedText } from "./supervisor";
import { recordIntegrationStep } from "./traces";

const deviceArgs = { workstationId: v.id("workstations") };
// Mirrors RUN_MESSAGE_LIMIT in packages/contracts/src/events/event.ts.
export const RUN_MESSAGE_LIMIT = 2000;
export const heartbeat = mutation({
  args: {
    ...deviceArgs,
    instanceId: v.string(),
    // The commit the Node runs from ("<sha>" or "<sha>+dirty"), so Settings → Computers can
    // show whether a computer was restarted on the current main.
    nodeVersion: v.optional(v.string()),
    // Node.js `process.platform` / `process.arch`, so the app can say which kind of computer.
    platform: v.optional(v.string()),
    architecture: v.optional(v.string()),
    runtimeCapabilities: v.array(
      v.object({
        runtime: v.string(),
        capabilities: v.array(v.string()),
        version: v.optional(v.string()),
        models: v.optional(v.array(runtimeModel)),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    if (args.runtimeCapabilities.length > 32) fail("INVALID_ARGUMENT");
    for (const advertised of args.runtimeCapabilities)
      if ((advertised.models?.length ?? 0) > RUNTIME_MODEL_LIMITS.models) fail("INVALID_ARGUMENT");
    if ((args.platform?.length ?? 0) > 32 || (args.architecture?.length ?? 0) > 32)
      fail("INVALID_ARGUMENT");
    if (args.nodeVersion !== undefined && !/^[\x21-\x7e]{1,64}$/.test(args.nodeVersion))
      fail("INVALID_ARGUMENT");
    await ctx.db.patch("workstations", args.workstationId, {
      nodeInstanceId: args.instanceId,
      status: "online",
      lastHeartbeatAt: Date.now(),
      ...(args.nodeVersion ? { nodeVersion: args.nodeVersion } : {}),
      ...(args.platform ? { platform: args.platform } : {}),
      ...(args.architecture ? { architecture: args.architecture } : {}),
    });
    if (
      new Set(args.runtimeCapabilities.map((item) => item.runtime)).size !==
      args.runtimeCapabilities.length
    )
      fail("INVALID_ARGUMENT");
    const previous = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation", (q) => q.eq("workstationId", args.workstationId))
      .take(33);
    if (previous.length > 32) fail("LIMIT_EXCEEDED");
    for (const installation of previous)
      if (!args.runtimeCapabilities.some((item) => item.runtime === installation.runtime))
        await ctx.db.patch("runtimeInstallations", installation._id, { status: "unavailable" });
    for (const advertised of args.runtimeCapabilities) {
      const existing = await ctx.db
        .query("runtimeInstallations")
        .withIndex("by_workstation_runtime", (q) =>
          q.eq("workstationId", args.workstationId).eq("runtime", advertised.runtime),
        )
        .unique();
      const patch = {
        capabilities: advertised.capabilities,
        ...(advertised.version ? { version: advertised.version } : {}),
        status: "available" as const,
        detectedAt: Date.now(),
        // Only a heartbeat that reports models replaces the stored list.
        ...(advertised.models
          ? {
              models: boundRuntimeModels(advertised.models).map(({ efforts, ...model }) => ({
                ...model,
                ...(efforts ? { efforts: [...efforts] } : {}),
              })),
              modelsUpdatedAt: Date.now(),
            }
          : {}),
      };
      if (existing) await ctx.db.patch("runtimeInstallations", existing._id, patch);
      else
        await ctx.db.insert("runtimeInstallations", {
          workstationId: args.workstationId,
          runtime: advertised.runtime,
          ...patch,
        });
    }
    return null;
  },
});
export const registerLocation = mutation({
  args: {
    ...deviceArgs,
    repositoryId: v.id("repositories"),
    canonicalPath: v.string(),
    gitCommonDir: v.string(),
    headSha: v.string(),
    defaultBranch: v.optional(v.string()),
  },
  returns: v.id("repositoryLocations"),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    // A Node set up before two entries for this remote were merged still names the old one.
    const repository = await canonicalRepository(ctx, args.repositoryId);
    if (repository.ownerId !== device.ownerId) fail("FORBIDDEN");
    const existing = await ctx.db
      .query("repositoryLocations")
      .withIndex("by_repository_workstation", (q) =>
        q.eq("repositoryId", repository._id).eq("workstationId", args.workstationId),
      )
      .unique();
    const metadata = {
      canonicalPath: args.canonicalPath,
      gitCommonDir: args.gitCommonDir,
      lastKnownHead: args.headSha,
      // A removed location stays removed until setup re-grants it (#45).
      status: existing?.status === "removed" ? ("removed" as const) : ("available" as const),
      verifiedAt: Date.now(),
      updatedAt: Date.now(),
      ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    };
    if (existing) {
      await ctx.db.patch("repositoryLocations", existing._id, metadata);
      return existing._id;
    }
    return ctx.db.insert("repositoryLocations", {
      repositoryId: repository._id,
      workstationId: args.workstationId,
      ...metadata,
    });
  },
});
const DAY = 24 * 60 * 60 * 1000;
// The Node reports a repository's GitHub publishing access on this computer: status, credential
// source (its token or its gh account), login and token expiry only. Bounded and
// owner-isolated; no credential ever leaves the computer.
export const reportGithubAccess = mutation({
  args: { ...deviceArgs, repositoryId: v.id("repositories"), access: githubAccess },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    const repository = await canonicalRepository(ctx, args.repositoryId);
    if (repository.ownerId !== device.ownerId) fail("FORBIDDEN");
    const location = await ctx.db
      .query("repositoryLocations")
      .withIndex("by_repository_workstation", (q) =>
        q.eq("repositoryId", repository._id).eq("workstationId", args.workstationId),
      )
      .unique();
    if (!location) fail("NOT_FOUND");
    const now = Date.now();
    const { status, source, login, expiresAt, checkedAt } = args.access;
    if (login !== undefined && !GITHUB_LOGIN.test(login)) fail("INVALID_ARGUMENT");
    if (
      expiresAt !== undefined &&
      (!Number.isFinite(expiresAt) || expiresAt < 0 || expiresAt > now + 400 * DAY)
    )
      fail("INVALID_ARGUMENT");
    if (!Number.isFinite(checkedAt)) fail("INVALID_ARGUMENT");
    // An older check never replaces a newer one (setup and the daemon both report).
    if (location.githubAccess && location.githubAccess.checkedAt > Math.min(checkedAt, now))
      return null;
    await ctx.db.patch("repositoryLocations", location._id, {
      githubAccess: {
        status,
        ...(source ? { source } : {}),
        ...(login ? { login } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        checkedAt: Math.min(checkedAt, now),
      },
    });
    return null;
  },
});
export const verifyLocation = mutation({
  args: {
    ...deviceArgs,
    repositoryLocationId: v.id("repositoryLocations"),
    status: v.union(v.literal("available"), v.literal("missing"), v.literal("invalid")),
    headSha: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const location = await load(ctx, "repositoryLocations", args.repositoryLocationId);
    if (location.workstationId !== args.workstationId) fail("FORBIDDEN");
    if (location.status === "removed") return null;
    await ctx.db.patch("repositoryLocations", location._id, {
      status: args.status,
      verifiedAt: Date.now(),
      updatedAt: Date.now(),
      ...(args.headSha ? { lastKnownHead: args.headSha } : {}),
    });
    return null;
  },
});
export const listPending = query({
  args: { ...deviceArgs, limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    return ctx.db
      .query("commands")
      .withIndex("by_workstation_status", (q) =>
        q.eq("workstationId", args.workstationId).eq("status", "pending"),
      )
      .take(bounded(args.limit ?? 50));
  },
});
export const claim = mutation({
  args: { ...deviceArgs, commandId: v.id("commands"), instanceId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    if (device.nodeInstanceId !== args.instanceId) fail("FORBIDDEN");
    const command = await load(ctx, "commands", args.commandId);
    if (command.workstationId !== device._id) fail("FORBIDDEN");
    if (command.status !== "pending") {
      if (
        command.claimNodeInstanceId === args.instanceId &&
        ["claimed", "acknowledged", "completed"].includes(command.status)
      )
        return command;
      fail("COMMAND_CONFLICT");
    }
    if (command.expiresAt !== undefined && command.expiresAt <= Date.now()) fail("INVALID_STATE");
    if (command.type === "runtime.start") {
      const runId = ctx.db.normalizeId("agentRuns", command.targetId);
      if (!runId) fail("INVALID_ARGUMENT");
      const run = await nodeRun(ctx, device._id, runId);
      assertRunTransition(run.status, "starting");
      await ctx.db.patch("agentRuns", run._id, { status: "starting" });
    }
    if (command.type === "workspace.provision") {
      const workspaceId = ctx.db.normalizeId("workspaces", command.targetId);
      if (!workspaceId) fail("INVALID_ARGUMENT");
      const workspace = await load(ctx, "workspaces", workspaceId);
      if (workspace.workstationId !== device._id || workspace.status !== "requested")
        fail("INVALID_STATE");
      await ctx.db.patch("workspaces", workspace._id, {
        status: "provisioning",
        updatedAt: Date.now(),
      });
    }
    await ctx.db.patch("commands", command._id, {
      status: "claimed",
      claimNodeInstanceId: args.instanceId,
      claimedAt: Date.now(),
    });
    return load(ctx, "commands", command._id);
  },
});
export const acknowledge = mutation({
  args: { ...deviceArgs, commandId: v.id("commands"), instanceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    if (device.nodeInstanceId !== args.instanceId) fail("FORBIDDEN");
    const command = await load(ctx, "commands", args.commandId);
    if (
      command.workstationId !== args.workstationId ||
      command.claimNodeInstanceId !== args.instanceId
    )
      fail("FORBIDDEN");
    if (command.status === "acknowledged" || command.status === "completed") return null;
    if (command.status !== "claimed") fail("INVALID_STATE");
    await ctx.db.patch("commands", command._id, {
      status: "acknowledged",
      acknowledgedAt: Date.now(),
    });
    return null;
  },
});
export const completeCommand = mutation({
  args: {
    ...deviceArgs,
    commandId: v.id("commands"),
    instanceId: v.string(),
    result: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    if (device.nodeInstanceId !== args.instanceId) fail("FORBIDDEN");
    const command = await load(ctx, "commands", args.commandId);
    if (
      command.workstationId !== args.workstationId ||
      command.claimNodeInstanceId !== args.instanceId
    )
      fail("FORBIDDEN");
    if (args.result !== undefined && JSON.stringify(args.result).length > 16384)
      fail("INVALID_ARGUMENT");
    if (command.status === "completed") return null;
    if (!["claimed", "acknowledged"].includes(command.status)) fail("INVALID_STATE");
    await ctx.db.patch("commands", command._id, {
      status: "completed",
      completedAt: Date.now(),
      ...(args.result !== undefined ? { result: args.result } : {}),
    });
    return null;
  },
});
export const failCommand = mutation({
  args: {
    ...deviceArgs,
    commandId: v.id("commands"),
    instanceId: v.string(),
    code: v.string(),
    failure: v.optional(failureDetail),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    if (device.nodeInstanceId !== args.instanceId) fail("FORBIDDEN");
    const command = await load(ctx, "commands", args.commandId);
    // The current instance of this Node may fail a command an earlier instance claimed:
    // after a restart it reports what was interrupted (for example SUPERVISOR_INTERRUPTED).
    // Only the registered instance gets here (checked above), so a replaced one cannot.
    if (command.workstationId !== args.workstationId) fail("FORBIDDEN");
    if (command.status === "failed") return null;
    if (!["claimed", "acknowledged"].includes(command.status)) fail("INVALID_STATE");
    const failure = args.failure ? boundFailure(args.failure) : undefined;
    await ctx.db.patch("commands", command._id, {
      status: "failed",
      error: args.code,
      completedAt: Date.now(),
      ...(failure ? { failure } : {}),
    });
    // A failed publication is reported on the task; the trusted work itself is unaffected.
    if (command.type === "integration.publish") {
      await failPublish(ctx, command, args.code);
      return null;
    }
    // Without a model reply the deterministic answer stands; no Session needs input.
    if (command.type === "orchestrator.answer") {
      await settleFailedAnswer(ctx, command.targetId, args.code, failure);
      return null;
    }
    // A refused or failed cleanup is recorded on the worktree; nothing else needs input.
    if (command.type === "workspace.cleanup") {
      await recordCleanupFailure(ctx, command, args.code);
      return null;
    }
    let taskId: import("./_generated/dataModel").Id<"tasks"> | undefined;
    let sessionId: import("./_generated/dataModel").Id<"workSessions"> | undefined;
    if (command.type === "workspace.provision") {
      const workspaceId = ctx.db.normalizeId("workspaces", command.targetId);
      if (workspaceId) {
        const workspace = await load(ctx, "workspaces", workspaceId);
        await ctx.db.patch("workspaces", workspaceId, {
          status: "error",
          errorCode: args.code,
          updatedAt: Date.now(),
        });
        taskId = workspace.taskId;
        sessionId = workspace.workSessionId;
      }
    } else if (command.type === "repository.plan") {
      const id = ctx.db.normalizeId("textCommands", command.targetId);
      // A stopped Supervisor is the owner's choice, not a failure that needs input.
      if (id && args.code === "SUPERVISOR_STOPPED") {
        await settleStoppedText(ctx, id);
        return null;
      }
      if (id) sessionId = (await load(ctx, "textCommands", id)).workSessionId;
    } else if (command.type === "integration.prepare")
      taskId = ctx.db.normalizeId("tasks", command.targetId) ?? undefined;
    if (taskId) {
      const task = await load(ctx, "tasks", taskId);
      sessionId = task.workSessionId;
      if (task.status !== "cancelled")
        await ctx.db.patch("tasks", taskId, {
          status: "waiting",
          phase: "needs_input",
          failureReason: `${command.type}: ${args.code}`,
          updatedAt: Date.now(),
        });
    }
    if (sessionId) {
      const session = await load(ctx, "workSessions", sessionId);
      if (session.status !== "cancelled")
        await ctx.db.patch("workSessions", sessionId, {
          status: "needs_input",
          needsInputCount: Math.max(1, session.needsInputCount),
          updatedAt: Date.now(),
          contextSummary: `${command.type} failed: ${args.code}; local state preserved`,
        });
    }
    return null;
  },
});
export const markReady = mutation({
  args: {
    ...deviceArgs,
    workspaceId: v.id("workspaces"),
    commandId: v.id("commands"),
    localPath: v.string(),
    baseSha: v.string(),
    branchName: v.string(),
    headSha: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const workspace = await load(ctx, "workspaces", args.workspaceId);
    const command = await load(ctx, "commands", args.commandId);
    if (
      workspace.workstationId !== args.workstationId ||
      command.workstationId !== args.workstationId ||
      command.targetId !== workspace._id ||
      command.type !== "workspace.provision" ||
      !["claimed", "acknowledged", "completed"].includes(command.status)
    )
      fail("FORBIDDEN");
    if (workspace.status === "ready") {
      if (
        workspace.localPath !== args.localPath ||
        workspace.baseSha !== args.baseSha ||
        workspace.branchName !== args.branchName
      )
        fail("COMMAND_CONFLICT");
      return null;
    }
    if (workspace.status !== "provisioning") fail("INVALID_STATE");
    await ctx.db.patch("workspaces", workspace._id, {
      status: "ready",
      localPath: args.localPath,
      baseSha: args.baseSha,
      branchName: args.branchName,
      currentHeadSha: args.headSha,
      updatedAt: Date.now(),
    });
    return null;
  },
});
const runEventType = v.union(
  v.literal("run.started"),
  v.literal("run.usage"),
  v.literal("run.activity"),
  v.literal("run.message"),
  v.literal("run.waiting"),
  v.literal("run.completed"),
  v.literal("run.failed"),
  v.literal("run.stopped"),
  v.literal("tool.started"),
  v.literal("tool.completed"),
  v.literal("files.changed"),
  v.literal("approval.requested"),
  v.literal("approval.resolved"),
);
export const ingestBatch = mutation({
  args: {
    ...deviceArgs,
    runId: v.id("agentRuns"),
    events: v.array(
      v.object({
        eventId: v.string(),
        sequence: v.number(),
        type: runEventType,
        occurredAt: v.number(),
        payload: v.any(),
      }),
    ),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    let run = await nodeRun(ctx, args.workstationId, args.runId);
    if (args.events.length > 100) fail("INVALID_ARGUMENT");
    const latest = (
      await ctx.db
        .query("runEvents")
        .withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
        .order("desc")
        .take(1)
    )[0];
    let sequence = latest?.sequence ?? 0;
    const ack: string[] = [];
    for (const event of args.events) {
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        JSON.stringify(event.payload).length > 16 * 1024
      )
        fail("INVALID_ARGUMENT");
      // An intermediate agent message: redacted on the Node, bounded to RUN_MESSAGE_LIMIT.
      if (
        event.type === "run.message" &&
        (typeof event.payload?.text !== "string" ||
          !event.payload.text.trim() ||
          event.payload.text.length > RUN_MESSAGE_LIMIT)
      )
        fail("INVALID_ARGUMENT");
      const duplicate = await ctx.db
        .query("runEvents")
        .withIndex("by_run_event_id", (q) => q.eq("runId", run._id).eq("eventId", event.eventId))
        .unique();
      if (duplicate) {
        if (
          duplicate.sequence !== event.sequence ||
          duplicate.type !== event.type ||
          valueKey(duplicate.payload) !== valueKey(event.payload)
        )
          fail("COMMAND_CONFLICT");
        ack.push(event.eventId);
        continue;
      }
      if (event.sequence !== sequence + 1) fail("EVENT_SEQUENCE_CONFLICT");
      let status: RunStatus;
      if (event.type === "approval.requested" || event.type === "approval.resolved")
        status = await applyApprovalEvent(ctx, run, { ...event, type: event.type });
      else {
        // A runtime settles its approvals before it pauses or ends; if that confirmation
        // was lost, the run resumed before this event and the approvals are void.
        const from =
          run.status === "needs_approval" && ["run.waiting", "run.completed"].includes(event.type)
            ? "running"
            : run.status;
        status = applyRunEvent(from, event.type);
        if (["completed", "failed", "stopped"].includes(status)) await expireRunApprovals(ctx, run);
      }
      await ctx.db.insert("runEvents", {
        ...event,
        runId: run._id,
        workstationId: args.workstationId,
      });
      const usage: Partial<Record<UsageCounter, number>> & { modelActual?: string } = {};
      if (event.type === "run.usage") {
        for (const field of USAGE_COUNTERS) {
          const value = event.payload?.[field];
          if (value !== undefined) {
            if (!Number.isSafeInteger(value) || value < 0 || value < (run[field] ?? 0))
              fail("INVALID_USAGE");
            usage[field] = value;
          }
        }
        if (event.payload?.modelActual !== undefined) {
          if (
            typeof event.payload.modelActual !== "string" ||
            event.payload.modelActual.length > 256
          )
            fail("INVALID_USAGE");
          usage.modelActual = event.payload.modelActual;
        }
      }
      await ctx.db.patch("agentRuns", run._id, {
        ...usage,
        status,
        lastActivityAt: event.occurredAt,
        ...(event.type === "run.started" && typeof event.payload?.nativeSessionId === "string"
          ? { nativeSessionId: event.payload.nativeSessionId, startedAt: event.occurredAt }
          : {}),
        ...(event.type === "run.activity" && typeof event.payload?.label === "string"
          ? { activityLabel: event.payload.label }
          : {}),
        ...(event.type === "run.failed"
          ? {
              failure: {
                ...(typeof event.payload?.code === "string"
                  ? { code: event.payload.code.slice(0, 64) }
                  : {}),
                ...(typeof event.payload?.message === "string"
                  ? { reason: event.payload.message.slice(0, 400) }
                  : {}),
                at: event.occurredAt,
              },
            }
          : {}),
      });
      run = { ...run, ...usage, status };
      sequence = event.sequence;
      ack.push(event.eventId);
    }
    return ack;
  },
});
export const completeRun = mutation({
  args: {
    ...deviceArgs,
    runId: v.id("agentRuns"),
    headSha: v.string(),
    dirty: v.boolean(),
    changedFileCount: v.number(),
    summary: v.optional(v.string()),
    evidence: v.optional(
      v.array(
        v.object({
          modality: v.string(),
          result: v.union(v.literal("passed"), v.literal("failed")),
          summary: v.string(),
        }),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await nodeRun(ctx, args.workstationId, args.runId);
    if (
      !Number.isSafeInteger(args.changedFileCount) ||
      args.changedFileCount < 0 ||
      (args.summary?.length ?? 0) > 8000
    )
      fail("INVALID_ARGUMENT");
    await settleRun(ctx, run._id, args);
    if (run.role === "verifier") {
      const verification = await ctx.db
        .query("verificationRuns")
        .withIndex("by_verifier", (q) => q.eq("verifierRunId", run._id))
        .unique();
      if (!verification || (args.evidence?.length ?? 0) > 16)
        fail("INVALID_VERIFICATION_PROVENANCE");
      const modalities = [
        "static",
        "test",
        "behavioral",
        "visual",
        "interaction",
        "mutation",
        "security",
      ] as const;
      for (const record of args.evidence ?? []) {
        const modality = modalities.find((value) => value === record.modality);
        if (!modality || record.summary.length > 8192) fail("INVALID_ARGUMENT");
        const previous = await ctx.db
          .query("evidence")
          .withIndex("by_verification", (q) => q.eq("verificationRunId", verification._id))
          .take(33);
        const duplicate = previous.find((item) => item.modality === modality);
        if (duplicate) {
          if (duplicate.result !== record.result || duplicate.summary !== record.summary)
            fail("COMMAND_CONFLICT");
        } else
          await ctx.db.insert("evidence", {
            verificationRunId: verification._id,
            verifierRunId: run._id,
            subjectSha: verification.subjectSha,
            modality,
            result: record.result,
            summary: record.summary,
            createdAt: Date.now(),
          });
      }
      await decideVerification(ctx, run._id);
    }
    return null;
  },
});
export const reportSnapshot = mutation({
  args: {
    ...deviceArgs,
    workspaceId: v.id("workspaces"),
    headSha: v.string(),
    dirty: v.boolean(),
    changedFileCount: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const workspace = await load(ctx, "workspaces", args.workspaceId);
    if (workspace.workstationId !== args.workstationId) fail("FORBIDDEN");
    if (!Number.isSafeInteger(args.changedFileCount) || args.changedFileCount < 0)
      fail("INVALID_ARGUMENT");
    await ctx.db.patch("workspaces", workspace._id, {
      currentHeadSha: args.headSha,
      dirty: args.dirty,
      changedFileCount: args.changedFileCount,
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const reconcile = mutation({
  args: {
    ...deviceArgs,
    runId: v.id("agentRuns"),
    // "resuming": the Node is reattaching the run after a restart and reads its status.
    observation: v.union(v.literal("missing"), v.literal("active"), v.literal("resuming")),
    // Why the native session could not be recovered (an error code).
    reason: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const run = await nodeRun(ctx, args.workstationId, args.runId);
    if (args.reason !== undefined && !/^[A-Z_]{1,64}$/.test(args.reason)) fail("INVALID_ARGUMENT");
    let status: RunStatus = run.status;
    if (
      args.observation === "missing" &&
      ["starting", "running", "waiting", "needs_approval", "stopping"].includes(run.status)
    ) {
      assertRunTransition(run.status, "lost");
      status = "lost";
      await ctx.db.patch("agentRuns", run._id, {
        status,
        exitReason: args.reason
          ? `Native session could not be recovered after a Node restart (${args.reason})`
          : "Native session missing after reconnect",
      });
      // Nothing the lost session asked for can be acted on; a resumed run asks again.
      await expireRunApprovals(ctx, run);
    }
    // This reports uncertainty; it never starts another runtime or removes workspaces/leases:
    // a lost run keeps its workspace and capacity until it is reconciled.
    return {
      runId: run._id,
      status,
      reconciliationRequired: args.observation === "missing",
    };
  },
});

export const recoverCompletedCommand = mutation({
  args: { ...deviceArgs, commandId: v.id("commands"), instanceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    if (device.nodeInstanceId !== args.instanceId) fail("FORBIDDEN");
    const command = await load(ctx, "commands", args.commandId);
    if (command.workstationId !== device._id) fail("FORBIDDEN");
    if (command.status === "completed") return null;
    if (!["claimed", "acknowledged"].includes(command.status)) fail("RECONCILIATION_REQUIRED");
    if (command.type === "workspace.provision") {
      const id = ctx.db.normalizeId("workspaces", command.targetId);
      if (!id) fail("INVALID_ARGUMENT");
      const workspace = await load(ctx, "workspaces", id);
      if (
        workspace.workstationId !== device._id ||
        workspace.status !== "ready" ||
        !workspace.localPath ||
        !workspace.baseSha
      )
        fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "runtime.start") {
      const id = ctx.db.normalizeId("agentRuns", command.targetId);
      if (!id) fail("INVALID_ARGUMENT");
      const run = await nodeRun(ctx, device._id, id);
      // A checks-only verifier run has no native session: the Node ran only the checks.
      if (
        (!run.nativeSessionId && !run.checksOnly) ||
        !["running", "waiting", "needs_approval", "completed", "failed", "stopped"].includes(
          run.status,
        ) ||
        (["completed", "failed", "stopped"].includes(run.status) && run.completedAt === undefined)
      )
        fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "runtime.stop") {
      // A stop is complete only once the run's terminal outcome has been settled.
      const id = ctx.db.normalizeId("agentRuns", command.targetId);
      if (!id) fail("INVALID_ARGUMENT");
      const run = await nodeRun(ctx, device._id, id);
      if (run.completedAt === undefined) fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "runtime.send" || command.type === "runtime.approval") {
      // Delivered to the runtime; the run reports what followed through its own events.
      const id = ctx.db.normalizeId("agentRuns", command.targetId);
      if (!id) fail("INVALID_ARGUMENT");
      await nodeRun(ctx, device._id, id);
    } else if (command.type === "workspace.cleanup") {
      const id = ctx.db.normalizeId("workspaces", command.targetId);
      if (!id) fail("INVALID_ARGUMENT");
      const workspace = await load(ctx, "workspaces", id);
      if (workspace.workstationId !== device._id || workspace.ownerRunId)
        fail("RECONCILIATION_REQUIRED");
      await recordCleanupRemoved(ctx, workspace);
    } else if (command.type === "repository.plan") {
      const id = ctx.db.normalizeId("textCommands", command.targetId);
      if (!id || !(await load(ctx, "textCommands", id)).planDigest) fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "integration.prepare") {
      const id = ctx.db.normalizeId("tasks", command.targetId);
      if (!id || (await load(ctx, "tasks", id)).phase !== "completed")
        fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "integration.publish") {
      if (!(await publishRecorded(ctx, command))) fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "orchestrator.answer") {
      const id = ctx.db.normalizeId("orchestratorMessages", command.targetId);
      if (!id || (await load(ctx, "orchestratorMessages", id)).status === "thinking")
        fail("RECONCILIATION_REQUIRED");
    } else if (command.type === "supervisor.stop") {
      // Delivered (or a no-op); the plan reports what followed through its own command.
      if (!ctx.db.normalizeId("textCommands", command.targetId)) fail("INVALID_ARGUMENT");
    } else fail("RECONCILIATION_REQUIRED");
    // Recovery acknowledges an already observed outcome. It does not re-claim or execute work.
    await ctx.db.patch("commands", command._id, { status: "completed", completedAt: Date.now() });
    return null;
  },
});

export const health = query({
  args: deviceArgs,
  returns: v.object({
    online: v.boolean(),
    runtimeAvailable: v.boolean(),
    // Exact heartbeat evidence: setup waits for a new instance of the Node process.
    lastHeartbeatAt: v.union(v.number(), v.null()),
    instanceId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    const runtimes = await ctx.db
      .query("runtimeInstallations")
      .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
      .take(33);
    if (runtimes.length > 32) fail("LIMIT_EXCEEDED");
    return {
      online: device.status === "online" && (device.lastHeartbeatAt ?? 0) > Date.now() - 45_000,
      runtimeAvailable: runtimes.some(
        (runtime) => runtime.status === "available" && runtime.capabilities.includes("start"),
      ),
      lastHeartbeatAt: device.lastHeartbeatAt ?? null,
      instanceId: device.nodeInstanceId ?? null,
    };
  },
});

export const completeIntegration = mutation({
  args: {
    workstationId: v.id("workstations"),
    taskId: v.id("tasks"),
    workspaceId: v.id("workspaces"),
    trustDecisionId: v.id("trustDecisions"),
    subjectSha: v.string(),
    headSha: v.string(),
    dirty: v.boolean(),
    branchName: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireNode(ctx, args.workstationId);
    const task = await load(ctx, "tasks", args.taskId);
    const session = await load(ctx, "workSessions", task.workSessionId);
    const workspace = await load(ctx, "workspaces", args.workspaceId);
    const decision = await load(ctx, "trustDecisions", args.trustDecisionId);
    if (
      task.status === "cancelled" ||
      session.status === "cancelled" ||
      workspace.workstationId !== args.workstationId ||
      task.integrationWorkspaceId !== workspace._id ||
      task.trustDecisionId !== decision._id ||
      decision.candidateRunId !== task.candidateRunId ||
      !decision.eligible ||
      decision.subjectSha !== args.subjectSha ||
      args.headSha !== args.subjectSha ||
      workspace.baseSha !== args.subjectSha ||
      workspace.currentHeadSha !== args.subjectSha ||
      workspace.kind !== "integration" ||
      args.dirty ||
      workspace.dirty ||
      workspace.branchName !== args.branchName
    )
      fail("INVALID_INTEGRATION_PROVENANCE");
    if (task.phase === "completed") return null;
    await ctx.db.insert("artifacts", {
      workSessionId: task.workSessionId,
      taskId: task._id,
      kind: "integration_branch",
      name: args.branchName,
      storage: "git",
      locator: args.subjectSha,
      metadata: { branchName: args.branchName, mergePolicy: "human", workspaceId: workspace._id },
      createdAt: Date.now(),
    });
    await ctx.db.patch("tasks", task._id, {
      status: "completed",
      phase: "completed",
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await recordIntegrationStep(ctx, decision, args.branchName);
    await refreshDependents(ctx, task._id);
    await refreshSession(ctx, task.workSessionId);
    return null;
  },
});
