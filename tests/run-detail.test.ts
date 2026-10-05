import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./runDetail.ts": () => import("../convex/runDetail"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const mallory = await seedHuman(t, "mallory");
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const workstationId = await ctx.db.insert("workstations", {
      ownerId: alice.userId,
      name: "Mac",
      status: "online",
      registeredAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId: alice.userId,
      name: "app",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/repo",
      status: "available",
      updatedAt: now,
    });
    const workSessionId = await ctx.db.insert("workSessions", {
      ownerId: alice.userId,
      title: "S",
      goal: "g",
      status: "running",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 1,
      needsInputCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const taskId = await ctx.db.insert("tasks", {
      workSessionId,
      title: "Add API",
      description: "d",
      kind: "code",
      status: "running",
      runtimePolicyMode: "auto",
      priority: 1,
      createdAt: now,
      updatedAt: now,
      repairAttempts: 1,
    });
    const workspace = (sha: string, branchName: string) =>
      ctx.db.insert("workspaces", {
        workSessionId,
        taskId,
        repositoryId,
        repositoryLocationId,
        workstationId,
        kind: "worktree",
        status: "completed",
        baseRef: "main",
        baseSha: sha,
        branchName,
        currentHeadSha: sha,
        dirty: false,
        changedFileCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    const builderWorkspace = await workspace("a".repeat(40), "zamolxis/builder");
    const verifierWorkspace = await workspace("b".repeat(40), "zamolxis/verifier");
    const run = (role: "builder" | "verifier", workspaceId: Id<"workspaces">) =>
      ctx.db.insert("agentRuns", {
        workSessionId,
        taskId,
        workspaceId,
        workstationId,
        role,
        runtime: "codex",
        status: "completed",
        attempt: 1,
        lastActivityAt: now,
        initialHeadSha: "a".repeat(40),
        finalHeadSha: "b".repeat(40),
        finalChangedFileCount: 2,
      });
    const builderRunId = await run("builder", builderWorkspace);
    const verifierRunId = await run("verifier", verifierWorkspace);
    const verificationRunId = await ctx.db.insert("verificationRuns", {
      candidateRunId: builderRunId,
      verifierRunId,
      subjectSha: "b".repeat(40),
      createdAt: now,
    });
    await ctx.db.insert("evidence", {
      verificationRunId,
      verifierRunId,
      subjectSha: "b".repeat(40),
      modality: "static",
      result: "passed",
      summary: "typecheck ok",
      createdAt: now,
    });
    await ctx.db.insert("trustDecisions", {
      candidateRunId: builderRunId,
      subjectSha: "b".repeat(40),
      eligible: false,
      reasons: ["Missing behavioral evidence"],
      createdAt: now,
    });
    let sequence = 0;
    const event = (type: string, payload: unknown) =>
      ctx.db.insert("runEvents", {
        runId: builderRunId,
        workstationId,
        eventId: `e${++sequence}`,
        sequence,
        type,
        occurredAt: now + sequence,
        payload,
      });
    await event("run.started", {});
    await event("files.changed", { paths: ["src/a.ts", "src/b.ts"] });
    await event("tool.started", { tool: "command", summary: "Tool started" });
    await event("files.changed", { paths: ["src/a.ts", 7, "src/c.ts"] });
    return { builderRunId, verifierRunId };
  });
  return { t, alice, mallory, ...ids };
}

it("returns run, workspace, verification evidence and trust for the owner only", async () => {
  const { alice, mallory, builderRunId, verifierRunId } = await seed();
  const builder = await alice.user.query(api.runDetail.get, { runId: builderRunId });
  expect(builder.run).toMatchObject({
    role: "builder",
    runtime: "codex",
    finalChangedFileCount: 2,
  });
  expect(builder.workspace).toMatchObject({ branchName: "zamolxis/builder", baseRef: "main" });
  expect(builder.workspace).not.toHaveProperty("localPath");
  expect(builder.task).toMatchObject({ title: "Add API", repairAttempts: 1, repairLimit: 2 });
  expect(builder.verifications).toHaveLength(1);
  expect(builder.verifications[0]?.evidence).toEqual([
    expect.objectContaining({ modality: "static", result: "passed", summary: "typecheck ok" }),
  ]);
  expect(builder.trustDecisions).toEqual([
    expect.objectContaining({ eligible: false, reasons: ["Missing behavioral evidence"] }),
  ]);
  const verifier = await alice.user.query(api.runDetail.get, { runId: verifierRunId });
  expect(verifier.verifications[0]?.candidateRunId).toBe(builderRunId);
  expect(verifier.trustDecisions).toHaveLength(1);

  await expect(mallory.user.query(api.runDetail.get, { runId: builderRunId })).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    mallory.user.query(api.runDetail.changedFiles, { runId: builderRunId }),
  ).rejects.toThrow("FORBIDDEN");
});

it("collects distinct changed paths from files.changed events", async () => {
  const { alice, builderRunId } = await seed();
  expect(await alice.user.query(api.runDetail.changedFiles, { runId: builderRunId })).toEqual({
    paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    truncated: false,
  });
});

it("skips verification links that leave the run's session", async () => {
  const { t, alice, builderRunId, verifierRunId } = await seed();
  await t.run(async (ctx) => {
    const other = await ctx.db.insert("workSessions", {
      ownerId: alice.userId,
      title: "Other",
      goal: "g",
      status: "running",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 0,
      needsInputCount: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("agentRuns", verifierRunId, { workSessionId: other });
  });
  const detail = await alice.user.query(api.runDetail.get, { runId: builderRunId });
  expect(detail.verifications).toEqual([]);
});
