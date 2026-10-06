import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Computer management (#45): rename, pairing again, exact heartbeat, repository removal.
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
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  const nodeFor = (subject: string, owner = "alice") =>
    t.withIdentity({
      subject,
      issuer: "https://identity.example",
      tokenIdentifier: subject,
      ownerSubject: owner,
    });
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Old computer",
    nodeAuthSubject: "device",
  });
  const node = nodeFor("device");
  await node.mutation(api.node.heartbeat, {
    workstationId,
    instanceId: "instance-1",
    runtimeCapabilities: [{ runtime: "codex", capabilities: ["start"] }],
  });
  return { t, user, other, node, nodeFor, workstationId };
}

describe("workstation rename", () => {
  it("lets the owner and the computer itself rename it within bounds", async () => {
    const { t, user, other, node, nodeFor, workstationId } = await fixture();
    await user.mutation(api.workstations.rename, { workstationId, name: "  Studio  " });
    expect((await t.run((ctx) => ctx.db.get("workstations", workstationId)))?.name).toBe("Studio");
    await node.mutation(api.workstations.renameSelf, { workstationId, name: "Laptop" });
    expect((await t.run((ctx) => ctx.db.get("workstations", workstationId)))?.name).toBe("Laptop");
    for (const name of ["", "   ", "x".repeat(65), "bad\u0007name"])
      await expect(user.mutation(api.workstations.rename, { workstationId, name })).rejects.toThrow(
        "INVALID_ARGUMENT",
      );
    await user.mutation(api.workstations.rename, { workstationId, name: "x".repeat(64) });
    await expect(
      other.mutation(api.workstations.rename, { workstationId, name: "Mine" }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      nodeFor("intruder").mutation(api.workstations.renameSelf, { workstationId, name: "Mine" }),
    ).rejects.toThrow("FORBIDDEN");
    await user.mutation(api.workstations.revoke, { workstationId });
    await expect(
      user.mutation(api.workstations.rename, { workstationId, name: "Again" }),
    ).rejects.toThrow("INVALID_STATE");
    await expect(
      node.mutation(api.workstations.renameSelf, { workstationId, name: "Again" }),
    ).rejects.toThrow("FORBIDDEN");
  });
});

describe("pairing again", () => {
  it("retires the previous entry only with its own credential and for the same owner", async () => {
    const { t, user, other, node, nodeFor, workstationId } = await fixture();
    const replacementId = await user.mutation(api.workstations.register, {
      name: "Old computer",
      nodeAuthSubject: "device-2",
    });
    const foreignId = await other.mutation(api.workstations.register, {
      name: "Bob's computer",
      nodeAuthSubject: "bob-device",
    });
    // The new entry cannot retire the old one: only the old credential proves it.
    await expect(
      nodeFor("device-2").mutation(api.workstations.retireReplaced, {
        workstationId,
        replacementId,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      node.mutation(api.workstations.retireReplaced, { workstationId, replacementId: foreignId }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      node.mutation(api.workstations.retireReplaced, {
        workstationId,
        replacementId: workstationId,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await node.mutation(api.workstations.retireReplaced, { workstationId, replacementId });
    const old = await t.run((ctx) => ctx.db.get("workstations", workstationId));
    expect(old).toMatchObject({ status: "revoked", replacedBy: replacementId });
    expect(old?.revokedAt).toBeTypeOf("number");
    // Once revoked, the old credential proves nothing anymore.
    await expect(
      node.mutation(api.workstations.retireReplaced, { workstationId, replacementId }),
    ).rejects.toThrow("FORBIDDEN");
    expect((await t.run((ctx) => ctx.db.get("workstations", replacementId)))?.status).toBe(
      "offline",
    );
  });
});

describe("node health", () => {
  it("reports the exact heartbeat, process instance and platform", async () => {
    const { t, node, workstationId } = await fixture();
    const health = await node.query(api.node.health, { workstationId });
    expect(health).toMatchObject({
      online: true,
      runtimeAvailable: true,
      instanceId: "instance-1",
    });
    expect(health.lastHeartbeatAt).toBeTypeOf("number");
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-2",
      platform: "linux",
      architecture: "x64",
      runtimeCapabilities: [{ runtime: "claude", capabilities: ["start"] }],
    });
    expect(await node.query(api.node.health, { workstationId })).toMatchObject({
      instanceId: "instance-2",
      runtimeAvailable: true,
    });
    expect(await t.run((ctx) => ctx.db.get("workstations", workstationId))).toMatchObject({
      platform: "linux",
      architecture: "x64",
    });
    await expect(
      node.mutation(api.node.heartbeat, {
        workstationId,
        instanceId: "instance-2",
        platform: "x".repeat(33),
        runtimeCapabilities: [],
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-2",
      runtimeCapabilities: [],
    });
    expect((await node.query(api.node.health, { workstationId })).runtimeAvailable).toBe(false);
  });
});

describe("repository removal", () => {
  async function located() {
    const f = await fixture();
    const [registered] = await f.node.mutation(api.onboarding.registerRepositories, {
      workstationId: f.workstationId,
      repositories: [{ name: "repo", remoteUrl: "https://example.invalid/repo.git" }],
    });
    if (!registered) throw new Error("not registered");
    const register = () =>
      f.node.mutation(api.node.registerLocation, {
        workstationId: f.workstationId,
        repositoryId: registered.repositoryId,
        canonicalPath: "/repo",
        gitCommonDir: "/repo/.git",
        headSha: "base",
      });
    const repositoryLocationId = await register();
    const status = async () =>
      (await f.t.run((ctx) => ctx.db.get("repositoryLocations", repositoryLocationId)))?.status;
    return { ...f, repositoryId: registered.repositoryId, repositoryLocationId, register, status };
  }

  it("removes this computer's location for the Node, sticks across restarts and comes back on re-grant", async () => {
    const f = await located();
    await expect(
      f.nodeFor("intruder").mutation(api.repositories.removeOwnLocation, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      await f.node.mutation(api.repositories.removeOwnLocation, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
      }),
    ).toBe("removed");
    expect(await f.status()).toBe("removed");
    expect(
      await f.node.mutation(api.repositories.removeOwnLocation, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
      }),
    ).toBe("absent");
    // A daemon restart or a verification does not bring it back.
    await f.register();
    await f.node.mutation(api.node.verifyLocation, {
      workstationId: f.workstationId,
      repositoryLocationId: f.repositoryLocationId,
      status: "available",
    });
    expect(await f.status()).toBe("removed");
    expect(
      await f.user.query(api.repositories.listLocations, { workstationId: f.workstationId }),
    ).toEqual([]);
    // Plain repair keeps it removed; re-granting it in setup makes it eligible again.
    const grant = [{ name: "repo", remoteUrl: "https://example.invalid/repo.git" }];
    await f.node.mutation(api.onboarding.registerRepositories, {
      workstationId: f.workstationId,
      repositories: grant,
    });
    expect(await f.status()).toBe("removed");
    await f.node.mutation(api.onboarding.registerRepositories, {
      workstationId: f.workstationId,
      repositories: grant,
      reactivate: true,
    });
    expect(await f.status()).toBe("missing");
    await f.register();
    expect(await f.status()).toBe("available");
  });

  it("lets only the owner remove a location from Settings and refuses while work is active", async () => {
    const f = await located();
    expect(
      await f.user.query(api.repositories.listLocations, { workstationId: f.workstationId }),
    ).toEqual([
      {
        repositoryLocationId: f.repositoryLocationId,
        repositoryName: "repo",
        canonicalPath: "/repo",
        status: "available",
      },
    ]);
    await expect(
      f.other.query(api.repositories.listLocations, { workstationId: f.workstationId }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.other.mutation(api.repositories.removeLocationForOwner, {
        repositoryLocationId: f.repositoryLocationId,
      }),
    ).rejects.toThrow("FORBIDDEN");
    // A requested workspace means work is about to run there.
    const workSessionId = await f.user.mutation(api.sessions.create, {
      title: "S",
      goal: "G",
      repositoryIds: [f.repositoryId],
    });
    const taskId = await f.user.mutation(api.tasks.create, {
      workSessionId,
      title: "T",
      description: "D",
      kind: "implementation",
      priority: 1,
      runtimePolicy: { mode: "auto" },
    });
    const workspaceId = await f.user.mutation(api.workspaces.request, {
      taskId,
      repositoryLocationId: f.repositoryLocationId,
      baseRef: "main",
    });
    await expect(
      f.user.mutation(api.repositories.removeLocationForOwner, {
        repositoryLocationId: f.repositoryLocationId,
      }),
    ).rejects.toThrow("LOCATION_BUSY");
    await expect(
      f.node.mutation(api.repositories.removeOwnLocation, {
        workstationId: f.workstationId,
        repositoryId: f.repositoryId,
      }),
    ).rejects.toThrow("LOCATION_BUSY");
    await f.t.run((ctx) => ctx.db.patch("workspaces", workspaceId, { status: "removed" }));
    await f.user.mutation(api.repositories.removeLocationForOwner, {
      repositoryLocationId: f.repositoryLocationId,
    });
    expect(await f.status()).toBe("removed");
    // No new work is dispatched to a removed location.
    await expect(
      f.user.mutation(api.workspaces.request, {
        taskId,
        repositoryLocationId: f.repositoryLocationId,
        baseRef: "main",
      }),
    ).rejects.toThrow("WORKSTATION_OFFLINE");
  });
});
