import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { decideVerification } from "../convex/lib/lifecycle";
import schema from "../convex/schema";
import { TRACE_LIMITS } from "../convex/traces";
import { seedHuman } from "./fixtures/auth";

// Backend-side trace steps (#27): trust decision, integration and publish outcome are
// recorded once on the candidate Run's trace, next to the Node's own steps.
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./integration.ts": () => import("../convex/integration"),
  "./node.ts": () => import("../convex/node"),
  "./traces.ts": () => import("../convex/traces"),
  "./trust.ts": () => import("../convex/trust"),
};
const SHA = "c0ffee1".padEnd(40, "0");

// A Builder candidate at SHA and a completed independent Verifier with evidence, just
// before the backend decides trust (what node:complete leaves for decideVerification).
async function fixture(evidence: Array<["static" | "behavioral" | "test", "passed" | "failed"]>) {
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
      lastHeartbeatAt: Date.now(),
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
      status: "waiting",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 1,
      needsInputCount: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.insert("sessionRepositories", { workSessionId, repositoryId, role: "primary" });
    const taskId = await ctx.db.insert("tasks", {
      workSessionId,
      title: "Fix the login form",
      description: "Make the form submit.",
      kind: "implementation",
      status: "waiting",
      phase: "verifying",
      runtimePolicyMode: "auto",
      priority: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    const workspace = () =>
      ctx.db.insert("workspaces", {
        workSessionId,
        taskId,
        repositoryId,
        repositoryLocationId,
        workstationId,
        kind: "worktree",
        status: "ready",
        baseRef: SHA,
        baseSha: SHA,
        currentHeadSha: SHA,
        branchName: "zam/worktree",
        dirty: false,
        changedFileCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
    const run = async (role: "builder" | "verifier") =>
      ctx.db.insert("agentRuns", {
        workSessionId,
        taskId,
        workspaceId: await workspace(),
        workstationId,
        role,
        runtime: "fake",
        status: "completed",
        attempt: 1,
        lastActivityAt: 0,
        completedAt: 1,
        finalHeadSha: SHA,
      });
    const candidateRunId = await run("builder");
    const verifierRunId = await run("verifier");
    const verificationRunId = await ctx.db.insert("verificationRuns", {
      candidateRunId,
      verifierRunId,
      subjectSha: SHA,
      createdAt: 1,
    });
    for (const [modality, result] of evidence)
      await ctx.db.insert("evidence", {
        verificationRunId,
        verifierRunId,
        subjectSha: SHA,
        modality,
        result,
        summary: `${modality} ${result}`,
        createdAt: 1,
      });
    await ctx.db.patch("tasks", taskId, { candidateRunId, verificationRunId });
    return { workstationId, taskId, candidateRunId, verifierRunId };
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  const steps = async (runId: Id<"agentRuns"> = ids.candidateRunId) =>
    (
      await alice.user.query(api.traces.listByRun, {
        runId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page as Doc<"traceSteps">[];
  const decide = () => t.run((ctx) => decideVerification(ctx, ids.verifierRunId));
  const task = () => t.run((ctx) => ctx.db.get("tasks", ids.taskId)) as Promise<Doc<"tasks">>;
  return { t, node, user: alice.user, other: bob.user, steps, decide, task, ...ids };
}

// The Node's integration.prepare: the fresh integration worktree checked out at SHA.
async function integrate(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await f.task();
  await f.t.run((ctx) =>
    ctx.db.patch("workspaces", task.integrationWorkspaceId!, {
      status: "ready",
      baseSha: SHA,
      currentHeadSha: SHA,
      branchName: "zamolxis/integrate-c0ffee1",
    }),
  );
  const input = {
    workstationId: f.workstationId,
    taskId: f.taskId,
    workspaceId: task.integrationWorkspaceId!,
    trustDecisionId: task.trustDecisionId!,
    subjectSha: SHA,
    headSha: SHA,
    dirty: false,
    branchName: "zamolxis/integrate-c0ffee1",
  };
  await f.node.mutation(api.node.completeIntegration, input);
  await f.node.mutation(api.node.completeIntegration, input);
}

async function publishCommand(f: Awaited<ReturnType<typeof fixture>>) {
  await f.user.mutation(api.integration.publish, { taskId: f.taskId });
  const commandId = (await f.task()).publishCommandId!;
  await f.node.mutation(api.node.claim, {
    workstationId: f.workstationId,
    commandId,
    instanceId: "instance",
  });
  return commandId;
}

describe("trust and integration trace steps", () => {
  it("records trust, integration and the pull request once on the candidate's trace", async () => {
    const f = await fixture([
      ["static", "passed"],
      ["behavioral", "passed"],
    ]);
    // The Node's own steps come first; backend steps follow in arrival order.
    await f.node.mutation(api.traces.append, {
      workstationId: f.workstationId,
      runId: f.candidateRunId,
      steps: [
        {
          stepId: "runtime",
          kind: "runtime",
          label: "Codex",
          status: "passed",
          startedAt: 1,
          finishedAt: 2,
        },
      ],
    });
    await f.decide();
    await f.decide();
    let steps = await f.steps();
    expect(steps.map((step) => [step.kind, step.status])).toEqual([
      ["runtime", "passed"],
      ["trust", "passed"],
    ]);
    const trust = steps[1]!;
    expect(trust).toMatchObject({
      stepId: `backend:trust:${(await f.task()).trustDecisionId}`,
      label: "Trusted at c0ffee100000",
      references: { sha: SHA, runId: f.verifierRunId },
    });
    expect(trust.detail).toBe(
      "Independent evidence: 2 passed, 0 failed (static passed, behavioral passed).\nRequired: static, behavioral.",
    );
    expect(trust.finishedAt).toBeGreaterThanOrEqual(trust.startedAt);
    // Nothing is written on the Verifier's trace.
    expect(await f.steps(f.verifierRunId)).toEqual([]);

    await integrate(f);
    steps = await f.steps();
    expect(steps.map((step) => [step.kind, step.status])).toEqual([
      ["runtime", "passed"],
      ["trust", "passed"],
      ["integration", "passed"],
    ]);
    expect(steps[2]).toMatchObject({
      label: "Integration prepared at c0ffee100000",
      detail: `Local branch zamolxis/integrate-c0ffee1 at ${SHA}. Merging stays a human decision.`,
      references: { sha: SHA },
    });

    const commandId = await publishCommand(f);
    steps = await f.steps();
    expect(steps[3]).toMatchObject({
      stepId: `backend:publish:${commandId}`,
      kind: "integration",
      status: "started",
      label: "Publishing zamolxis/fix-the-login-form-c0ffee1",
    });
    const result = {
      workstationId: f.workstationId,
      commandId,
      taskId: f.taskId,
      subjectSha: SHA,
      remoteBranch: "zamolxis/fix-the-login-form-c0ffee1",
      base: "main",
      prUrl: "https://github.com/acme/repo/pull/7",
    };
    await f.node.mutation(api.integration.completePublish, result);
    await f.node.mutation(api.integration.completePublish, result);
    steps = await f.steps();
    expect(steps).toHaveLength(4);
    expect(steps[3]).toMatchObject({
      status: "passed",
      label: "Pull request opened",
      detail: "zamolxis/fix-the-login-form-c0ffee1 → main\nhttps://github.com/acme/repo/pull/7",
      references: { sha: SHA },
    });
    expect(steps[3]!.finishedAt).toBeGreaterThanOrEqual(steps[3]!.startedAt);
    // Owner-scoped like every trace.
    await expect(
      f.other.query(api.traces.listByRun, {
        runId: f.candidateRunId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow("FORBIDDEN");
  });

  it("records a refused candidate with its reasons and evidence counts", async () => {
    const f = await fixture([
      ["static", "passed"],
      ["behavioral", "failed"],
    ]);
    await f.decide();
    const steps = await f.steps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "trust",
      status: "failed",
      label: "Not trusted at c0ffee100000",
      references: { sha: SHA, runId: f.verifierRunId },
    });
    expect(steps[0]!.detail).toBe(
      "Independent evidence: 1 passed, 1 failed (static passed, behavioral failed).\nRequired: static, behavioral.\nReasons: Independent verification failed; Missing independent behavioral evidence",
    );
    expect((await f.task()).phase).toBe("repairing");
  });

  it("records a failed publish and a separate step for the retry", async () => {
    const f = await fixture([
      ["static", "passed"],
      ["behavioral", "passed"],
    ]);
    await f.decide();
    await integrate(f);
    const first = await publishCommand(f);
    await f.node.mutation(api.node.failCommand, {
      workstationId: f.workstationId,
      commandId: first,
      instanceId: "instance",
      code: "PUBLISH_PUSH_FAILED",
    });
    const second = await publishCommand(f);
    const steps = await f.steps();
    expect(
      steps.slice(2).map((step) => [step.stepId, step.status, step.label, step.detail]),
    ).toEqual([
      [`backend:publish:${first}`, "failed", "Publish failed", "Failure: PUBLISH_PUSH_FAILED"],
      [
        `backend:publish:${second}`,
        "started",
        "Publishing zamolxis/fix-the-login-form-c0ffee1",
        "Pushing zamolxis/fix-the-login-form-c0ffee1 and opening a pull request.",
      ],
    ]);
  });

  it("keeps backend step ids out of the Node's reach and respects the trace bound", async () => {
    const f = await fixture([
      ["static", "passed"],
      ["behavioral", "passed"],
    ]);
    await expect(
      f.node.mutation(api.traces.append, {
        workstationId: f.workstationId,
        runId: f.candidateRunId,
        steps: [
          {
            stepId: "backend:trust:x",
            kind: "trust",
            label: "Trusted",
            status: "started",
            startedAt: 1,
          },
        ],
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    // A full trace drops the backend step; the trust decision itself is unaffected.
    await f.t.run(async (ctx) => {
      const run = await ctx.db.get("agentRuns", f.candidateRunId);
      const traceId = await ctx.db.insert("traces", {
        runId: f.candidateRunId,
        workspaceId: run!.workspaceId,
        role: "builder",
        subjectSha: SHA,
        startedAt: 1,
      });
      for (let sequence = 1; sequence <= TRACE_LIMITS.stepsPerRun; sequence++)
        await ctx.db.insert("traceSteps", {
          traceId,
          sequence,
          stepId: `s${sequence}`,
          kind: "runtime",
          label: "step",
          status: "passed",
          startedAt: 1,
          finishedAt: 1,
        });
    });
    await f.decide();
    expect((await f.task()).phase).toBe("integrating");
    const count = await f.t.run(async (ctx) => (await ctx.db.query("traceSteps").collect()).length);
    expect(count).toBe(TRACE_LIMITS.stepsPerRun);
  });
});
