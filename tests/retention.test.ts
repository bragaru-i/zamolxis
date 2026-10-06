import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConvexControlPlaneTransport,
  parseExecutionCommand,
} from "../apps/node/src/convex-control-plane";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  CLEANUP_BATCH,
  DAY,
  evaluateWorkspace,
  MAX_CLEANUP_ATTEMPTS,
} from "../convex/lib/retention";
import schema from "../convex/schema";
import { git } from "../packages/git/src/repository-inspector";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { RuntimeRegistry } from "../packages/runtime-core/src/runtime-registry";
import { seedHuman } from "./fixtures/auth";

// Worktree retention (#8): eligibility rules, the hourly sweep, owner control and the
// Node removing worktrees (and pruning Git metadata) in disposable repositories.
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./node.ts": () => import("../convex/node"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./runs.ts": () => import("../convex/runs"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./workstations.ts": () => import("../convex/workstations"),
};
const NOW = Date.UTC(2026, 9, 6, 12);
const HOUR = 60 * 60 * 1000;
const SHA = (n: number) => n.toString(16).padStart(40, "a");
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) fn();
});

type T = TestConvex<typeof schema>;
// Test fields may clear optional values (undefined), as patches do.
type Fields<D> = { [K in keyof D]?: D[K] | undefined };
async function base(t: T, ownerId: Id<"users">, name = "Mac", heartbeat = NOW) {
  return t.run(async (ctx) => {
    const workstationId = await ctx.db.insert("workstations", {
      ownerId,
      name,
      status: "online",
      registeredAt: 0,
      nodeAuthSubject: `device-${name}`,
      nodeInstanceId: "instance",
      lastHeartbeatAt: heartbeat,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId,
      name: "Repo",
      createdAt: 0,
      updatedAt: 0,
    });
    const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/repo",
      status: "available",
      updatedAt: 0,
    });
    const productId = await ctx.db.insert("products", {
      ownerId,
      name: "Product",
      slug: `product-${name}`,
      createdAt: 0,
      updatedAt: 0,
    });
    return { workstationId, repositoryId, repositoryLocationId, productId };
  });
}

async function fixture() {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const bob = await seedHuman(t, "bob");
  const ids = await base(t, alice.userId);
  const node = t.withIdentity({
    subject: "device-Mac",
    tokenIdentifier: "device-Mac",
    ownerSubject: "alice",
  });
  const session = (fields: Fields<Doc<"workSessions">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("workSessions", {
        ownerId: alice.userId,
        title: "Session",
        goal: "Goal",
        status: "completed",
        activeRunCount: 0,
        completedTaskCount: 0,
        totalTaskCount: 0,
        needsInputCount: 0,
        lastActivityAt: NOW - 4 * DAY,
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW - 4 * DAY,
        ...(fields as object),
      }),
    );
  const task = (workSessionId: Id<"workSessions">, fields: Fields<Doc<"tasks">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("tasks", {
        workSessionId,
        title: "Task",
        description: "Do it",
        kind: "implementation",
        status: "failed",
        phase: "failed",
        runtimePolicyMode: "auto",
        priority: 1,
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW - 4 * DAY,
        ...(fields as object),
      }),
    );
  const workspace = (
    workSessionId: Id<"workSessions">,
    fields: Fields<Doc<"workspaces">> = {},
    workstationId = ids.workstationId,
  ) =>
    t.run((ctx) =>
      ctx.db.insert("workspaces", {
        workSessionId,
        repositoryId: ids.repositoryId,
        repositoryLocationId: ids.repositoryLocationId,
        workstationId,
        kind: "worktree",
        status: "ready",
        baseRef: "main",
        baseSha: SHA(1),
        currentHeadSha: SHA(2),
        dirty: false,
        changedFileCount: 0,
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW - 4 * DAY,
        ...(fields as object),
      }),
    );
  const run = (
    workspaceId: Id<"workspaces">,
    taskId: Id<"tasks">,
    fields: Fields<Doc<"agentRuns">> = {},
  ) =>
    t.run(async (ctx) => {
      const ws = (await ctx.db.get("workspaces", workspaceId))!;
      return ctx.db.insert("agentRuns", {
        workSessionId: ws.workSessionId,
        taskId,
        workspaceId,
        workstationId: ws.workstationId,
        role: "builder",
        runtime: "fake",
        status: "completed",
        attempt: 1,
        lastActivityAt: NOW - 4 * DAY,
        completedAt: NOW - 4 * DAY,
        ...(fields as object),
      });
    });
  const trust = (candidateRunId: Id<"agentRuns">, subjectSha: string, eligible = true) =>
    t.run((ctx) =>
      ctx.db.insert("trustDecisions", {
        candidateRunId,
        subjectSha,
        eligible,
        reasons: [],
        createdAt: NOW - 4 * DAY,
      }),
    );
  const evaluate = (workspaceId: Id<"workspaces">, retention = 3 * DAY) =>
    t.run(async (ctx) =>
      evaluateWorkspace(ctx, (await ctx.db.get("workspaces", workspaceId))!, Date.now(), retention),
    );
  const get = (workspaceId: Id<"workspaces">) =>
    t.run(async (ctx) => (await ctx.db.get("workspaces", workspaceId))!);
  const patch = <K extends "workspaces" | "workSessions" | "tasks" | "workstations">(
    table: K,
    id: Id<K>,
    fields: Fields<Doc<K>>,
  ) =>
    t.run(async (ctx) => {
      await ctx.db.patch(table, id, fields as never);
    });
  return {
    t,
    alice,
    bob,
    node,
    ...ids,
    session,
    task,
    workspace,
    run,
    trust,
    evaluate,
    get,
    patch,
  };
}

/** A builder worktree of a failed task in a Session finished four days ago. */
async function finishedBuilder(f: Awaited<ReturnType<typeof fixture>>) {
  const sessionId = await f.session();
  const taskId = await f.task(sessionId);
  const workspaceId = await f.workspace(sessionId, { taskId });
  await f.run(workspaceId, taskId);
  return { sessionId, taskId, workspaceId };
}

describe("retention eligibility", () => {
  it("allows a clean worktree of a finished Session after the window and names its branch tip", async () => {
    const f = await fixture();
    const { workspaceId } = await finishedBuilder(f);
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: true, deleteBranchAt: SHA(2) });
  });

  it("keeps worktrees inside the retention window, honouring the owner's setting", async () => {
    const f = await fixture();
    const { sessionId, workspaceId } = await finishedBuilder(f);
    await f.patch("workSessions", sessionId, { lastActivityAt: NOW - 2 * DAY });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "RETENTION_WINDOW" });
    expect((await f.evaluate(workspaceId, 1 * DAY)).eligible).toBe(true);
    // A run that finished recently counts as recent use as well.
    await f.patch("workSessions", sessionId, { lastActivityAt: NOW - 4 * DAY });
    const later = await f.task(sessionId);
    await f.run(workspaceId, later, { completedAt: NOW - HOUR });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "RETENTION_WINDOW" });
  });

  it("excludes owned, dirty, busy, canonical, requested and active-run worktrees", async () => {
    const f = await fixture();
    const { taskId, workspaceId } = await finishedBuilder(f);
    const cases: Array<[Fields<Doc<"workspaces">>, string]> = [
      [{ kind: "canonical" }, "CANONICAL"],
      [{ status: "in_use" }, "STATUS"],
      [{ status: "dirty" }, "STATUS"],
      [{ status: "error" }, "STATUS"],
      [{ status: "removed" }, "STATUS"],
      [{ status: "cleanup_pending" }, "CLEANUP_REQUESTED"],
      [{ dirty: true }, "DIRTY"],
    ];
    for (const [fields, reason] of cases) {
      const original = await f.get(workspaceId);
      await f.patch("workspaces", workspaceId, fields);
      expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason });
      await f.patch("workspaces", workspaceId, {
        kind: original.kind,
        status: original.status,
        dirty: original.dirty,
      });
    }
    const active = await f.run(workspaceId, taskId, { status: "running", completedAt: undefined });
    await f.patch("workspaces", workspaceId, { ownerRunId: active });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "OWNER_RUN" });
    await f.patch("workspaces", workspaceId, { ownerRunId: undefined });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "ACTIVE_RUN" });
  });

  it("waits for the Session to finish or idle with nothing running", async () => {
    const f = await fixture();
    const { sessionId, taskId, workspaceId } = await finishedBuilder(f);
    for (const status of ["planning", "running", "needs_input"] as const) {
      await f.patch("workSessions", sessionId, { status });
      expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "SESSION_ACTIVE" });
    }
    await f.patch("workSessions", sessionId, { status: "waiting", activeRunCount: 1 });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "SESSION_ACTIVE" });
    await f.patch("workSessions", sessionId, { activeRunCount: 0 });
    expect((await f.evaluate(workspaceId)).eligible).toBe(true);
    // Another task about to run keeps the whole idle Session.
    const other = await f.task(sessionId, { status: "ready", phase: "building" });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "SESSION_ACTIVE" });
    await f.patch("tasks", other, { status: "failed", phase: "failed" });
    for (const status of ["failed", "cancelled", "completed"] as const) {
      await f.patch("workSessions", sessionId, { status });
      expect((await f.evaluate(workspaceId)).eligible).toBe(true);
    }
    // A task still in an active phase (verification, repair, integration) is kept.
    await f.patch("workSessions", sessionId, { status: "waiting" });
    for (const phase of ["verifying", "repairing", "integrating", "waiting_for_verification"]) {
      await f.patch("tasks", taskId, { status: "waiting", phase: phase as Doc<"tasks">["phase"] });
      expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "TASK_ACTIVE" });
    }
  });

  it("keeps a verifier worktree referenced by an undecided verification", async () => {
    const f = await fixture();
    const sessionId = await f.session({ status: "waiting" });
    const taskId = await f.task(sessionId, { status: "waiting", phase: undefined });
    const workspaceId = await f.workspace(sessionId, { taskId });
    const verificationRunId = await f.t.run(async (ctx) => {
      const runId = await ctx.db.insert("agentRuns", {
        workSessionId: sessionId,
        taskId,
        workspaceId,
        workstationId: f.workstationId,
        role: "verifier",
        runtime: "fake",
        status: "completed",
        attempt: 1,
        lastActivityAt: 0,
        completedAt: NOW - 4 * DAY,
      });
      return ctx.db.insert("verificationRuns", {
        candidateRunId: runId,
        verifierRunId: runId,
        subjectSha: SHA(2),
        createdAt: 0,
      });
    });
    await f.patch("tasks", taskId, { verifierWorkspaceId: workspaceId, verificationRunId });
    expect(await f.evaluate(workspaceId)).toEqual({
      eligible: false,
      reason: "ACTIVE_VERIFICATION",
    });
  });

  it("removes a planning worktree one day after the Supervisor decided", async () => {
    const f = await fixture();
    const sessionId = await f.session({ status: "running", lastActivityAt: NOW });
    const workspaceId = await f.workspace(sessionId);
    const textCommandId = await f.t.run((ctx) =>
      ctx.db.insert("textCommands", {
        ownerId: f.alice.userId,
        idempotencyKey: "k",
        text: "Plan",
        productId: f.productId,
        repositoryId: f.repositoryId,
        workSessionId: sessionId,
        planningWorkspaceId: workspaceId,
      }),
    );
    const planId = await f.t.run((ctx) =>
      ctx.db.insert("commands", {
        workstationId: f.workstationId,
        type: "repository.plan",
        targetType: "textCommand",
        targetId: textCommandId,
        idempotencyKey: `plan:${textCommandId}`,
        status: "acknowledged",
        payload: {},
        createdAt: NOW - 3 * DAY,
      }),
    );
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "PLAN_UNDECIDED" });
    await f.t.run((ctx) =>
      ctx.db.patch("commands", planId, { status: "completed", completedAt: NOW - 12 * HOUR }),
    );
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: false, reason: "RETENTION_WINDOW" });
    await f.t.run((ctx) => ctx.db.patch("commands", planId, { completedAt: NOW - 25 * HOUR }));
    // Read-only and decided: removable while the Session's builders still run.
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: true });
    // A Supervisor stopped by the owner also decided.
    await f.t.run((ctx) => ctx.db.patch("commands", planId, { status: "acknowledged" }));
    await f.t.run((ctx) =>
      ctx.db.patch("textCommands", textCommandId, { stoppedAt: NOW - 2 * DAY }),
    );
    expect((await f.evaluate(workspaceId)).eligible).toBe(true);
  });

  it("never removes the only worktree holding a trusted, unpublished commit", async () => {
    const f = await fixture();
    const sessionId = await f.session();
    const taskId = await f.task(sessionId, { status: "completed", phase: "completed" });
    const builder = await f.workspace(sessionId, { taskId, currentHeadSha: SHA(7) });
    const candidate = await f.run(builder, taskId, { finalHeadSha: SHA(7) });
    const decision = await f.trust(candidate, SHA(7));
    const integration = await f.workspace(sessionId, {
      taskId,
      kind: "integration",
      baseSha: SHA(7),
      currentHeadSha: SHA(7),
    });
    await f.patch("tasks", taskId, {
      candidateRunId: candidate,
      trustDecisionId: decision,
      lastTrustDecisionId: decision,
      integrationWorkspaceId: integration,
    });
    // Ready but unpublished trusted work waits for the owner, however old.
    expect(await f.evaluate(integration, 1 * DAY)).toEqual({
      eligible: false,
      reason: "UNPUBLISHED_INTEGRATION",
    });
    await f.patch("workSessions", sessionId, { lastActivityAt: NOW - 300 * DAY });
    expect((await f.evaluate(integration)).eligible).toBe(false);
    // The builder copy may go while the integration worktree keeps the commit, but its
    // branch is not deleted.
    expect(await f.evaluate(builder)).toEqual({ eligible: true });
    await f.patch("workspaces", integration, { status: "removed" });
    expect(await f.evaluate(builder)).toEqual({ eligible: false, reason: "ONLY_TRUSTED_COPY" });
    await f.patch("workspaces", integration, { status: "ready", dirty: true });
    expect(await f.evaluate(builder)).toEqual({ eligible: false, reason: "ONLY_TRUSTED_COPY" });
    await f.patch("workspaces", integration, { dirty: false });
    // Publishing: pending keeps it; published younger than the window keeps it; then it goes.
    await f.patch("tasks", taskId, { publishStatus: "pending" });
    expect(await f.evaluate(integration)).toEqual({ eligible: false, reason: "PUBLISH_PENDING" });
    await f.patch("tasks", taskId, { publishStatus: "failed" });
    expect(await f.evaluate(integration)).toEqual({
      eligible: false,
      reason: "UNPUBLISHED_INTEGRATION",
    });
    await f.patch("tasks", taskId, { publishStatus: "published", publishedAt: NOW - DAY });
    expect(await f.evaluate(integration)).toEqual({ eligible: false, reason: "RETENTION_WINDOW" });
    await f.patch("tasks", taskId, { publishedAt: NOW - 4 * DAY });
    expect(await f.evaluate(integration)).toEqual({ eligible: true, deleteBranchAt: SHA(7) });
    expect(await f.evaluate(builder)).toEqual({ eligible: true, deleteBranchAt: SHA(7) });
  });

  it("does not protect commits whose trust decision failed", async () => {
    const f = await fixture();
    const { taskId, workspaceId } = await finishedBuilder(f);
    const run = await f.run(workspaceId, taskId, { finalHeadSha: SHA(2) });
    const decision = await f.trust(run, SHA(2), false);
    await f.patch("tasks", taskId, { lastTrustDecisionId: decision });
    expect(await f.evaluate(workspaceId)).toEqual({ eligible: true, deleteBranchAt: SHA(2) });
  });
});

describe("hourly sweep", () => {
  it("requests a bounded, idempotent batch per online Mac only", async () => {
    const f = await fixture();
    const offline = await base(f.t, f.alice.userId, "Away", NOW - HOUR);
    const sessionId = await f.session();
    const ids: Id<"workspaces">[] = [];
    for (let index = 0; index < 25; index++) ids.push(await f.workspace(sessionId));
    const away = await f.workspace(sessionId, {}, offline.workstationId);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(CLEANUP_BATCH);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(CLEANUP_BATCH);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(5);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
    const commands = await f.t.run((ctx) => ctx.db.query("commands").collect());
    expect(commands).toHaveLength(25);
    expect(new Set(commands.map((command) => command.targetId))).toEqual(new Set(ids));
    for (const command of commands) {
      expect(command).toMatchObject({
        type: "workspace.cleanup",
        workstationId: f.workstationId,
        idempotencyKey: `cleanup:${command.targetId}:1`,
        payload: { workspaceId: command.targetId, deleteBranchAt: SHA(2) },
      });
    }
    const first = await f.get(ids[0]!);
    expect(first).toMatchObject({
      status: "cleanup_pending",
      cleanupStatus: "requested",
      cleanupAttempts: 1,
      cleanupRequestedAt: NOW,
    });
    expect((await f.get(away)).status).toBe("ready");
  });

  it("records removal and failures from the Node, backs off and stops after the attempt cap", async () => {
    const f = await fixture();
    const { workspaceId } = await finishedBuilder(f);
    const claimAndFail = async (code: string) => {
      const command = (await f.get(workspaceId)).cleanupCommandId!;
      await f.node.mutation(api.node.claim, {
        workstationId: f.workstationId,
        commandId: command,
        instanceId: "instance",
      });
      await f.node.mutation(api.node.failCommand, {
        workstationId: f.workstationId,
        commandId: command,
        instanceId: "instance",
        code,
      });
      return command;
    };
    await f.t.mutation(internal.workspaces.sweepCleanup, {});
    await claimAndFail("WORKSPACE_BUSY");
    expect(await f.get(workspaceId)).toMatchObject({
      status: "ready",
      cleanupStatus: "failed",
      cleanupError: "WORKSPACE_BUSY",
      cleanupAttempts: 1,
      cleanupNextAttemptAt: NOW + 6 * HOUR,
    });
    // A failed cleanup never sends the Session to needs_input.
    const { workSessionId } = await f.get(workspaceId);
    const session = await f.t.run((ctx) => ctx.db.get("workSessions", workSessionId));
    expect(session?.status).toBe("completed");
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
    const advance = async (at: number) => {
      vi.setSystemTime(at);
      await f.patch("workstations", f.workstationId, { lastHeartbeatAt: at });
    };
    await advance(NOW + 6 * HOUR - 1);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
    await advance(NOW + 6 * HOUR);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(1);
    expect((await f.get(workspaceId)).cleanupAttempts).toBe(2);
    await claimAndFail("LOCAL_OPERATION_FAILED");
    expect((await f.get(workspaceId)).cleanupNextAttemptAt).toBe(NOW + 30 * HOUR);
    await advance(NOW + 30 * HOUR);
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(1);
    await claimAndFail("LOCAL_OPERATION_FAILED");
    expect(await f.get(workspaceId)).toMatchObject({
      cleanupAttempts: MAX_CLEANUP_ATTEMPTS,
      cleanupStatus: "failed",
    });
    expect((await f.get(workspaceId)).cleanupNextAttemptAt).toBeUndefined();
    vi.setSystemTime(NOW + 60 * DAY);
    await f.patch("workstations", f.workstationId, { lastHeartbeatAt: NOW + 60 * DAY });
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
    expect((await f.evaluate(workspaceId)).eligible).toBe(false);
    expect(await f.t.run((ctx) => ctx.db.query("commands").collect())).toHaveLength(3);
  });

  it("preserves a worktree the Node found dirty and never retries an unknown one", async () => {
    const f = await fixture();
    const dirty = await finishedBuilder(f);
    const unknown = await finishedBuilder(f);
    await f.t.mutation(internal.workspaces.sweepCleanup, {});
    for (const [workspaceId, code] of [
      [dirty.workspaceId, "DIRTY_WORKSPACE_PRESERVED"],
      [unknown.workspaceId, "WORKSPACE_NOT_REGISTERED"],
    ] as const) {
      const commandId = (await f.get(workspaceId)).cleanupCommandId!;
      await f.node.mutation(api.node.claim, {
        workstationId: f.workstationId,
        commandId,
        instanceId: "instance",
      });
      await f.node.mutation(api.node.failCommand, {
        workstationId: f.workstationId,
        commandId,
        instanceId: "instance",
        code,
      });
    }
    expect(await f.get(dirty.workspaceId)).toMatchObject({ status: "dirty", dirty: true });
    expect(await f.get(unknown.workspaceId)).toMatchObject({ status: "ready" });
    expect((await f.get(unknown.workspaceId)).cleanupNextAttemptAt).toBeUndefined();
    vi.setSystemTime(NOW + 10 * DAY);
    await f.patch("workstations", f.workstationId, { lastHeartbeatAt: NOW + 10 * DAY });
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
  });

  it("marks the worktree removed when the Node reports the command complete", async () => {
    const f = await fixture();
    const { workspaceId } = await finishedBuilder(f);
    await f.t.mutation(internal.workspaces.sweepCleanup, {});
    const commandId = (await f.get(workspaceId)).cleanupCommandId!;
    await f.node.mutation(api.node.claim, {
      workstationId: f.workstationId,
      commandId,
      instanceId: "instance",
    });
    await f.node.mutation(api.node.recoverCompletedCommand, {
      workstationId: f.workstationId,
      commandId,
      instanceId: "instance",
    });
    expect(await f.get(workspaceId)).toMatchObject({
      status: "removed",
      cleanupStatus: "removed",
      removedAt: NOW,
    });
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(0);
  });
});

describe("owner control", () => {
  it("lets only the owner clean up now, on an online Mac, with the same rules", async () => {
    const f = await fixture();
    const { workspaceId } = await finishedBuilder(f);
    const young = await f.workspace(await f.session({ lastActivityAt: NOW - DAY }));
    await expect(
      f.bob.user.mutation(api.workspaces.cleanupNow, { workstationId: f.workstationId }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.t.mutation(api.workspaces.cleanupNow, { workstationId: f.workstationId }),
    ).rejects.toThrow("FORBIDDEN");
    const pending = await seedHuman(f.t, "carol", "pending");
    await expect(
      pending.user.mutation(api.workspaces.cleanupNow, { workstationId: f.workstationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    const before = await f.alice.user.query(api.workspaces.storage, {});
    expect(before.retentionDays).toBe(3);
    expect(before.macs).toEqual([
      expect.objectContaining({ name: "Mac", managed: 2, eligible: 1, pending: 0, online: true }),
    ]);
    expect(
      await f.alice.user.mutation(api.workspaces.cleanupNow, { workstationId: f.workstationId }),
    ).toEqual({ requested: 1 });
    expect((await f.get(workspaceId)).cleanupStatus).toBe("requested");
    expect((await f.get(young)).cleanupStatus).toBeUndefined();
    expect((await f.alice.user.query(api.workspaces.storage, {})).macs[0]).toMatchObject({
      managed: 2,
      eligible: 0,
      pending: 1,
    });
    // Bob sees only his own (no) Macs.
    expect((await f.bob.user.query(api.workspaces.storage, {})).macs).toEqual([]);
    await f.patch("workstations", f.workstationId, { lastHeartbeatAt: NOW - HOUR });
    await expect(
      f.alice.user.mutation(api.workspaces.cleanupNow, { workstationId: f.workstationId }),
    ).rejects.toThrow("WORKSTATION_OFFLINE");
  });

  it("bounds the per-owner retention setting to 1..30 days", async () => {
    const f = await fixture();
    const young = await f.workspace(await f.session({ lastActivityAt: NOW - 2 * DAY }));
    for (const days of [0, 31, 1.5, -1])
      await expect(
        f.alice.user.mutation(api.workspaces.setRetentionDays, { days }),
      ).rejects.toThrow("INVALID_ARGUMENT");
    await f.alice.user.mutation(api.workspaces.setRetentionDays, { days: 1 });
    expect((await f.alice.user.query(api.workspaces.storage, {})).retentionDays).toBe(1);
    // Bob's setting is his own.
    await f.bob.user.mutation(api.workspaces.setRetentionDays, { days: 30 });
    expect(await f.t.mutation(internal.workspaces.sweepCleanup, {})).toBe(1);
    expect((await f.get(young)).cleanupStatus).toBe("requested");
  });
});

describe("Node cleanup against a disposable repository", () => {
  it("accepts only an exact commit as the branch deletion bound", () => {
    const command = (payload: Record<string, unknown>) => ({
      _id: "c1",
      workstationId: "w1",
      idempotencyKey: "cleanup:ws:1",
      type: "workspace.cleanup",
      targetType: "workspace",
      targetId: "ws",
      payload: { workspaceId: "ws", ...payload },
    });
    expect(parseExecutionCommand(command({})).payload).toEqual({ workspaceId: "ws" });
    expect(parseExecutionCommand(command({ deleteBranchAt: SHA(3) })).payload).toEqual({
      workspaceId: "ws",
      deleteBranchAt: SHA(3),
    });
    for (const deleteBranchAt of ["main", "HEAD~1", 42, ""])
      expect(() => parseExecutionCommand(command({ deleteBranchAt }))).toThrow("INVALID_COMMAND");
  });

  it("removes eligible worktrees, deletes their branch, preserves dirty ones and leaves the canonical checkout alone", async () => {
    vi.useRealTimers();
    const repo = repositoryFixture();
    cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const originalHead = git(repo.path, ["rev-parse", "HEAD"]);
    const originalStatus = git(repo.path, ["status", "--porcelain"]);
    git(repo.path, ["branch", "feature/mine"]);
    const t = convexTest(schema, modules);
    const { user } = await seedHuman(t, "alice");
    const workstationId = await user.mutation(api.workstations.register, {
      name: "Test",
      nodeAuthSubject: "device",
    });
    const node = t.withIdentity({
      subject: "device",
      tokenIdentifier: "device",
      ownerSubject: "alice",
    });
    const repositoryId = await user.mutation(api.repositories.create, { name: "Repository" });
    const repositoryLocationId = await node.mutation(api.node.registerLocation, {
      workstationId,
      repositoryId,
      canonicalPath: repo.path,
      gitCommonDir: join(repo.path, ".git"),
      headSha: originalHead,
    });
    const workSessionId = await user.mutation(api.sessions.create, {
      title: "Old work",
      goal: "Retention",
      repositoryIds: [repositoryId],
    });
    const store = new LocalStateStore(join(repo.root, "state.sqlite"));
    cleanup.push(() => store.close());
    const identity = store.getOrCreateIdentity();
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: identity.instanceId,
      runtimeCapabilities: [{ runtime: "fake", capabilities: ["start"] }],
    });
    const repositories = new RepositoryRegistry(store, () => true);
    repositories.register({
      repositoryLocationId,
      repositoryId,
      workstationId,
      path: repo.path,
      expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
    });
    const workspaces = new WorkspaceManager(
      store,
      repositories,
      join(repo.root, "managed"),
      identity.instanceId,
      () => true,
    );
    const runtimes = new RuntimeRegistry();
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      workstationId as never,
      () => true,
    );
    const transport = new ConvexControlPlaneTransport(node, workstationId, identity.instanceId);
    const driver = new ControlPlaneDriver(
      store,
      workspaces,
      runtimes,
      manager,
      transport,
      workstationId,
    );
    const provision = async () => {
      const taskId = await user.mutation(api.tasks.create, {
        workSessionId,
        title: "Task",
        description: "Retention",
        kind: "implementation",
        priority: 1,
        runtimePolicy: { mode: "forced", runtime: "fake" },
      });
      return user.mutation(api.workspaces.request, {
        taskId,
        repositoryLocationId,
        baseRef: "main",
      });
    };
    const clean = await provision();
    const dirty = await provision();
    await driver.tick();
    const cleanPath = workspaces.inspect(clean).path;
    const dirtyPath = workspaces.inspect(dirty).path;
    writeFileSync(join(dirtyPath, "unsaved.txt"), "keep me\n");
    // The Session finished long ago; the backend still believes both worktrees are clean.
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query("tasks").collect();
      for (const task of tasks)
        await ctx.db.patch("tasks", task._id, { status: "failed", phase: "failed" });
      await ctx.db.patch("workSessions", workSessionId, {
        status: "failed",
        lastActivityAt: Date.now() - 4 * DAY,
      });
    });
    const backend = (id: Id<"workspaces">) =>
      t.run(async (ctx) => (await ctx.db.get("workspaces", id))!);
    expect((await backend(clean)).currentHeadSha).toBe(originalHead);
    expect(await t.mutation(internal.workspaces.sweepCleanup, {})).toBe(2);
    await driver.tick();
    expect(existsSync(cleanPath)).toBe(false);
    expect(await backend(clean)).toMatchObject({ status: "removed", cleanupStatus: "removed" });
    expect(await backend(dirty)).toMatchObject({
      status: "dirty",
      dirty: true,
      cleanupStatus: "failed",
      cleanupError: "DIRTY_WORKSPACE_PRESERVED",
    });
    expect(existsSync(join(dirtyPath, "unsaved.txt"))).toBe(true);
    const branches = git(repo.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    expect(branches).not.toContain(`zam/${repositoryId}/${clean}`);
    expect(branches).toContain(`zam/${repositoryId}/${dirty}`);
    expect(branches).toContain("feature/mine");
    expect(git(repo.path, ["worktree", "list", "--porcelain"])).not.toContain(cleanPath);
    expect(store.listPendingEvents()).toEqual([]);
    expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(git(repo.path, ["status", "--porcelain"])).toBe(originalStatus);
  });
});

it("keeps dispatching on a Mac with a long history of removed workspaces and settled runs", async () => {
  const f = await fixture();
  const sessionId = await f.session();
  const taskId = await f.task(sessionId);
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 1100; index++) {
      const workspaceId = await ctx.db.insert("workspaces", {
        workSessionId: sessionId,
        taskId,
        repositoryId: f.repositoryId,
        repositoryLocationId: f.repositoryLocationId,
        workstationId: f.workstationId,
        kind: "worktree",
        status: "removed",
        baseRef: "main",
        dirty: false,
        changedFileCount: 0,
        createdAt: NOW - 10 * DAY,
        updatedAt: NOW - 9 * DAY,
      });
      await ctx.db.insert("agentRuns", {
        workSessionId: sessionId,
        taskId,
        workspaceId,
        workstationId: f.workstationId,
        role: "builder",
        runtime: "fake",
        status: "completed",
        attempt: 1,
        lastActivityAt: NOW - 9 * DAY,
        completedAt: NOW - 9 * DAY,
      });
    }
  });
  await expect(
    f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId }),
  ).resolves.toBeNull();
});
