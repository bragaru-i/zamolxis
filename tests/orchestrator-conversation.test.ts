import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./orchestrator.ts": () => import("../convex/orchestrator"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./workstations.ts": () => import("../convex/workstations"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./runs.ts": () => import("../convex/runs"),
  "./events.ts": () => import("../convex/events"),
  "./node.ts": () => import("../convex/node"),
  "./traces.ts": () => import("../convex/traces"),
  "./trust.ts": () => import("../convex/trust"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  await user.mutation(api.profiles.ensure, {});
  await other.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Node",
    nodeAuthSubject: "device",
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  await node.mutation(api.node.heartbeat, {
    workstationId,
    instanceId: "instance",
    runtimeCapabilities: [{ runtime: "codex", capabilities: ["start", "stop"] }],
  });
  const repositoryId = await user.mutation(api.repositories.create, { name: "Repo" });
  await node.mutation(api.node.registerLocation, {
    workstationId,
    repositoryId,
    canonicalPath: "/canonical",
    gitCommonDir: "/canonical/.git",
    headSha: "base",
  });
  const productId = await t.run(async (ctx) => {
    const repository = await ctx.db.get("repositories", repositoryId);
    if (!repository) throw new Error("Missing repository");
    const id = await ctx.db.insert("products", {
      ownerId: repository.ownerId,
      name: "Product",
      slug: "product",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", repositoryId, { productId: id });
    return id;
  });
  return { t, user, other, productId, repositoryId };
}

it("answers a status question without creating hidden work", async () => {
  const f = await fixture();
  const result = await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "status-1",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(result).toMatchObject({ route: "answer" });
  expect(result).not.toHaveProperty("workSessionId");
  const state = await f.t.run(async (ctx) => ({
    sessions: await ctx.db.query("workSessions").collect(),
    commands: await ctx.db.query("textCommands").collect(),
    conversations: await ctx.db.query("orchestratorConversations").collect(),
  }));
  expect(state.sessions).toHaveLength(0);
  expect(state.commands).toHaveLength(0);
  expect(state.conversations).toHaveLength(1);
  const messages = await f.user.query(api.orchestrator.messages, {});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    route: "answer",
    text: "What is going on?",
    links: [],
  });
  expect(messages[0]?.reply).toContain("did not open one");
  expect(await f.other.query(api.orchestrator.messages, {})).toEqual([]);
});

it("summarizes existing sessions and returns typed navigation links", async () => {
  const f = await fixture();
  const sessionId = await f.t.run(async (ctx) => {
    const product = await ctx.db.get("products", f.productId);
    if (!product) throw new Error("Missing product");
    const id = await ctx.db.insert("workSessions", {
      ownerId: product.ownerId,
      productId: f.productId,
      title: "Alpha readiness",
      goal: "Finish alpha",
      status: "needs_input",
      activeRunCount: 0,
      completedTaskCount: 2,
      totalTaskCount: 3,
      needsInputCount: 1,
      lastActivityAt: 10,
      createdAt: 1,
      updatedAt: 10,
    });
    await ctx.db.insert("sessionRepositories", {
      workSessionId: id,
      repositoryId: f.repositoryId,
      role: "primary",
    });
    return id;
  });
  await f.user.mutation(api.orchestrator.submit, {
    text: "Current project status?",
    idempotencyKey: "status-2",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  const [message] = await f.user.query(api.orchestrator.messages, {});
  if (!message) throw new Error("Missing Orchestrator answer");
  expect(message.reply).toContain("2/3 tasks complete");
  expect(message.reply).toContain("did not open a new Work Session");
  expect(message.links).toEqual([
    expect.objectContaining({
      targetType: "session",
      targetId: sessionId,
      workSessionId: sessionId,
      label: "Alpha readiness",
      status: "needs_input",
    }),
  ]);
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(1);

  const continuation = await f.user.mutation(api.orchestrator.submit, {
    text: "Do it",
    idempotencyKey: "status-follow-up",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(continuation).toMatchObject({ route: "continue", workSessionId: sessionId });
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(1);
});

it("opens work only for an explicit command, continues its link and stays idempotent", async () => {
  const f = await fixture();
  const first = await f.user.mutation(api.orchestrator.submit, {
    text: "Fix the alpha blocker",
    idempotencyKey: "work-1",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(first.route).toBe("create");
  expect(first.workSessionId).toBeDefined();

  const secondArgs = {
    text: "Continue with that",
    idempotencyKey: "work-2",
    productId: f.productId,
    repositoryId: f.repositoryId,
  } as const;
  const second = await f.user.mutation(api.orchestrator.submit, secondArgs);
  expect(second).toMatchObject({ route: "continue", workSessionId: first.workSessionId });
  expect(await f.user.mutation(api.orchestrator.submit, secondArgs)).toEqual(second);

  const state = await f.t.run(async (ctx) => ({
    sessions: await ctx.db.query("workSessions").collect(),
    orchestratorMessages: await ctx.db.query("orchestratorMessages").collect(),
    supervisorMessages: await ctx.db.query("textCommands").collect(),
  }));
  expect(state.sessions).toHaveLength(1);
  expect(state.orchestratorMessages).toHaveLength(2);
  expect(state.supervisorMessages).toHaveLength(2);
  const messages = await f.user.query(api.orchestrator.messages, {});
  expect(messages[0]?.links[0]).toMatchObject({ workSessionId: first.workSessionId });
  expect(messages[1]?.links[0]).toMatchObject({ workSessionId: first.workSessionId });
});

it("links approvals, pull requests, attention Tasks, trust and active Runs in a status answer", async () => {
  const f = await fixture();
  const seeded = await f.t.run(async (ctx) => {
    const product = await ctx.db.get("products", f.productId);
    const location = await ctx.db.query("repositoryLocations").first();
    if (!product || !location) throw new Error("Missing fixture");
    const now = 10;
    const sessionId = await ctx.db.insert("workSessions", {
      ownerId: product.ownerId,
      productId: f.productId,
      title: "Checkout",
      goal: "Fix checkout",
      status: "running",
      activeRunCount: 1,
      completedTaskCount: 0,
      totalTaskCount: 3,
      needsInputCount: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const task = (title: string, extra: Record<string, unknown>) =>
      ctx.db.insert("tasks", {
        workSessionId: sessionId,
        title,
        description: title,
        kind: "code",
        status: "running",
        runtimePolicyMode: "auto",
        priority: 0,
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
    const blockedTaskId = await task("Pick a payment provider", { phase: "needs_input" });
    const publishedTaskId = await task("Fix totals", {
      phase: "completed",
      status: "completed",
      publishStatus: "published",
      prUrl: "https://github.com/acme/shop/pull/7",
    });
    const unsafeTaskId = await task("Unsafe link", { prUrl: "javascript:alert(1)" });
    const workspaceId = await ctx.db.insert("workspaces", {
      workSessionId: sessionId,
      taskId: blockedTaskId,
      repositoryId: f.repositoryId,
      repositoryLocationId: location._id,
      workstationId: location.workstationId,
      kind: "worktree",
      status: "in_use",
      baseRef: "HEAD",
      dirty: false,
      changedFileCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const run = (taskId: typeof blockedTaskId, status: "running" | "completed") =>
      ctx.db.insert("agentRuns", {
        workSessionId: sessionId,
        taskId,
        workspaceId,
        workstationId: location.workstationId,
        role: "builder",
        runtime: "codex",
        status,
        attempt: 1,
        lastActivityAt: now,
      });
    const activeRunId = await run(blockedTaskId, "running");
    await run(publishedTaskId, "completed");
    const trustId = await ctx.db.insert("trustDecisions", {
      candidateRunId: activeRunId,
      subjectSha: "abc",
      eligible: false,
      reasons: ["verifier failed"],
      createdAt: now,
    });
    await ctx.db.patch("tasks", blockedTaskId, { lastTrustDecisionId: trustId });
    const approvalId = await ctx.db.insert("approvals", {
      ownerId: product.ownerId,
      workSessionId: sessionId,
      runId: activeRunId,
      action: "network access",
      risk: "medium",
      request: {},
      status: "pending",
      requestedAt: now,
    });
    return {
      sessionId,
      blockedTaskId,
      publishedTaskId,
      unsafeTaskId,
      activeRunId,
      trustId,
      approvalId,
    };
  });

  const result = await f.user.mutation(api.orchestrator.submit, {
    text: "What needs me?",
    idempotencyKey: "typed-links",
    productId: f.productId,
  });
  expect(result.route).toBe("answer");
  const [message] = await f.user.query(api.orchestrator.messages, {});
  const links = (message?.links ?? []).map(
    (link: { targetType: string; targetId: string; status?: string; url?: string }) => ({
      targetType: link.targetType,
      targetId: link.targetId,
      status: link.status,
      url: link.url,
    }),
  );
  expect(links).toEqual([
    { targetType: "session", targetId: seeded.sessionId, status: "running", url: undefined },
    { targetType: "approval", targetId: seeded.approvalId, status: "medium", url: undefined },
    {
      targetType: "pull_request",
      targetId: seeded.publishedTaskId,
      status: "published",
      url: "https://github.com/acme/shop/pull/7",
    },
    { targetType: "task", targetId: seeded.blockedTaskId, status: "needs_input", url: undefined },
    { targetType: "trust", targetId: seeded.trustId, status: "not_trusted", url: undefined },
    { targetType: "run", targetId: seeded.activeRunId, status: "running", url: undefined },
  ]);
  for (const link of message?.links ?? []) expect(link.workSessionId).toBe(seeded.sessionId);
  expect(await f.other.query(api.orchestrator.messages, {})).toEqual([]);
  // A status answer stays read-only.
  const counts = await f.t.run(async (ctx) => ({
    sessions: (await ctx.db.query("workSessions").collect()).length,
    runs: (await ctx.db.query("agentRuns").collect()).length,
    commands: (await ctx.db.query("textCommands").collect()).length,
  }));
  expect(counts).toEqual({ sessions: 1, runs: 2, commands: 0 });
});
