import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// `runs.listActive`: the owner's agents working right now, across Sessions (Home "Working now").

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./workstations.ts": () => import("../convex/workstations"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./runs.ts": () => import("../convex/runs"),
  "./node.ts": () => import("../convex/node"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const { user: other, userId: otherId } = await seedHuman(t, "bob");
  await user.mutation(api.profiles.ensure, {});
  await other.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Node",
    nodeAuthSubject: "device",
  });
  const now = 1_000_000;
  const seeded = await t.run(async (ctx) => {
    const session = (ownerId: typeof userId, title: string, status: "running" | "planning") =>
      ctx.db.insert("workSessions", {
        ownerId,
        title,
        goal: title,
        status,
        activeRunCount: 0,
        completedTaskCount: 0,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    const running = await session(userId, "Checkout", "running");
    const planning = await session(userId, "Invoices", "planning");
    const foreign = await session(otherId, "Bob's work", "running");
    const task = (workSessionId: typeof running, title: string) =>
      ctx.db.insert("tasks", {
        workSessionId,
        title,
        description: title,
        kind: "code",
        status: "running",
        runtimePolicyMode: "auto",
        priority: 0,
        createdAt: now,
        updatedAt: now,
      });
    const taskId = await task(running, "Fix totals");
    const foreignTaskId = await task(foreign, "Bob's task");
    const productId = await ctx.db.insert("products", {
      ownerId: userId,
      name: "P",
      slug: "p",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId: userId,
      productId,
      name: "Repo",
      remoteUrl: "https://example.com/repo.git",
      createdAt: now,
      updatedAt: now,
    });
    const location = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/canonical",
      gitCommonDir: "/canonical/.git",
      status: "available",
      updatedAt: now,
    });
    const workspace = (workSessionId: typeof running, id: typeof taskId) =>
      ctx.db.insert("workspaces", {
        workSessionId,
        taskId: id,
        repositoryId,
        repositoryLocationId: location,
        workstationId,
        kind: "worktree",
        status: "in_use",
        baseRef: "HEAD",
        dirty: false,
        changedFileCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    const workspaceId = await workspace(running, taskId);
    const foreignWorkspaceId = await workspace(foreign, foreignTaskId);
    const run = (
      workSessionId: typeof running,
      id: typeof taskId,
      wsId: typeof workspaceId,
      extra: Partial<Parameters<typeof ctx.db.insert<"agentRuns">>[1]>,
    ) =>
      ctx.db.insert("agentRuns", {
        workSessionId,
        taskId: id,
        workspaceId: wsId,
        workstationId,
        runtime: "codex",
        status: "queued",
        attempt: 1,
        lastActivityAt: now,
        ...extra,
      });
    const builder = await run(running, taskId, workspaceId, {
      role: "builder",
      status: "running",
      modelRequested: "gpt-5",
      modelActual: "gpt-5-codex",
      totalTokens: 1234,
      estimatedCostUsd: 0.12,
      activityLabel: "Running tests",
      startedAt: now - 60_000,
    });
    await run(running, taskId, workspaceId, {
      role: "verifier",
      status: "completed",
      completedAt: now,
    });
    await run(foreign, foreignTaskId, foreignWorkspaceId, { role: "builder", status: "running" });
    const textCommandId = await ctx.db.insert("textCommands", {
      ownerId: userId,
      idempotencyKey: "k1",
      text: "Add VAT lines",
      productId,
      repositoryId,
      workSessionId: planning,
      modelActual: "gpt-5",
      totalTokens: 300,
      supervisorActivity: "Reading the repository",
      supervisorStartedAt: now - 5_000,
    });
    await ctx.db.insert("commands", {
      workstationId,
      type: "repository.plan",
      targetType: "textCommand",
      targetId: textCommandId,
      idempotencyKey: `plan:${textCommandId}`,
      status: "claimed",
      payload: {},
      createdAt: now,
    });
    return { running, planning, builder, textCommandId };
  });
  return { t, user, other, ...seeded };
}

it("lists the owner's active runs and in-flight Supervisor turns with model and usage", async () => {
  const f = await fixture();
  const agents = await f.user.query(api.runs.listActive, {});
  expect(agents).toHaveLength(2);
  expect(agents[0]).toMatchObject({
    kind: "run",
    _id: f.builder,
    workSessionId: f.running,
    sessionTitle: "Checkout",
    taskTitle: "Fix totals",
    role: "builder",
    runtime: "codex",
    status: "running",
    modelRequested: "gpt-5",
    modelActual: "gpt-5-codex",
    totalTokens: 1234,
    costUsd: 0.12,
    activityLabel: "Running tests",
  });
  expect(agents[1]).toMatchObject({
    kind: "supervisor",
    _id: f.textCommandId,
    workSessionId: f.planning,
    sessionTitle: "Invoices",
    role: "supervisor",
    status: "running",
    modelActual: "gpt-5",
    totalTokens: 300,
    activityLabel: "Reading the repository",
  });
  // Completed runs never appear, and each owner sees only their own agents.
  expect(agents.map((agent: { role: string }) => agent.role)).not.toContain("verifier");
  const others = await f.other.query(api.runs.listActive, {});
  expect(others).toHaveLength(1);
  expect(others[0]).toMatchObject({ sessionTitle: "Bob's work", role: "builder" });
});
