import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./usage.ts": () => import("../convex/usage"),
};

const NOW = Date.UTC(2026, 9, 6, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => {
  vi.useRealTimers();
});

type Run = Partial<Doc<"agentRuns">>;
type Command = Partial<Doc<"textCommands">>;

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  // convex-test creation times only move forward: create fixtures in the past.
  vi.setSystemTime(NOW - 60 * DAY);
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const bob = await seedHuman(t, "bob");
  await t.run(async (ctx) => {
    for (const { sessionId } of [alice, bob])
      await ctx.db.patch("authSessions", sessionId, { expirationTime: NOW + DAY });
  });
  vi.setSystemTime(NOW);
  // Seeds a Session with runs and Supervisor turns. Commands are created at `at`.
  const seed = async (
    ownerId: Id<"users">,
    lastActivityAt: number,
    runs: Run[],
    commands: Command[] = [],
    at = lastActivityAt,
  ) => {
    vi.setSystemTime(at);
    const id = await t.run(async (ctx) => {
      const workSessionId = await ctx.db.insert("workSessions", {
        ownerId,
        title: `Session ${lastActivityAt}`,
        goal: "goal",
        status: "completed",
        activeRunCount: 0,
        completedTaskCount: 0,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt,
        createdAt: lastActivityAt,
        updatedAt: lastActivityAt,
      });
      const productId = await ctx.db.insert("products", {
        ownerId,
        name: "P",
        slug: "p",
        createdAt: 0,
        updatedAt: 0,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        ownerId,
        productId,
        name: "R",
        createdAt: 0,
        updatedAt: 0,
      });
      const workstationId = await ctx.db.insert("workstations", {
        ownerId,
        name: "computer",
        status: "online",
        registeredAt: 0,
      });
      const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
        repositoryId,
        workstationId,
        canonicalPath: "/repo",
        status: "available",
        updatedAt: 0,
      });
      const taskId = await ctx.db.insert("tasks", {
        workSessionId,
        title: "T",
        description: "d",
        kind: "code",
        status: "completed",
        runtimePolicyMode: "auto",
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        workSessionId,
        taskId,
        repositoryId,
        repositoryLocationId,
        workstationId,
        kind: "worktree",
        status: "completed",
        baseRef: "main",
        dirty: false,
        changedFileCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      for (const run of runs) {
        await ctx.db.insert("agentRuns", {
          workSessionId,
          taskId,
          workspaceId,
          workstationId,
          runtime: "codex",
          status: "completed",
          attempt: 1,
          lastActivityAt,
          ...run,
        });
      }
      for (const [index, command] of commands.entries()) {
        await ctx.db.insert("textCommands", {
          ownerId,
          idempotencyKey: `k${lastActivityAt}-${index}`,
          text: "hello",
          productId,
          repositoryId,
          workSessionId,
          ...command,
        });
      }
      return workSessionId;
    });
    vi.setSystemTime(NOW);
    return id;
  };
  return { t, alice, bob, seed };
}

it("sums a session by role and model with only reported values", async () => {
  const { alice, bob, seed } = await fixture();
  const sessionId = await seed(
    alice.userId,
    NOW - HOUR,
    [
      {
        role: "builder",
        modelActual: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        totalTokens: 120,
      },
      { role: "builder", modelActual: "gpt-5", totalTokens: 80 },
      { role: "verifier", totalTokens: 50 },
      // No telemetry: counted as an item, contributes no tokens.
      { role: "repair" },
    ],
    [
      { decision: "plan", modelActual: "gpt-5-mini", totalTokens: 30, inputTokens: 25 },
      // Legacy message without a Supervisor turn is ignored.
      {},
    ],
  );
  const usage = await alice.user.query(api.usage.session, { workSessionId: sessionId });
  expect(usage.total).toEqual({
    inputTokens: 125,
    cachedInputTokens: 40,
    outputTokens: 20,
    totalTokens: 280,
    items: 5,
    reported: 4,
  });
  expect(usage.total.costUsd).toBeUndefined();
  expect(usage.byRole.map((row: { role: string; totalTokens: number }) => row.role)).toEqual([
    "supervisor",
    "builder",
    "verifier",
    "repair",
  ]);
  expect(usage.byRole[1]).toMatchObject({ role: "builder", totalTokens: 200, items: 2 });
  expect(usage.byRole[3]).toMatchObject({ role: "repair", totalTokens: 0, reported: 0 });
  expect(usage.byModel).toEqual([
    expect.objectContaining({ model: "gpt-5", totalTokens: 200 }),
    expect.objectContaining({ totalTokens: 50, items: 2 }),
    expect.objectContaining({ model: "gpt-5-mini", totalTokens: 30 }),
  ]);
  expect(usage.byModel[1]?.model).toBeUndefined();
  expect(usage.truncated).toBe(false);
  await expect(bob.user.query(api.usage.session, { workSessionId: sessionId })).rejects.toThrow(
    /FORBIDDEN/,
  );
});

it("returns cost only when a provider reported it", async () => {
  const { alice, seed } = await fixture();
  const sessionId = await seed(alice.userId, NOW - HOUR, [
    { role: "builder", totalTokens: 10, estimatedCostUsd: 0.25 },
    { role: "builder", totalTokens: 10 },
  ]);
  const usage = await alice.user.query(api.usage.session, { workSessionId: sessionId });
  expect(usage.total.costUsd).toBe(0.25);
  expect(usage.byRole[0]?.costUsd).toBe(0.25);
});

it("totals the owner's usage for a period, isolated per owner", async () => {
  const { alice, bob, seed } = await fixture();
  const recent = await seed(
    alice.userId,
    NOW - 2 * HOUR,
    [{ role: "builder", totalTokens: 500 }],
    [{ decision: "answer", totalTokens: 40 }],
  );
  const week = await seed(alice.userId, NOW - 3 * DAY, [{ role: "verifier", totalTokens: 70 }]);
  await seed(alice.userId, NOW - 40 * DAY, [{ role: "builder", totalTokens: 9000 }]);
  await seed(bob.userId, NOW - HOUR, [{ role: "builder", totalTokens: 123456 }]);

  const day = await alice.user.query(api.usage.summary, { period: "24h" });
  expect(day.since).toBe(NOW - DAY);
  expect(day.total.totalTokens).toBe(540);
  expect(day.sessionCount).toBe(1);
  expect(day.topSessions.map((row: { _id: string }) => row._id)).toEqual([recent]);

  const seven = await alice.user.query(api.usage.summary, { period: "7d" });
  expect(seven.total.totalTokens).toBe(610);
  expect(seven.topSessions.map((row: { _id: string }) => row._id)).toEqual([recent, week]);
  expect(seven.byRole.map((row: { role: string }) => row.role)).toEqual([
    "supervisor",
    "builder",
    "verifier",
  ]);

  const month = await alice.user.query(api.usage.summary, { period: "30d" });
  expect(month.total.totalTokens).toBe(610);
  expect(month.truncated).toBe(false);

  const bobDay = await bob.user.query(api.usage.summary, { period: "24h" });
  expect(bobDay.total.totalTokens).toBe(123456);
  expect(bobDay.topSessions).toHaveLength(1);
});

it("excludes runs and Supervisor turns older than the period inside an active session", async () => {
  const { alice, seed } = await fixture();
  // Session active now, but its earlier run and message happened 3 days ago.
  const sessionId = await seed(
    alice.userId,
    NOW - HOUR,
    [
      { role: "builder", totalTokens: 100 },
      { role: "builder", totalTokens: 1000, lastActivityAt: NOW - 3 * DAY },
    ],
    [{ decision: "plan", totalTokens: 7 }],
    NOW - 3 * DAY,
  );
  const day = await alice.user.query(api.usage.summary, { period: "24h" });
  expect(day.total.totalTokens).toBe(100);
  const seven = await alice.user.query(api.usage.summary, { period: "7d" });
  expect(seven.total.totalTokens).toBe(1107);
  // The session view always shows the full session.
  const all = await alice.user.query(api.usage.session, { workSessionId: sessionId });
  expect(all.total.totalTokens).toBe(1107);
});

it("requires an allowed, signed-in owner", async () => {
  const { t } = await fixture();
  const pending = await seedHuman(t, "carol", "pending");
  await expect(pending.user.query(api.usage.summary, { period: "7d" })).rejects.toThrow(
    /ACCESS_DENIED/,
  );
  await expect(t.query(api.usage.summary, { period: "7d" })).rejects.toThrow(/FORBIDDEN/);
});
