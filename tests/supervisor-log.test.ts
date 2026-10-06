import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { SUPERVISOR_LOG_LIMITS } from "../convex/lib/supervisorLog";
import { RUN_MESSAGE_LIMIT as BACKEND_RUN_MESSAGE_LIMIT } from "../convex/node";
import schema from "../convex/schema";
import { TRACE_LIMITS } from "../convex/traces";
import {
  RUN_MESSAGE_LIMIT,
  SUPERVISOR_LOG_STEP_KINDS,
  SUPERVISOR_LOG_STEPS_LIMIT,
  type SupervisorLogStepDto,
  supervisorLogStepProblem,
  TRACE_BATCH_LIMIT,
} from "../packages/contracts/src";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./node.ts": () => import("../convex/node"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const mallory = await seedHuman(t, "mallory");
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const workstation = (ownerId: Id<"users">, device: string) =>
      ctx.db.insert("workstations", {
        ownerId,
        name: "Mac",
        status: "online",
        registeredAt: now,
        nodeAuthSubject: device,
      });
    const workstationId = await workstation(alice.userId, "alice-device");
    const otherWorkstationId = await workstation(alice.userId, "alice-other-device");
    const malloryWorkstationId = await workstation(mallory.userId, "mallory-device");
    const productId = await ctx.db.insert("products", {
      ownerId: alice.userId,
      name: "P",
      slug: "p",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId: alice.userId,
      productId,
      name: "app",
      createdAt: now,
      updatedAt: now,
    });
    const workSessionId = await ctx.db.insert("workSessions", {
      ownerId: alice.userId,
      title: "S",
      goal: "g",
      status: "planning",
      activeRunCount: 0,
      completedTaskCount: 0,
      totalTaskCount: 0,
      needsInputCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const textCommandId = await ctx.db.insert("textCommands", {
      ownerId: alice.userId,
      idempotencyKey: "m1",
      text: "What does this do?",
      productId,
      repositoryId,
      workSessionId,
    });
    await ctx.db.insert("commands", {
      workstationId,
      type: "repository.plan",
      targetType: "textCommand",
      targetId: textCommandId,
      idempotencyKey: `plan:${textCommandId}`,
      status: "acknowledged",
      payload: {},
      createdAt: now,
    });
    // A message with no plan command (for example withdrawn before a Node claimed it).
    const unplannedId = await ctx.db.insert("textCommands", {
      ownerId: alice.userId,
      idempotencyKey: "m2",
      text: "Unplanned",
      productId,
      repositoryId,
      workSessionId,
    });
    return {
      workstationId,
      otherWorkstationId,
      malloryWorkstationId,
      textCommandId,
      unplannedId,
    };
  });
  const node = (device: string, owner = "alice") =>
    t.withIdentity({ subject: device, tokenIdentifier: device, ownerSubject: owner });
  return { t, alice, mallory, node: node("alice-device"), nodeAs: node, ...ids };
}

// An `undefined` field in `extra` removes the default.
function step(
  stepId: string,
  extra: { [K in keyof SupervisorLogStepDto]?: SupervisorLogStepDto[K] | undefined } = {},
): SupervisorLogStepDto {
  const result: Record<string, unknown> = {
    stepId,
    kind: "tool",
    label: "rg supervisor convex",
    status: "passed",
    startedAt: 1000,
    finishedAt: 1500,
    detail: "Read convex/supervisor.ts",
    ...extra,
  };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result as unknown as SupervisorLogStepDto;
}

describe("Supervisor log contract", () => {
  it("mirrors the trace step bounds and the backend limits", () => {
    expect(SUPERVISOR_LOG_LIMITS).toEqual({
      batch: TRACE_BATCH_LIMIT,
      stepsPerMessage: SUPERVISOR_LOG_STEPS_LIMIT,
    });
    expect(BACKEND_RUN_MESSAGE_LIMIT).toBe(RUN_MESSAGE_LIMIT);
    for (const kind of SUPERVISOR_LOG_STEP_KINDS)
      expect(supervisorLogStepProblem(step("s", { kind }))).toBeUndefined();
    expect(supervisorLogStepProblem(step("s", { kind: "runtime" as never }))).toBe("kind");
    expect(
      supervisorLogStepProblem(step("s", { detail: "x".repeat(TRACE_LIMITS.detail + 1) })),
    ).toBe("detail");
  });
});

describe("supervisor.appendLog and supervisor.log", () => {
  it("stores the planning Node's steps in order, idempotently, for the owner only", async () => {
    const f = await seed();
    const append = (steps: SupervisorLogStepDto[]) =>
      f.node.mutation(api.supervisor.appendLog, {
        workstationId: f.workstationId,
        textCommandId: f.textCommandId,
        steps,
      });
    const session = step("c:session", {
      kind: "supervisor",
      label: "Supervisor working",
      status: "started",
      finishedAt: undefined,
      detail: "Codex · model gpt",
    });
    expect(
      await append([
        step("c:discovery", { kind: "discovery", label: "Repository discovered" }),
        session,
        step("c:tool:0001"),
      ]),
    ).toEqual({ inserted: 3, settled: 0, dropped: 0 });
    // A replay is a no-op; the started session step is settled once.
    expect(await append([step("c:tool:0001", { label: "changed" })])).toEqual({
      inserted: 0,
      settled: 0,
      dropped: 0,
    });
    const finished = {
      ...session,
      label: "Supervisor finished",
      status: "passed" as const,
      startedAt: 1200,
      finishedAt: 9000,
      detail: "Codex · model gpt\n15 tokens",
    };
    expect(await append([finished, step("c:decision", { kind: "supervisor", label: "Answered" })]))
      .toEqual({ inserted: 1, settled: 1, dropped: 0 });
    expect(await append([{ ...finished, status: "failed" }])).toEqual({
      inserted: 0,
      settled: 0,
      dropped: 0,
    });
    const log = (await f.alice.user.query(api.supervisor.log, {
      textCommandId: f.textCommandId,
    })) as (SupervisorLogStepDto & { sequence: number })[];
    expect(log.map((entry) => [entry.sequence, entry.stepId, entry.label, entry.status])).toEqual([
      [1, "c:discovery", "Repository discovered", "passed"],
      [2, "c:session", "Supervisor finished", "passed"],
      [3, "c:tool:0001", "rg supervisor convex", "passed"],
      [4, "c:decision", "Answered", "passed"],
    ]);
    // The start time of the settled step is kept.
    expect(log[1]).toMatchObject({ startedAt: 1000, finishedAt: 9000 });
    expect(log[0]).not.toHaveProperty("ownerId");
    await expect(
      f.mallory.user.query(api.supervisor.log, { textCommandId: f.textCommandId }),
    ).rejects.toThrow(/FORBIDDEN/);
    // Without a user identity nothing is readable.
    await expect(
      f.node.query(api.supervisor.log, { textCommandId: f.textCommandId }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(
      await f.alice.user.query(api.supervisor.log, { textCommandId: f.unplannedId }),
    ).toEqual([]);
  });

  it("accepts steps only from the Node the plan was sent to", async () => {
    const f = await seed();
    const args = (workstationId: Id<"workstations">, textCommandId = f.textCommandId) => ({
      workstationId,
      textCommandId,
      steps: [step("c:tool:0001")],
    });
    // Another Mac of the same owner did not run this Supervisor.
    await expect(
      f
        .nodeAs("alice-other-device")
        .mutation(api.supervisor.appendLog, args(f.otherWorkstationId)),
    ).rejects.toThrow(/FORBIDDEN/);
    // A credential for one workstation cannot write as another.
    await expect(
      f.nodeAs("alice-other-device").mutation(api.supervisor.appendLog, args(f.workstationId)),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      f
        .nodeAs("mallory-device", "mallory")
        .mutation(api.supervisor.appendLog, args(f.malloryWorkstationId)),
    ).rejects.toThrow(/FORBIDDEN/);
    // A human session is not a Node.
    await expect(
      f.alice.user.mutation(api.supervisor.appendLog, args(f.workstationId)),
    ).rejects.toThrow(/FORBIDDEN/);
    // No plan command for this message.
    await expect(
      f.node.mutation(api.supervisor.appendLog, args(f.workstationId, f.unplannedId)),
    ).rejects.toThrow(/FORBIDDEN/);
    // A revoked Node is refused.
    await f.t.run((ctx) => ctx.db.patch("workstations", f.workstationId, { status: "revoked" }));
    await expect(
      f.node.mutation(api.supervisor.appendLog, args(f.workstationId)),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("enforces the trace step bounds and keeps at most 300 steps per message", async () => {
    const f = await seed();
    const append = (steps: SupervisorLogStepDto[]) =>
      f.node.mutation(api.supervisor.appendLog, {
        workstationId: f.workstationId,
        textCommandId: f.textCommandId,
        steps,
      });
    for (const bad of [
      step("x".repeat(TRACE_LIMITS.stepId + 1)),
      step("s", { label: "x".repeat(TRACE_LIMITS.label + 1) }),
      step("s", { label: "  " }),
      step("s", { detail: "x".repeat(TRACE_LIMITS.detail + 1) }),
      step("s", { startedAt: 0 }),
      step("s", { finishedAt: 10 }),
      step("s", { finishedAt: undefined }),
      step("s", { references: { sha: "not-a-sha" } }),
    ])
      await expect(append([bad])).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(append([step("s", { kind: "reasoning" as never })])).rejects.toThrow();
    await expect(append([])).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(
      append(Array.from({ length: 101 }, (_, index) => step(`s${index}`))),
    ).rejects.toThrow(/INVALID_ARGUMENT/);
    for (let batch = 0; batch < 3; batch++)
      expect(
        await append(Array.from({ length: 100 }, (_, index) => step(`s${batch}-${index}`))),
      ).toEqual({ inserted: 100, settled: 0, dropped: 0 });
    // A full log keeps its first steps instead of blocking the Node outbox.
    expect(await append([step("late")])).toEqual({ inserted: 0, settled: 0, dropped: 1 });
    const log = await f.alice.user.query(api.supervisor.log, { textCommandId: f.textCommandId });
    expect(log).toHaveLength(SUPERVISOR_LOG_STEPS_LIMIT);
  });
});

describe("run.message ingestion", () => {
  async function runSeed() {
    const f = await seed();
    const runId = await f.t.run(async (ctx) => {
      const now = Date.now();
      const text = await ctx.db.get("textCommands", f.textCommandId);
      const taskId = await ctx.db.insert("tasks", {
        workSessionId: text!.workSessionId,
        title: "Add API",
        description: "d",
        kind: "code",
        status: "running",
        runtimePolicyMode: "auto",
        priority: 1,
        createdAt: now,
        updatedAt: now,
        repairAttempts: 0,
      });
      const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
        repositoryId: text!.repositoryId,
        workstationId: f.workstationId,
        canonicalPath: "/repo",
        status: "available",
        updatedAt: now,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        workSessionId: text!.workSessionId,
        taskId,
        repositoryId: text!.repositoryId,
        repositoryLocationId,
        workstationId: f.workstationId,
        kind: "worktree",
        status: "in_use",
        baseRef: "main",
        baseSha: "a".repeat(40),
        branchName: "zam/builder",
        currentHeadSha: "a".repeat(40),
        dirty: false,
        changedFileCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return ctx.db.insert("agentRuns", {
        workSessionId: text!.workSessionId,
        taskId,
        workspaceId,
        workstationId: f.workstationId,
        role: "builder",
        runtime: "codex",
        status: "running",
        attempt: 1,
        lastActivityAt: now,
      });
    });
    return { ...f, runId };
  }
  const event = (sequence: number, text: unknown) => ({
    eventId: `e${sequence}`,
    sequence,
    type: "run.message" as const,
    occurredAt: 1000 + sequence,
    payload: { text },
  });

  it("stores a bounded progress note without changing the run state", async () => {
    const f = await runSeed();
    const ingest = (events: ReturnType<typeof event>[]) =>
      f.node.mutation(api.node.ingestBatch, {
        workstationId: f.workstationId,
        runId: f.runId,
        events,
      });
    const note = "Read the schema.\nNext: add the field.";
    expect(await ingest([event(1, note), event(2, "x".repeat(RUN_MESSAGE_LIMIT))])).toEqual([
      "e1",
      "e2",
    ]);
    // Replays are acknowledged without a second copy.
    expect(await ingest([event(1, note)])).toEqual(["e1"]);
    for (const bad of ["", "   ", "x".repeat(RUN_MESSAGE_LIMIT + 1), 42])
      await expect(ingest([event(3, bad)])).rejects.toThrow(/INVALID_ARGUMENT/);
    const stored = await f.t.run(async (ctx) => {
      const run = await ctx.db.get("agentRuns", f.runId);
      const events = await ctx.db
        .query("runEvents")
        .withIndex("by_run_sequence", (q) => q.eq("runId", f.runId))
        .collect();
      return { status: run?.status, events };
    });
    expect(stored.status).toBe("running");
    expect(stored.events.map((stored) => [stored.type, stored.payload])).toEqual([
      ["run.message", { text: note }],
      ["run.message", { text: "x".repeat(RUN_MESSAGE_LIMIT) }],
    ]);
  });
});
