import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { TRACE_LIMITS } from "../convex/traces";
import {
  TRACE_BATCH_LIMIT,
  TRACE_DETAIL_LIMIT,
  TRACE_LABEL_LIMIT,
  TRACE_RUN_ID_LIMIT,
  TRACE_SCRIPT_LIMIT,
  TRACE_STEP_ID_LIMIT,
  TRACE_STEPS_PER_RUN_LIMIT,
  type TraceStepDto,
} from "../packages/contracts/src";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./traces.ts": () => import("../convex/traces"),
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
        name: "computer",
        status: "online",
        registeredAt: now,
        nodeAuthSubject: device,
      });
    const workstationId = await workstation(alice.userId, "alice-device");
    const otherWorkstationId = await workstation(alice.userId, "alice-other-device");
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
      activeRunCount: 1,
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
      repairAttempts: 0,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      workSessionId,
      taskId,
      repositoryId,
      repositoryLocationId,
      workstationId,
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
    const runId = await ctx.db.insert("agentRuns", {
      workSessionId,
      taskId,
      workspaceId,
      workstationId,
      role: "verifier",
      runtime: "codex",
      status: "running",
      attempt: 1,
      lastActivityAt: now,
      initialHeadSha: "a".repeat(40),
    });
    return { workstationId, otherWorkstationId, runId };
  });
  const node = (device: string, owner = "alice") =>
    t.withIdentity({ subject: device, tokenIdentifier: device, ownerSubject: owner });
  return { t, alice, mallory, node: node("alice-device"), nodeAs: node, ...ids };
}

// An `undefined` field in `extra` removes the default.
function step(
  stepId: string,
  extra: { [K in keyof TraceStepDto]?: TraceStepDto[K] | undefined } = {},
): TraceStepDto {
  const result: Record<string, unknown> = {
    stepId,
    kind: "verification-check",
    label: "pnpm run test",
    status: "passed",
    startedAt: 1000,
    finishedAt: 2000,
    detail: "ok",
    references: { script: "test", exitCode: 0, sha: "a".repeat(40) },
    ...extra,
  };
  // Convex arguments must not carry explicit undefined fields.
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result as unknown as TraceStepDto;
}
const page = { numItems: 100, cursor: null };

describe("traces.append", () => {
  it("stores ordered steps for the Node's own run and reads them back for the owner only", async () => {
    const f = await seed();
    const append = (steps: TraceStepDto[]) =>
      f.node.mutation(api.traces.append, { workstationId: f.workstationId, runId: f.runId, steps });
    const first = await append([
      step("c:runtime", {
        kind: "runtime",
        label: "Runtime codex running",
        status: "started",
        finishedAt: undefined,
        detail: undefined,
        references: { runId: "r" },
      }),
      step("c:check:000"),
    ]);
    expect(first).toMatchObject({ inserted: 2, settled: 0, dropped: 0 });
    // Replays are no-ops; a started step settles once and keeps its start time.
    const second = await append([
      step("c:check:000", { status: "failed", detail: "changed" }),
      step("c:runtime", {
        kind: "runtime",
        label: "Runtime codex completed",
        startedAt: 5000,
        finishedAt: 9000,
        detail: undefined,
        references: undefined,
      }),
      step("c:check:001", {
        label: "pnpm run lint",
        references: { script: "lint", exitCode: 1 },
        status: "failed",
      }),
    ]);
    expect(second).toMatchObject({ inserted: 1, settled: 1, dropped: 0 });
    await append([
      step("c:runtime", { kind: "runtime", label: "again", status: "failed", detail: undefined }),
    ]);

    const result = await f.alice.user.query(api.traces.listByRun, {
      runId: f.runId,
      paginationOpts: page,
    });
    expect(
      result.page.map((s: Record<string, unknown>) => [s.stepId, s.sequence, s.status, s.label]),
    ).toEqual([
      ["c:runtime", 1, "passed", "Runtime codex completed"],
      ["c:check:000", 2, "passed", "pnpm run test"],
      ["c:check:001", 3, "failed", "pnpm run lint"],
    ]);
    expect(result.page[0]).toMatchObject({ startedAt: 1000, finishedAt: 9000 });
    expect(result.page[1]?.detail).toBe("ok");
    const trace = await f.t.run((ctx) =>
      ctx.db
        .query("traces")
        .withIndex("by_run", (q) => q.eq("runId", f.runId))
        .unique(),
    );
    expect(trace).toMatchObject({ role: "verifier", subjectSha: "a".repeat(40), finishedAt: 9000 });

    await expect(
      f.mallory.user.query(api.traces.listByRun, { runId: f.runId, paginationOpts: page }),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      f.alice.user.query(api.traces.listByRun, {
        runId: f.runId,
        paginationOpts: { numItems: 101, cursor: null },
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);
    // Paginated oldest first.
    const firstPage = await f.alice.user.query(api.traces.listByRun, {
      runId: f.runId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(firstPage.page.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2]);
    const next = await f.alice.user.query(api.traces.listByRun, {
      runId: f.runId,
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    });
    expect(next.page.map((s: { sequence: number }) => s.sequence)).toEqual([3]);
  });

  it("returns an empty page before the Node recorded anything", async () => {
    const f = await seed();
    expect(
      await f.alice.user.query(api.traces.listByRun, { runId: f.runId, paginationOpts: page }),
    ).toEqual({ page: [], isDone: true, continueCursor: "" });
  });

  it("accepts steps only from the Node of the run's workstation", async () => {
    const f = await seed();
    const args = { workstationId: f.workstationId, runId: f.runId, steps: [step("s")] };
    // A human session is not a Node.
    await expect(f.alice.user.mutation(api.traces.append, args)).rejects.toThrow(/FORBIDDEN/);
    // Another device of the same owner, naming the run's workstation.
    await expect(f.nodeAs("alice-other-device").mutation(api.traces.append, args)).rejects.toThrow(
      /FORBIDDEN/,
    );
    // Another device, naming its own workstation: the run is not on it.
    await expect(
      f.nodeAs("alice-other-device").mutation(api.traces.append, {
        ...args,
        workstationId: f.otherWorkstationId,
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    // The right device with another owner's token.
    await expect(
      f.nodeAs("alice-device", "mallory").mutation(api.traces.append, args),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(await f.t.run((ctx) => ctx.db.query("traceSteps").collect())).toEqual([]);
  });

  it("rejects batches outside the TraceStep bounds", async () => {
    const f = await seed();
    const append = (steps: TraceStepDto[]) =>
      f.node.mutation(api.traces.append, { workstationId: f.workstationId, runId: f.runId, steps });
    for (const steps of [
      [],
      Array.from({ length: TRACE_BATCH_LIMIT + 1 }, (_, index) => step(`s${index}`)),
      [step("x".repeat(TRACE_STEP_ID_LIMIT + 1))],
      [step("")],
      [step("s", { label: "" })],
      [step("s", { label: "l".repeat(TRACE_LABEL_LIMIT + 1) })],
      [step("s", { detail: "d".repeat(TRACE_DETAIL_LIMIT + 1) })],
      [step("s", { finishedAt: 999 })],
      [step("s", { finishedAt: undefined })],
      [step("s", { startedAt: 0 })],
      [step("s", { references: { sha: "not-a-sha" } })],
      [step("s", { references: { script: "rm -rf /" } })],
      [step("s", { references: { exitCode: 1.5 } })],
      [step("s", { references: { runId: "r".repeat(TRACE_RUN_ID_LIMIT + 1) } })],
    ])
      await expect(append(steps)).rejects.toThrow(/INVALID_ARGUMENT/);
    await expect(
      append([{ ...step("s"), kind: "thinking" } as unknown as TraceStepDto]),
    ).rejects.toThrow();
    expect(await f.t.run((ctx) => ctx.db.query("traceSteps").collect())).toEqual([]);
  });

  it("keeps the first steps of a full trace without blocking the Node outbox", async () => {
    const f = await seed();
    for (let offset = 0; offset < TRACE_STEPS_PER_RUN_LIMIT; offset += TRACE_BATCH_LIMIT)
      await f.node.mutation(api.traces.append, {
        workstationId: f.workstationId,
        runId: f.runId,
        steps: Array.from({ length: TRACE_BATCH_LIMIT }, (_, index) => step(`s${offset + index}`)),
      });
    const overflow = await f.node.mutation(api.traces.append, {
      workstationId: f.workstationId,
      runId: f.runId,
      steps: [step("one-more")],
    });
    expect(overflow).toMatchObject({ inserted: 0, dropped: 1 });
    expect(await f.t.run((ctx) => ctx.db.query("traceSteps").collect())).toHaveLength(
      TRACE_STEPS_PER_RUN_LIMIT,
    );
  });

  it("mirrors the contract bounds", () => {
    expect(TRACE_LIMITS).toEqual({
      stepId: TRACE_STEP_ID_LIMIT,
      label: TRACE_LABEL_LIMIT,
      detail: TRACE_DETAIL_LIMIT,
      script: TRACE_SCRIPT_LIMIT,
      runId: TRACE_RUN_ID_LIMIT,
      batch: TRACE_BATCH_LIMIT,
      stepsPerRun: TRACE_STEPS_PER_RUN_LIMIT,
    });
  });
});
