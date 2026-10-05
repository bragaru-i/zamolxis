import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./supervisor.ts": () => import("./supervisor"),
  "./profiles.ts": () => import("./profiles"),
  "./workstations.ts": () => import("./workstations"),
  "./repositories.ts": () => import("./repositories"),
  "./sessions.ts": () => import("./sessions"),
  "./tasks.ts": () => import("./tasks"),
  "./workspaces.ts": () => import("./workspaces"),
  "./runs.ts": () => import("./runs"),
  "./events.ts": () => import("./events"),
  "./node.ts": () => import("./node"),
  "./trust.ts": () => import("./trust"),
  "./traces.ts": () => import("./traces"),
  "./approvals.ts": () => import("./approvals"),
};
async function fixture() {
  const t = convexTest(schema, modules);
  const user = t.withIdentity({
    subject: "alice",
    issuer: "https://identity.example",
    tokenIdentifier: "alice",
  });
  const other = t.withIdentity({
    subject: "bob",
    issuer: "https://identity.example",
    tokenIdentifier: "bob",
  });
  await user.mutation(api.profiles.ensure, {});
  await other.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Node",
    nodeAuthSubject: "device",
  });
  const node = t.withIdentity({
    subject: "device",
    issuer: "https://identity.example",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  await node.mutation(api.node.heartbeat, {
    workstationId,
    instanceId: "instance",
    runtimeCapabilities: [{ runtime: "fake", capabilities: ["start", "stop", "message"] }],
  });
  const repositoryId = await user.mutation(api.repositories.create, { name: "Repo" });
  const repositoryLocationId = await node.mutation(api.node.registerLocation, {
    workstationId,
    repositoryId,
    canonicalPath: "/canonical",
    gitCommonDir: "/canonical/.git",
    headSha: "base",
  });
  const workSessionId = await user.mutation(api.sessions.create, {
    title: "Session",
    goal: "Build",
    repositoryIds: [repositoryId],
  });
  const taskId = await user.mutation(api.tasks.create, {
    workSessionId,
    title: "Task",
    description: "Execute",
    kind: "implementation",
    priority: 1,
    runtimePolicy: { mode: "forced", runtime: "fake" },
  });
  const workspaceId = await user.mutation(api.workspaces.request, {
    taskId,
    repositoryLocationId,
    baseRef: "main",
  });
  const command = required((await node.query(api.node.listPending, { workstationId }))[0]);
  await node.mutation(api.node.claim, {
    workstationId,
    commandId: command._id,
    instanceId: "instance",
  });
  await node.mutation(api.node.markReady, {
    workstationId,
    workspaceId,
    commandId: command._id,
    localPath: "/isolated",
    baseSha: "base",
    branchName: "task",
    headSha: "base",
  });
  await node.mutation(api.node.completeCommand, {
    workstationId,
    commandId: command._id,
    instanceId: "instance",
  });
  return {
    t,
    user,
    other,
    node,
    workstationId,
    repositoryId,
    repositoryLocationId,
    workSessionId,
    taskId,
    workspaceId,
  };
}
async function started(f: Awaited<ReturnType<typeof fixture>>) {
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId: f.workspaceId,
    runtime: "fake",
  });
  const command = required(
    (await f.node.query(api.node.listPending, { workstationId: f.workstationId }))[0],
  );
  await f.node.mutation(api.node.claim, {
    workstationId: f.workstationId,
    commandId: command._id,
    instanceId: "instance",
  });
  await f.node.mutation(api.node.ingestBatch, {
    workstationId: f.workstationId,
    runId,
    events: [
      {
        eventId: "start",
        sequence: 1,
        type: "run.started",
        occurredAt: 1,
        payload: { nativeSessionId: "fake:run" },
      },
    ],
  });
  return runId;
}
it("enforces user, device and repository ownership including revoked identities", async () => {
  const f = await fixture();
  await expect(f.other.query(api.sessions.get, { workSessionId: f.workSessionId })).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    f.user.query(api.node.listPending, { workstationId: f.workstationId }),
  ).rejects.toThrow("FORBIDDEN");
  const forged = f.t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "bob",
  });
  await expect(
    forged.query(api.node.listPending, { workstationId: f.workstationId }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.other.mutation(api.sessions.create, {
      title: "Bad",
      goal: "Bad",
      repositoryIds: [f.repositoryId],
    }),
  ).rejects.toThrow("FORBIDDEN");
  await f.user.mutation(api.workstations.revoke, { workstationId: f.workstationId });
  await expect(
    f.node.query(api.node.listPending, { workstationId: f.workstationId }),
  ).rejects.toThrow("FORBIDDEN");
});
it("deduplicates allocation, run requests and messages but rejects changed retry content", async () => {
  const f = await fixture();
  const runId = await started(f);
  expect(
    await f.user.mutation(api.workspaces.request, {
      taskId: f.taskId,
      repositoryLocationId: f.repositoryLocationId,
      baseRef: "main",
    }),
  ).toBe(f.workspaceId);
  expect(
    await f.user.mutation(api.runs.request, {
      taskId: f.taskId,
      workspaceId: f.workspaceId,
      runtime: "fake",
    }),
  ).toBe(runId);
  const request = { runId, message: "Continue", idempotencyKey: "one" };
  const commandId = await f.user.mutation(api.runs.sendMessage, request);
  expect(await f.user.mutation(api.runs.sendMessage, request)).toBe(commandId);
  await expect(
    f.user.mutation(api.runs.sendMessage, { ...request, message: "Changed" }),
  ).rejects.toThrow("COMMAND_CONFLICT");
});
it("rejects out-of-order/conflicting events and settles counters once, unblocking dependencies", async () => {
  const f = await fixture();
  const dependent = await f.user.mutation(api.tasks.create, {
    workSessionId: f.workSessionId,
    title: "Next",
    description: "Next",
    kind: "test",
    priority: 1,
    runtimePolicy: { mode: "auto" },
    dependencies: [{ taskId: f.taskId, type: "success" }],
  });
  const runId = await started(f);
  const event = {
    eventId: "finish",
    sequence: 2,
    type: "run.completed" as const,
    occurredAt: 2,
    payload: { summary: "Done" },
  };
  await expect(
    f.node.mutation(api.node.ingestBatch, {
      workstationId: f.workstationId,
      runId,
      events: [{ ...event, sequence: 3 }],
    }),
  ).rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
  for (let i = 0; i < 2; i++)
    expect(
      await f.node.mutation(api.node.ingestBatch, {
        workstationId: f.workstationId,
        runId,
        events: [event],
      }),
    ).toEqual(["finish"]);
  await expect(
    f.node.mutation(api.node.ingestBatch, {
      workstationId: f.workstationId,
      runId,
      events: [{ ...event, payload: { summary: "Changed" } }],
    }),
  ).rejects.toThrow("COMMAND_CONFLICT");
  for (let i = 0; i < 2; i++)
    await f.node.mutation(api.node.completeRun, {
      workstationId: f.workstationId,
      runId,
      headSha: "result",
      dirty: false,
      changedFileCount: 0,
    });
  const session = await f.user.query(api.sessions.get, { workSessionId: f.workSessionId });
  expect(session.activeRunCount).toBe(0);
  expect(session.completedTaskCount).toBe(1);
  expect(
    (await f.user.query(api.tasks.listBySession, { workSessionId: f.workSessionId })).find(
      (item) => item._id === dependent,
    )?.status,
  ).toBe("ready");
});
it("cancels a queued start without leaving ownership or a runnable command", async () => {
  const f = await fixture();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId: f.workspaceId,
    runtime: "fake",
  });
  await f.user.mutation(api.runs.stop, { runId });
  await f.user.mutation(api.runs.stop, { runId });
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("stopped");
  expect(await f.node.query(api.node.listPending, { workstationId: f.workstationId })).toEqual([]);
  expect(
    required(
      (await f.user.query(api.workspaces.listBySession, { workSessionId: f.workSessionId }))[0],
    ).ownerRunId,
  ).toBeUndefined();
  expect(
    (await f.user.query(api.sessions.get, { workSessionId: f.workSessionId })).activeRunCount,
  ).toBe(0);
});
it("treats missing native sessions as lost without replaying starts or releasing ownership", async () => {
  const f = await fixture();
  const runId = await started(f);
  await f.node.mutation(api.node.reconcile, {
    workstationId: f.workstationId,
    runId,
    observation: "missing",
  });
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("lost");
  expect(
    required(
      (await f.user.query(api.workspaces.listBySession, { workSessionId: f.workSessionId }))[0],
    ).ownerRunId,
  ).toBe(runId);
});
it("derives trust from independent evidence on the current candidate SHA; approval cannot override it", async () => {
  const f = await fixture();
  const candidateRunId = await started(f);
  await f.node.mutation(api.node.ingestBatch, {
    workstationId: f.workstationId,
    runId: candidateRunId,
    events: [{ eventId: "finish", sequence: 2, type: "run.completed", occurredAt: 2, payload: {} }],
  });
  await f.node.mutation(api.node.completeRun, {
    workstationId: f.workstationId,
    runId: candidateRunId,
    headSha: "result",
    dirty: false,
    changedFileCount: 0,
  });
  await expect(
    f.t.mutation(internal.trust.linkVerification, {
      candidateRunId,
      verifierRunId: candidateRunId,
    }),
  ).rejects.toThrow("INVALID_VERIFICATION_PROVENANCE");
  const approvalId = await f.t.mutation(internal.approvals.request, {
    workSessionId: f.workSessionId,
    runId: candidateRunId,
    action: "merge",
    risk: "high",
    request: { sha: "result" },
  });
  await f.user.mutation(api.approvals.resolve, { approvalId, decision: "approved" });
  await f.t.mutation(internal.trust.evaluate, { candidateRunId });
  expect(
    required((await f.user.query(api.trust.listByRun, { runId: candidateRunId }))[0]).eligible,
  ).toBe(false);
  const verifierRunId = await f.t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      workSessionId: f.workSessionId,
      repositoryId: f.repositoryId,
      repositoryLocationId: f.repositoryLocationId,
      workstationId: f.workstationId,
      kind: "worktree",
      status: "ready",
      baseRef: "result",
      baseSha: "result",
      currentHeadSha: "result",
      dirty: false,
      changedFileCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    return ctx.db.insert("agentRuns", {
      workSessionId: f.workSessionId,
      taskId: f.taskId,
      workspaceId,
      workstationId: f.workstationId,
      runtime: "fake",
      role: "verifier",
      status: "completed",
      attempt: 1,
      finalHeadSha: "result",
      lastActivityAt: 0,
    });
  });
  const verificationRunId = await f.t.mutation(internal.trust.linkVerification, {
    candidateRunId,
    verifierRunId,
  });
  for (const modality of ["static", "behavioral"] as const)
    await f.node.mutation(api.trust.recordEvidence, {
      workstationId: f.workstationId,
      verificationRunId,
      modality,
      result: "passed",
      summary: "Verified",
    });
  await f.t.mutation(internal.trust.evaluate, { candidateRunId });
  expect(
    required((await f.user.query(api.trust.listByRun, { runId: candidateRunId }))[0]).eligible,
  ).toBe(true);
  await f.node.mutation(api.node.reportSnapshot, {
    workstationId: f.workstationId,
    workspaceId: f.workspaceId,
    headSha: "changed",
    dirty: false,
    changedFileCount: 0,
  });
  await f.t.mutation(internal.trust.evaluate, { candidateRunId });
  expect(
    required((await f.user.query(api.trust.listByRun, { runId: candidateRunId }))[0]).eligible,
  ).toBe(false);
});

it("reserves three builder slots and an independent verifier slot; lost runs keep capacity until reconciled", async () => {
  const f = await fixture();
  const assignments = [];
  for (let i = 0; i < 5; i++) {
    const taskId = await f.user.mutation(api.tasks.create, {
      workSessionId: f.workSessionId,
      title: `Slot ${i}`,
      description: "Fixture",
      kind: i === 4 ? "verification" : "implementation",
      priority: i,
      runtimePolicy: { mode: "forced", runtime: "fake" },
    });
    const workspaceId = await f.t.run(async (ctx) => {
      const original = await ctx.db.get("workspaces", f.workspaceId);
      if (!original) throw new Error("Missing workspace");
      const { _id, _creationTime, ...fields } = original;
      return ctx.db.insert("workspaces", { ...fields, taskId, status: "ready" });
    });
    assignments.push({ taskId, workspaceId, runtime: "fake" });
  }
  for (const assignment of assignments.slice(0, 3))
    await f.user.mutation(api.runs.request, assignment);
  const fourth = assignments[3];
  const verifier = assignments[4];
  if (!fourth || !verifier) throw new Error("Missing assignment");
  await expect(f.user.mutation(api.runs.request, fourth)).rejects.toThrow("NODE_CAPACITY_EXCEEDED");
  await f.t.mutation(internal.runs.start, { ...verifier, role: "verifier" });
  const reserved = (
    await f.user.query(api.runs.listBySession, { workSessionId: f.workSessionId })
  ).find((run) => run.role === "builder");
  if (!reserved) throw new Error("Missing builder");
  await f.t.run(async (ctx) => {
    await ctx.db.patch("agentRuns", reserved._id, { status: "lost" });
  });
  await expect(f.user.mutation(api.runs.request, fourth)).rejects.toThrow("NODE_CAPACITY_EXCEEDED");
});

it("rejects cross-product repository sessions and preserves product identity on valid sessions", async () => {
  const f = await fixture();
  const { a, b } = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    if (!session) throw new Error("Missing session");
    const fields = { ownerId: session.ownerId, name: "Product", createdAt: 0, updatedAt: 0 };
    const a = await ctx.db.insert("products", { ...fields, slug: "a" });
    const b = await ctx.db.insert("products", { ...fields, slug: "b" });
    return { a, b };
  });
  const repositoryA = await f.user.mutation(api.repositories.create, { name: "A", productId: a });
  const repositoryB = await f.user.mutation(api.repositories.create, { name: "B", productId: b });
  await expect(
    f.user.mutation(api.sessions.create, {
      title: "Mixed",
      goal: "Mixed",
      repositoryIds: [repositoryA, repositoryB],
    }),
  ).rejects.toThrow("PRODUCT_MISMATCH");
  await expect(
    f.user.mutation(api.sessions.create, {
      title: "Mixed",
      goal: "Mixed",
      repositoryIds: [f.repositoryId, repositoryA],
    }),
  ).rejects.toThrow("PRODUCT_MISMATCH");
  const sessionId = await f.user.mutation(api.sessions.create, {
    title: "A",
    goal: "A",
    repositoryIds: [repositoryA],
  });
  expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).productId).toBe(a);
});

it("submits an idempotent text command, provisions before dispatch and isolates explicit session reuse", async () => {
  const f = await fixture();
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    if (!session) throw new Error("Missing session");
    const productId = await ctx.db.insert("products", {
      ownerId: session.ownerId,
      name: "A",
      slug: "a",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId });
    return productId;
  });
  await f.node.mutation(api.node.heartbeat, {
    workstationId: f.workstationId,
    instanceId: "instance",
    runtimeCapabilities: [{ runtime: "codex", capabilities: ["start"] }],
  });
  const input = {
    productId,
    repositoryId: f.repositoryId,
    text: "Implement an observable outcome",
    idempotencyKey: "first-command",
  };
  const sessionId = await f.user.mutation(api.supervisor.submit, input);
  expect(await f.user.mutation(api.supervisor.submit, input)).toBe(sessionId);
  await expect(
    f.user.mutation(api.supervisor.submit, { ...input, text: "Changed" }),
  ).rejects.toThrow("COMMAND_CONFLICT");
  await expect(
    f.user.mutation(api.supervisor.submit, {
      ...input,
      idempotencyKey: "wrong-session",
      sessionId: f.workSessionId,
    }),
  ).rejects.toThrow("PRODUCT_MISMATCH");
  const workspaces = await f.user.query(api.workspaces.listBySession, { workSessionId: sessionId });
  const workspace = workspaces[0];
  if (!workspace) throw new Error("Missing workspace");
  expect(workspace.status).toBe("requested");
  await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
  expect(await f.user.query(api.runs.listBySession, { workSessionId: sessionId })).toEqual([]);
  const command = (
    await f.node.query(api.node.listPending, { workstationId: f.workstationId })
  ).find((item) => item.targetId === workspace._id);
  if (!command) throw new Error("Missing provisioning command");
  await f.node.mutation(api.node.claim, {
    workstationId: f.workstationId,
    commandId: command._id,
    instanceId: "instance",
  });
  await f.node.mutation(api.node.markReady, {
    workstationId: f.workstationId,
    workspaceId: workspace._id,
    commandId: command._id,
    localPath: "/isolated-command",
    baseSha: "base",
    headSha: "base",
    branchName: "command",
  });
  await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
  const runs = await f.user.query(api.runs.listBySession, { workSessionId: sessionId });
  expect(runs).toHaveLength(1);
  expect(runs[0]?.role).toBe("builder");
  expect(runs[0]?.status).toBe("queued");
  await f.user.mutation(api.supervisor.submit, {
    ...input,
    idempotencyKey: "second-command",
    sessionId,
  });
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toHaveLength(2);
});
