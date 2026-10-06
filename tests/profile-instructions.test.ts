import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { parseExecutionCommand } from "../apps/node/src/convex-control-plane";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { OWNER_INSTRUCTIONS_HEADING } from "../convex/lib/agentProfiles";
import schema from "../convex/schema";
import {
  OWNER_INSTRUCTIONS_HEADING as NODE_HEADING,
  supervisorInstruction,
} from "../packages/node-core/src/capabilities/supervisor";
import { seedHuman } from "./fixtures/auth";

// Owner instructions on agent profiles (#48).
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./node.ts": () => import("../convex/node"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./runDetail.ts": () => import("../convex/runDetail"),
  "./runs.ts": () => import("../convex/runs"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./workstations.ts": () => import("../convex/workstations"),
};
const INSTRUCTIONS = "Always run pnpm lint before finishing; prefer small focused commits.";

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  const ids = await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      ownerId: userId,
      name: "P",
      slug: "p",
      createdAt: 0,
      updatedAt: 0,
    });
    const workstationId = await ctx.db.insert("workstations", {
      ownerId: userId,
      name: "Mac",
      status: "online",
      registeredAt: 0,
      lastHeartbeatAt: Date.now(),
    });
    await ctx.db.insert("runtimeInstallations", {
      workstationId,
      runtime: "codex",
      status: "available",
      capabilities: ["start", "stop"],
      detectedAt: 0,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId: userId,
      productId,
      name: "R",
      createdAt: 0,
      updatedAt: 0,
    });
    const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/r",
      status: "available",
      lastKnownHead: "base",
      updatedAt: 0,
    });
    return { productId, workstationId, repositoryId, repositoryLocationId };
  });
  // A ready task and an unowned ready worktree, so a Builder run can be queued.
  const readyTask = (description: string) =>
    t.run(async (ctx) => {
      const workSessionId = await ctx.db.insert("workSessions", {
        ownerId: userId,
        productId: ids.productId,
        title: "S",
        goal: "G",
        status: "running",
        activeRunCount: 0,
        completedTaskCount: 0,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      const taskId = await ctx.db.insert("tasks", {
        workSessionId,
        title: "T",
        description,
        kind: "implementation",
        status: "ready",
        runtimePolicyMode: "auto",
        priority: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        workSessionId,
        taskId,
        repositoryId: ids.repositoryId,
        repositoryLocationId: ids.repositoryLocationId,
        workstationId: ids.workstationId,
        kind: "worktree",
        status: "ready",
        baseRef: "main",
        dirty: false,
        changedFileCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      return { taskId, workspaceId };
    });
  const startCommand = (runId: Id<"agentRuns">) =>
    t.run(async (ctx) => {
      const commands = await ctx.db.query("commands").collect();
      return commands.find(
        (command) => command.type === "runtime.start" && command.targetId === runId,
      )!;
    });
  return { t, user, other, userId, ...ids, readyTask, startCommand };
}

describe("profile instructions", () => {
  it("validates, trims, redacts and keeps instructions owner-only", async () => {
    const { t, user, other } = await fixture();
    const base = { name: "Builder", role: "builder" as const, runtime: "codex", enabled: true };
    await expect(
      user.mutation(api.agentProfiles.upsert, { ...base, instructions: "x".repeat(4001) }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    const id = await user.mutation(api.agentProfiles.upsert, {
      ...base,
      instructions: `  ${INSTRUCTIONS}\nUse GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 for pushes.  `,
    });
    const stored = await t.run((ctx) => ctx.db.get("agentProfiles", id));
    expect(stored?.instructions?.startsWith(INSTRUCTIONS)).toBe(true);
    expect(stored?.instructions).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(stored?.instructions?.endsWith("for pushes.")).toBe(true);
    expect(stored?.instructionsDigest).toMatch(/^[a-f0-9]{64}$/);
    // Exactly 4000 characters after trimming is accepted.
    await user.mutation(api.agentProfiles.upsert, {
      ...base,
      profileId: id,
      instructions: ` ${"y".repeat(4000)} `,
    });
    expect((await t.run((ctx) => ctx.db.get("agentProfiles", id)))?.instructions).toHaveLength(
      4000,
    );
    // Omitted keeps the stored text; an empty string clears it.
    await user.mutation(api.agentProfiles.upsert, { ...base, profileId: id, instructions: "Hi" });
    await user.mutation(api.agentProfiles.upsert, { ...base, profileId: id, name: "Renamed" });
    expect(await t.run((ctx) => ctx.db.get("agentProfiles", id))).toMatchObject({
      name: "Renamed",
      instructions: "Hi",
      revision: 4,
    });
    await user.mutation(api.agentProfiles.upsert, { ...base, profileId: id, instructions: "  " });
    const cleared = await t.run((ctx) => ctx.db.get("agentProfiles", id));
    expect(cleared?.instructions).toBeUndefined();
    expect(cleared?.instructionsDigest).toBeUndefined();
    await expect(
      other.mutation(api.agentProfiles.upsert, { ...base, profileId: id, instructions: "Mine" }),
    ).rejects.toThrow("NOT_FOUND");
    expect(await other.query(api.agentProfiles.list, {})).toEqual([]);
  });

  it("snapshots the digest on the run and appends the labelled section only when set", async () => {
    const { t, user, productId, readyTask, startCommand } = await fixture();
    const plain = await readyTask("Add a footer");
    const plainRun = await t.mutation(internal.runs.start, plain);
    const plainCommand = await startCommand(plainRun);
    expect(plainCommand.payload.instruction).not.toContain(OWNER_INSTRUCTIONS_HEADING);
    expect((await t.run((ctx) => ctx.db.get("agentRuns", plainRun)))?.instructionsDigest).toBe(
      undefined,
    );

    const base = { role: "builder" as const, runtime: "codex", enabled: true };
    const globalId = await user.mutation(api.agentProfiles.upsert, {
      ...base,
      name: "Global",
      instructions: "Global rules.",
    });
    const overrideId = await user.mutation(api.agentProfiles.upsert, {
      ...base,
      productId,
      name: "Override",
      instructions: INSTRUCTIONS,
    });
    const work = await readyTask("Add a header");
    const runId = await t.mutation(internal.runs.start, work);
    const run = await t.run((ctx) => ctx.db.get("agentRuns", runId));
    const override = await t.run((ctx) => ctx.db.get("agentProfiles", overrideId));
    // The product override wins over the All products profile.
    expect(run).toMatchObject({
      agentProfileId: overrideId,
      agentProfileRevision: 1,
      instructionsDigest: override!.instructionsDigest,
    });
    // Run detail diagnostics expose which profile revision and instructions applied.
    expect((await user.query(api.runDetail.get, { runId })).run).toMatchObject({
      agentProfileRevision: 1,
      instructionsDigest: override?.instructionsDigest,
    });
    const command = await startCommand(runId);
    expect(command.payload.instruction).toContain(
      `\n\n${OWNER_INSTRUCTIONS_HEADING}\n${INSTRUCTIONS}`,
    );
    expect(command.payload.instruction.startsWith("Add a header")).toBe(true);
    expect(command.payload.instruction).not.toContain("Global rules.");
    // The Node accepts the payload unchanged.
    expect(parseExecutionCommand(command).payload).toMatchObject({
      instruction: command.payload.instruction,
    });
    // Later edits do not change the run's snapshot or its queued command.
    await user.mutation(api.agentProfiles.upsert, {
      ...base,
      profileId: overrideId,
      productId,
      name: "Override",
      instructions: "Changed.",
    });
    expect((await t.run((ctx) => ctx.db.get("agentRuns", runId)))?.instructionsDigest).toBe(
      override!.instructionsDigest,
    );
    expect((await startCommand(runId)).payload.instruction).toContain(INSTRUCTIONS);
    expect(globalId).toBeDefined();
  });

  it("sends the Supervisor profile instructions with the plan request", async () => {
    const { t, user, productId, repositoryId } = await fixture();
    const planPayload = async (key: string) => {
      await user.mutation(api.supervisor.submit, {
        productId,
        repositoryId,
        text: "Plan something",
        idempotencyKey: key,
      });
      const commands = await t.run((ctx) => ctx.db.query("commands").collect());
      const plan = commands.filter((command) => command.type === "repository.plan").at(-1)!;
      return { plan, payload: plan.payload };
    };
    expect((await planPayload("first")).payload.supervisor).toEqual({ runtime: "codex" });
    await user.mutation(api.agentProfiles.upsert, {
      name: "Supervisor",
      role: "supervisor",
      runtime: "codex",
      enabled: true,
      instructions: "Plan at most two tasks.",
    });
    const { plan, payload } = await planPayload("second");
    expect(payload.supervisor).toEqual({
      runtime: "codex",
      instructions: "Plan at most two tasks.",
    });
    const parsed = parseExecutionCommand(plan);
    expect(parsed.type === "repository.plan" && parsed.payload.supervisor).toEqual({
      runtime: "codex",
      instructions: "Plan at most two tasks.",
    });
  });
});

describe("Supervisor prompt", () => {
  const input = {
    text: "Add a footer",
    conversation: [],
    context: {
      gitSha: "abc",
      snapshotDigest: "d",
      discoveredSources: [],
      resolvedCapabilities: {},
    } as unknown as Parameters<typeof supervisorInstruction>[0]["context"],
    checks: { scripts: [], verificationScripts: [], requiredModalities: [] },
  };
  it("adds a labelled, redacted owner block only when instructions exist", () => {
    expect(NODE_HEADING).toBe(OWNER_INSTRUCTIONS_HEADING);
    expect(supervisorInstruction(input)).not.toContain(NODE_HEADING);
    expect(supervisorInstruction({ ...input, instructions: "   " })).not.toContain(NODE_HEADING);
    const prompt = supervisorInstruction({
      ...input,
      instructions: "Prefer small tasks. password=hunter22",
    });
    expect(prompt).toContain(`${NODE_HEADING}\nPrefer small tasks.`);
    expect(prompt).not.toContain("hunter22");
    // The owner block never replaces the read-only rules or the output contract.
    expect(prompt.indexOf(NODE_HEADING)).toBeGreaterThan(prompt.indexOf("You work read-only"));
    expect(prompt.indexOf("Output contract")).toBeGreaterThan(prompt.indexOf(NODE_HEADING));
  });
});
