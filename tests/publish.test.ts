import { rmSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, expect, it } from "vitest";
import {
  ConvexControlPlaneTransport,
  parseExecutionCommand,
} from "../apps/node/src/convex-control-plane";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { git } from "../packages/git/src/repository-inspector";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import type { PullRequestRequest } from "../packages/node-core/src/github/github-api";
import { PublishingCredentials } from "../packages/node-core/src/github/publishing-credentials";
import { MemoryRepositoryTokenStore } from "../packages/node-core/src/github/token-store";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { RuntimeRegistry } from "../packages/runtime-core/src/runtime-registry";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./integration.ts": () => import("../convex/integration"),
  "./node.ts": () => import("../convex/node"),
  "./tasks.ts": () => import("../convex/tasks"),
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const SHA = "a1b2c3d".padEnd(40, "0");

// A task whose trusted commit is ready on a local integration branch (what
// completeIntegration leaves behind), seeded directly so each rule is tested in isolation.
async function fixture(options: { sha?: string; trusted?: boolean; integrated?: boolean } = {}) {
  const sha = options.sha ?? SHA;
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const bob = await seedHuman(t, "bob");
  const ids = await t.run(async (ctx) => {
    const ownerId = alice.userId;
    const workstationId = await ctx.db.insert("workstations", {
      ownerId,
      name: "computer",
      status: "online",
      registeredAt: 0,
      nodeAuthSubject: "device",
      nodeInstanceId: "instance",
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
      defaultBranch: "main",
      status: "available",
      updatedAt: 0,
    });
    const workSessionId = await ctx.db.insert("workSessions", {
      ownerId,
      title: "Session",
      goal: "goal",
      status: "completed",
      activeRunCount: 0,
      completedTaskCount: 1,
      totalTaskCount: 1,
      needsInputCount: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const taskId = await ctx.db.insert("tasks", {
      workSessionId,
      title: "Fix the login form",
      description: "Make the form submit.\n\nVerification failure:\nold failure",
      kind: "implementation",
      status: "completed",
      phase: "completed",
      runtimePolicyMode: "auto",
      priority: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    const workspace = (kind: "worktree" | "integration") =>
      ctx.db.insert("workspaces", {
        workSessionId,
        taskId,
        repositoryId,
        repositoryLocationId,
        workstationId,
        kind,
        status: "ready",
        baseRef: sha,
        baseSha: sha,
        currentHeadSha: sha,
        branchName: `zam/${kind}`,
        dirty: false,
        changedFileCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
    const candidateWorkspaceId = await workspace("worktree");
    const integrationWorkspaceId = await workspace("integration");
    const run = (role: "builder" | "verifier") =>
      ctx.db.insert("agentRuns", {
        workSessionId,
        taskId,
        workspaceId: candidateWorkspaceId,
        workstationId,
        role,
        runtime: "fake",
        status: "completed",
        attempt: 1,
        lastActivityAt: 0,
        completedAt: 1,
        finalHeadSha: sha,
      });
    const candidateRunId = await run("builder");
    const verifierRunId = await run("verifier");
    const trustDecisionId = await ctx.db.insert("trustDecisions", {
      candidateRunId,
      subjectSha: sha,
      eligible: options.trusted ?? true,
      reasons: [],
      createdAt: 0,
    });
    const verificationRunId = await ctx.db.insert("verificationRuns", {
      candidateRunId,
      verifierRunId,
      subjectSha: sha,
      trustDecisionId,
      createdAt: 0,
    });
    await ctx.db.insert("evidence", {
      verificationRunId,
      verifierRunId,
      subjectSha: sha,
      modality: "test",
      result: "passed",
      summary: "pnpm test: 12 passed",
      createdAt: 0,
    });
    if (options.integrated ?? true)
      await ctx.db.insert("artifacts", {
        workSessionId,
        taskId,
        kind: "integration_branch",
        name: "zam/integration",
        storage: "git",
        locator: sha,
        createdAt: 0,
      });
    await ctx.db.patch("tasks", taskId, {
      candidateRunId,
      integrationWorkspaceId,
      trustDecisionId,
      lastTrustDecisionId: trustDecisionId,
      verificationRunId,
    });
    return { workstationId, repositoryId, repositoryLocationId, taskId, integrationWorkspaceId };
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  const task = () => t.run((ctx) => ctx.db.get("tasks", ids.taskId)) as Promise<Doc<"tasks">>;
  const commands = () =>
    t.run((ctx) =>
      ctx.db
        .query("commands")
        .filter((q) => q.eq(q.field("type"), "integration.publish"))
        .collect(),
    );
  const claim = async (commandId: Id<"commands">) =>
    node.mutation(api.node.claim, {
      workstationId: ids.workstationId,
      commandId,
      instanceId: "instance",
    });
  return { t, sha, user: alice.user, other: bob.user, node, ...ids, task, commands, claim };
}

it("publishes only on the owner's request, once, to a Zamolxis branch with evidence", async () => {
  const f = await fixture();
  const preview = await f.user.query(api.integration.publication, { taskId: f.taskId });
  expect(preview).toMatchObject({
    ready: true,
    status: "none",
    branch: "zamolxis/fix-the-login-form-a1b2c3d",
    base: "main",
    title: "Fix the login form",
  });
  // Nothing is published until asked.
  expect(await f.commands()).toHaveLength(0);
  await expect(f.other.mutation(api.integration.publish, { taskId: f.taskId })).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(f.other.query(api.integration.publication, { taskId: f.taskId })).rejects.toThrow(
    "FORBIDDEN",
  );
  const first = await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  const again = await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  expect(first).toEqual({ status: "pending", branch: "zamolxis/fix-the-login-form-a1b2c3d" });
  expect(again).toEqual(first);
  const [command, ...rest] = await f.commands();
  expect(rest).toHaveLength(0);
  expect(command).toMatchObject({
    workstationId: f.workstationId,
    targetType: "task",
    targetId: f.taskId,
    status: "pending",
  });
  expect(command!.payload).toMatchObject({
    taskId: f.taskId,
    workspaceId: f.integrationWorkspaceId,
    branch: "zamolxis/fix-the-login-form-a1b2c3d",
    base: "main",
    subjectSha: f.sha,
    title: "Fix the login form",
  });
  const body = command!.payload.body as string;
  expect(body).toContain("Make the form submit.");
  expect(body).not.toContain("old failure");
  expect(body).toContain("- test: passed — pnpm test: 12 passed");
  expect(body).toContain(f.sha);
  expect(body).toContain("Opened by Zamolxis; merge is a human decision.");
  // The Node parses it into the command it executes.
  expect(parseExecutionCommand(command).type).toBe("integration.publish");
  expect((await f.task()).publishStatus).toBe("pending");
});

it("refuses untrusted, unintegrated or moved work", async () => {
  for (const options of [{ trusted: false }, { integrated: false }]) {
    const f = await fixture(options);
    await expect(f.user.mutation(api.integration.publish, { taskId: f.taskId })).rejects.toThrow(
      "PUBLISH_NOT_READY",
    );
    expect((await f.user.query(api.integration.publication, { taskId: f.taskId })).ready).toBe(
      false,
    );
  }
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.patch("workspaces", f.integrationWorkspaceId, { currentHeadSha: "b".repeat(40) }),
  );
  await expect(f.user.mutation(api.integration.publish, { taskId: f.taskId })).rejects.toThrow(
    "PUBLISH_NOT_READY",
  );
  await f.t.run((ctx) =>
    ctx.db.patch("workspaces", f.integrationWorkspaceId, { currentHeadSha: f.sha, dirty: true }),
  );
  await expect(f.user.mutation(api.integration.publish, { taskId: f.taskId })).rejects.toThrow(
    "PUBLISH_NOT_READY",
  );
  await f.t.run((ctx) => ctx.db.patch("workspaces", f.integrationWorkspaceId, { dirty: false }));
  await f.t.run((ctx) =>
    ctx.db.patch("tasks", f.taskId, { phase: "integrating", status: "running" }),
  );
  await expect(f.user.mutation(api.integration.publish, { taskId: f.taskId })).rejects.toThrow(
    "PUBLISH_NOT_READY",
  );
});

it("records the Node's result, fails visibly and allows a retry after failure", async () => {
  const f = await fixture();
  await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  const [command] = await f.commands();
  await f.claim(command!._id);
  await f.node.mutation(api.node.failCommand, {
    workstationId: f.workstationId,
    commandId: command!._id,
    instanceId: "instance",
    code: "PUBLISH_PUSH_FAILED",
  });
  let task = await f.task();
  expect(task).toMatchObject({ publishStatus: "failed", publishError: "PUBLISH_PUSH_FAILED" });
  // The trusted work is unaffected by a failed publication.
  expect(task).toMatchObject({ status: "completed", phase: "completed" });
  const session = await f.t.run((ctx) => ctx.db.get("workSessions", task.workSessionId));
  expect(session?.status).toBe("completed");

  await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  const retry = (await f.commands()).find((item) => item._id !== command!._id)!;
  expect(retry.idempotencyKey).toBe(`publish:${f.taskId}:2`);
  expect((await f.task()).publishError).toBeUndefined();
  const result = {
    workstationId: f.workstationId,
    commandId: retry._id,
    taskId: f.taskId,
    subjectSha: f.sha,
    remoteBranch: "zamolxis/fix-the-login-form-a1b2c3d",
    base: "main",
    prUrl: "https://github.com/team/repo/pull/5",
    compareUrl: "https://github.com/team/repo/compare/main...zamolxis/fix-the-login-form-a1b2c3d",
  };
  // Results must match the authorized command; an unclaimed command has no result yet.
  await expect(f.node.mutation(api.integration.completePublish, result)).rejects.toThrow(
    "INVALID_PUBLISH_PROVENANCE",
  );
  await f.claim(retry._id);
  for (const forged of [
    { remoteBranch: "main" },
    { subjectSha: "c".repeat(40) },
    { base: "develop" },
    { commandId: command!._id },
  ])
    await expect(
      f.node.mutation(api.integration.completePublish, { ...result, ...forged }),
    ).rejects.toThrow("INVALID_PUBLISH_PROVENANCE");
  await expect(
    f.node.mutation(api.integration.completePublish, { ...result, prUrl: "javascript:alert(1)" }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  // Another owner's device cannot report it.
  const forgedNode = f.t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "bob",
  });
  await expect(forgedNode.mutation(api.integration.completePublish, result)).rejects.toThrow(
    "FORBIDDEN",
  );
  await f.node.mutation(api.integration.completePublish, result);
  await f.node.mutation(api.integration.completePublish, result);
  await f.node.mutation(api.node.recoverCompletedCommand, {
    workstationId: f.workstationId,
    commandId: retry._id,
    instanceId: "instance",
  });
  task = await f.task();
  expect(task).toMatchObject({
    publishStatus: "published",
    prUrl: result.prUrl,
    compareUrl: result.compareUrl,
    publishBase: "main",
  });
  expect(await f.user.mutation(api.integration.publish, { taskId: f.taskId })).toEqual({
    status: "published",
    branch: result.remoteBranch,
  });
  expect(await f.commands()).toHaveLength(2);
  expect(await f.user.query(api.integration.publication, { taskId: f.taskId })).toMatchObject({
    status: "published",
    prUrl: result.prUrl,
  });
});

it("does not complete a publish command whose result was never recorded", async () => {
  const f = await fixture();
  await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  const [command] = await f.commands();
  await f.claim(command!._id);
  await expect(
    f.node.mutation(api.node.recoverCompletedCommand, {
      workstationId: f.workstationId,
      commandId: command!._id,
      instanceId: "instance",
    }),
  ).rejects.toThrow("RECONCILIATION_REQUIRED");
});

it("publishes end to end: owner request → Node push to a local bare origin → pull request link", async () => {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const sha = git(repo.path, ["rev-parse", "HEAD"]);
  const originalStatus = git(repo.path, ["status", "--porcelain"]);
  // origin stays the registered https URL; pushes are rewritten to a disposable bare repository.
  const remote = join(repo.root, "remote.git");
  git(repo.root, ["init", "--bare", "-b", "main", remote]);
  git(repo.path, [
    "config",
    `url.${remote}.pushInsteadOf`,
    "https://example.invalid/team/repo.git",
  ]);
  const f = await fixture({ sha });
  const store = new LocalStateStore(":memory:");
  cleanup.push(() => store.close());
  const repositories = new RepositoryRegistry(store, () => true);
  repositories.register({
    repositoryLocationId: f.repositoryLocationId,
    repositoryId: f.repositoryId,
    workstationId: f.workstationId,
    path: repo.path,
    expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
  });
  const workspaces = new WorkspaceManager(
    store,
    repositories,
    join(repo.root, "managed"),
    "instance",
    () => true,
  );
  workspaces.provision({
    workspaceId: f.integrationWorkspaceId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: sha,
    kind: "integration",
  });
  const runtimes = new RuntimeRegistry();
  const opened: PullRequestRequest[] = [];
  const githubTokens = new MemoryRepositoryTokenStore();
  githubTokens.write(
    { host: "example.invalid", owner: "team", repo: "repo" },
    `github_pat_${"T0k3nV4lue".repeat(8)}`,
  );
  const driver = new ControlPlaneDriver(
    store,
    workspaces,
    runtimes,
    new RuntimeManager(store, workspaces, runtimes, f.workstationId as never, () => true),
    new ConvexControlPlaneTransport(f.node, f.workstationId, "instance"),
    f.workstationId,
    {
      githubHosts: ["example.invalid"],
      githubCredentials: new PublishingCredentials({ tokens: githubTokens }),
      github: {
        checkAccess: async () => ({ status: "ok", login: "publisher", checkedAt: Date.now() }),
        openPullRequest: async (input) => {
          opened.push(input);
          return "https://example.invalid/team/repo/pull/1";
        },
      },
    },
  );
  await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  await driver.tick();
  const branch = `zamolxis/fix-the-login-form-${sha.slice(0, 7)}`;
  expect(git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(sha);
  // Nothing was pushed to the default branch.
  expect(() => git(remote, ["rev-parse", "--verify", "refs/heads/main"])).toThrow();
  expect(opened).toEqual([
    expect.objectContaining({ base: "main", head: branch, title: "Fix the login form" }),
  ]);
  expect(await f.task()).toMatchObject({
    publishStatus: "published",
    prUrl: "https://example.invalid/team/repo/pull/1",
    publishBranch: branch,
  });
  const [command] = await f.commands();
  expect(command?.status).toBe("completed");
  // The canonical checkout is untouched.
  expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(sha);
  expect(git(repo.path, ["status", "--porcelain"])).toBe(originalStatus);
});
