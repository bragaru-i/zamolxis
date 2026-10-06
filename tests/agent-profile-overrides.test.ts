import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Editing profiles and per-product overrides (#48).
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./admin.ts": () => import("../convex/admin"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./node.ts": () => import("../convex/node"),
  "./onboarding.ts": () => import("../convex/onboarding"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./workstations.ts": () => import("../convex/workstations"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  return { t, user, userId, other };
}

describe("profile overrides", () => {
  it("edits name and concurrency and removes only product overrides of the owner", async () => {
    const { t, user, userId, other } = await fixture();
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        ownerId: userId,
        name: "P",
        slug: "p",
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    const base = { role: "builder" as const, runtime: "codex", enabled: true };
    const globalId = await user.mutation(api.agentProfiles.upsert, { ...base, name: "Global" });
    const overrideId = await user.mutation(api.agentProfiles.upsert, {
      ...base,
      productId,
      name: "Override",
      maxConcurrency: 2,
    });
    await user.mutation(api.agentProfiles.upsert, {
      ...base,
      profileId: overrideId,
      productId,
      name: "Renamed",
      maxConcurrency: 3,
    });
    expect(await t.run((ctx) => ctx.db.get("agentProfiles", overrideId))).toMatchObject({
      name: "Renamed",
      maxConcurrency: 3,
      revision: 2,
    });
    await expect(
      user.mutation(api.agentProfiles.upsert, {
        ...base,
        profileId: globalId,
        name: "x".repeat(65),
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      user.mutation(api.agentProfiles.upsert, {
        ...base,
        profileId: globalId,
        name: "G",
        maxConcurrency: 33,
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      user.mutation(api.agentProfiles.removeOverride, { profileId: globalId }),
    ).rejects.toThrow("INVALID_STATE");
    await expect(
      other.mutation(api.agentProfiles.removeOverride, { profileId: overrideId }),
    ).rejects.toThrow("NOT_FOUND");
    // An unfinished run started from the override still counts against its limit.
    const runId = await t.run(async (ctx) => {
      const workstationId = await ctx.db.insert("workstations", {
        ownerId: userId,
        name: "computer",
        status: "online",
        registeredAt: 0,
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
        updatedAt: 0,
      });
      const workSessionId = await ctx.db.insert("workSessions", {
        ownerId: userId,
        productId,
        title: "S",
        goal: "G",
        status: "running",
        activeRunCount: 1,
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
        description: "D",
        kind: "implementation",
        status: "running",
        runtimePolicyMode: "auto",
        priority: 1,
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
        status: "in_use",
        baseRef: "main",
        dirty: false,
        changedFileCount: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      return ctx.db.insert("agentRuns", {
        workSessionId,
        taskId,
        workspaceId,
        workstationId,
        runtime: "codex",
        agentProfileId: overrideId,
        status: "running",
        attempt: 1,
        lastActivityAt: 0,
      });
    });
    await expect(
      user.mutation(api.agentProfiles.removeOverride, { profileId: overrideId }),
    ).rejects.toThrow("AGENT_PROFILE_IN_USE");
    await t.run((ctx) => ctx.db.patch("agentRuns", runId, { status: "completed", completedAt: 1 }));
    await user.mutation(api.agentProfiles.removeOverride, { profileId: overrideId });
    expect(await user.query(api.agentProfiles.list, { productId })).toEqual([]);
    expect(await user.query(api.agentProfiles.list, {})).toHaveLength(1);
  });
});

describe("default runtime and one agent for every role", () => {
  async function computer(
    t: Awaited<ReturnType<typeof fixture>>["t"],
    ownerId: Awaited<ReturnType<typeof fixture>>["userId"],
    runtimes: string[],
    online = true,
  ) {
    await t.run(async (ctx) => {
      const workstationId = await ctx.db.insert("workstations", {
        ownerId,
        name: "Computer",
        status: online ? "online" : "offline",
        registeredAt: 0,
        ...(online ? { lastHeartbeatAt: Date.now() } : {}),
      });
      for (const runtime of runtimes)
        await ctx.db.insert("runtimeInstallations", {
          workstationId,
          runtime,
          status: "available",
          capabilities: ["start", "stop"],
          detectedAt: 0,
        });
    });
  }

  it("defaults to Codex only where a computer offers it", async () => {
    const { t, user, userId } = await fixture();
    expect(await user.query(api.agentProfiles.defaultRuntime, {})).toBe("codex");
    await computer(t, userId, ["claude"]);
    expect(await user.query(api.agentProfiles.defaultRuntime, {})).toBe("claude");
    // A Codex computer that is offline does not decide while a Claude computer is on.
    await computer(t, userId, ["codex"], false);
    expect(await user.query(api.agentProfiles.defaultRuntime, {})).toBe("claude");
    await computer(t, userId, ["codex", "claude"]);
    expect(await user.query(api.agentProfiles.defaultRuntime, {})).toBe("codex");
  });

  it("switches every role of a scope to one agent, resetting runtime-specific models", async () => {
    const { t, user, userId, other } = await fixture();
    const productId = await t.run((ctx) =>
      ctx.db.insert("products", {
        ownerId: userId,
        name: "P",
        slug: "p",
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    const builderId = await user.mutation(api.agentProfiles.upsert, {
      role: "builder",
      runtime: "codex",
      model: "gpt-5.1-codex",
      reasoningEffort: "high",
      instructions: "Keep commits small.",
      maxConcurrency: 2,
      enabled: true,
      name: "Builders",
    });
    const offId = await user.mutation(api.agentProfiles.upsert, {
      role: "verifier",
      runtime: "claude",
      model: "claude-haiku-4-5",
      enabled: false,
      name: "Quiet verifier",
    });
    await user.mutation(api.agentProfiles.setRuntimeForAllRoles, { runtime: "claude" });
    const rows = (await user.query(api.agentProfiles.list, {})) as Array<{
      _id: string;
      role: string;
      runtime: string;
      model?: string;
      reasoningEffort?: string;
      enabled: boolean;
      name: string;
      instructions?: string;
      maxConcurrency?: number;
      revision: number;
    }>;
    expect(rows.filter((row) => row.enabled && row.runtime === "claude")).toHaveLength(6);
    expect(rows.find((row) => row._id === builderId)).toMatchObject({
      runtime: "claude",
      name: "Builders",
      instructions: "Keep commits small.",
      maxConcurrency: 2,
      revision: 2,
    });
    expect(rows.find((row) => row._id === builderId)?.model).toBeUndefined();
    expect(rows.find((row) => row._id === builderId)?.reasoningEffort).toBeUndefined();
    // The disabled Claude verifier is turned on and keeps its model.
    expect(rows.find((row) => row._id === offId)).toMatchObject({
      enabled: true,
      model: "claude-haiku-4-5",
      revision: 2,
    });
    expect(rows.find((row) => row.role === "supervisor")?.name).toBe("Supervisor · All products");
    // Saving again with the same runtime changes nothing.
    await user.mutation(api.agentProfiles.setRuntimeForAllRoles, { runtime: "claude" });
    expect(
      ((await user.query(api.agentProfiles.list, {})) as Array<{ revision: number }>).map(
        (row) => row.revision,
      ),
    ).toEqual(rows.map((row) => row.revision));
    // A product scope gets its own overrides; another account cannot reach the product.
    await user.mutation(api.agentProfiles.setRuntimeForAllRoles, { productId, runtime: "codex" });
    const overrides = (await user.query(api.agentProfiles.list, { productId })) as Array<{
      role: string;
      runtime: string;
      name: string;
    }>;
    expect(overrides).toHaveLength(6);
    expect(overrides.every((row) => row.runtime === "codex")).toBe(true);
    expect(overrides.find((row) => row.role === "builder")?.name).toBe("Builder · P");
    await expect(
      other.mutation(api.agentProfiles.setRuntimeForAllRoles, { productId, runtime: "codex" }),
    ).rejects.toThrow("PRODUCT_MISMATCH");
    await expect(
      user.mutation(api.agentProfiles.setRuntimeForAllRoles, { runtime: "  " }),
    ).rejects.toThrow("INVALID_ARGUMENT");
  });
});
