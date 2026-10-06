import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./proof.ts": () => import("../convex/proof"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./workstations.ts": () => import("../convex/workstations"),
  "./repositories.ts": () => import("../convex/repositories"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  await user.mutation(api.profiles.ensure, {});
  await other.mutation(api.profiles.ensure, {});
  const register = (who: typeof user, name: string, subject: string) =>
    who.mutation(api.workstations.register, { name, nodeAuthSubject: subject });
  const workstationId = await register(user, "Node", "device");
  const otherWorkstation = await register(other, "Other", "other-device");
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  const otherNode = t.withIdentity({
    subject: "other-device",
    tokenIdentifier: "other-device",
    ownerSubject: "bob",
  });
  const repositoryId = await user.mutation(api.repositories.create, { name: "Repo" });
  const ids = await t.run(async (ctx) => {
    const device = await ctx.db.get(workstationId);
    if (!device) throw new Error("Missing device");
    const ownerId = device.ownerId;
    const workSessionId = await ctx.db.insert("workSessions", {
      ownerId,
      title: "Logo",
      goal: "Logo",
      status: "running",
      activeRunCount: 1,
      completedTaskCount: 0,
      totalTaskCount: 1,
      needsInputCount: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const taskId = await ctx.db.insert("tasks", {
      workSessionId,
      title: "Logo",
      description: "Logo",
      kind: "code",
      status: "running",
      runtimePolicyMode: "auto",
      priority: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const locationId = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/repo",
      status: "available",
      updatedAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      workSessionId,
      taskId,
      repositoryId,
      repositoryLocationId: locationId,
      workstationId,
      kind: "worktree",
      status: "in_use",
      baseRef: "HEAD",
      dirty: false,
      changedFileCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert("agentRuns", {
      workSessionId,
      taskId,
      workspaceId,
      workstationId,
      role: "builder",
      runtime: "codex",
      status: "running",
      attempt: 1,
      lastActivityAt: 1,
    } as never);
    return { workSessionId, runId };
  });
  const store = (bytes: string, type: string) =>
    t.run((ctx) => ctx.storage.store(new Blob([bytes], { type }))) as Promise<Id<"_storage">>;
  return { t, user, other, node, otherNode, workstationId, otherWorkstation, store, ...ids };
}

it("records a Node's proof image once and shows it only to the Session owner", async () => {
  const f = await fixture();
  const args = { workstationId: f.workstationId, runId: f.runId };
  expect(typeof (await f.node.mutation(api.proof.uploadUrl, args))).toBe("string");
  const storageId = await f.store("png-bytes", "image/png");
  const record = {
    ...args,
    storageId,
    name: "preview.png",
    source: "proof" as const,
    contentType: "image/png",
  };
  expect(await f.node.mutation(api.proof.record, record)).toBe("recorded");
  // A retried delivery of the same file, or a second upload of the same bytes, adds nothing.
  expect(await f.node.mutation(api.proof.record, record)).toBe("duplicate");
  const again = await f.store("png-bytes", "image/png");
  expect(await f.node.mutation(api.proof.record, { ...record, storageId: again })).toBe(
    "duplicate",
  );
  expect(await f.t.run((ctx) => ctx.storage.getUrl(again))).toBeNull();

  const images = await f.user.query(api.proof.listForSession, { workSessionId: f.workSessionId });
  expect(images).toEqual([
    expect.objectContaining({ runId: f.runId, name: "preview.png", source: "proof" }),
  ]);
  expect(images[0]?.url).toEqual(expect.any(String));
  await expect(
    f.other.query(api.proof.listForSession, { workSessionId: f.workSessionId }),
  ).rejects.toThrow("FORBIDDEN");
});

it("refuses another owner's Node and files outside the limits", async () => {
  const f = await fixture();
  await expect(
    f.otherNode.mutation(api.proof.uploadUrl, {
      workstationId: f.otherWorkstation,
      runId: f.runId,
    }),
  ).rejects.toThrow("FORBIDDEN");
  const args = { workstationId: f.workstationId, runId: f.runId };
  // Only images; a rejected upload is deleted, not kept.
  const reject = async (bytes: string, contentType: string, name: string) => {
    const storageId = await f.store(bytes, contentType);
    expect(
      await f.node.mutation(api.proof.record, {
        ...args,
        storageId,
        name,
        source: "proof",
        contentType,
      }),
    ).toBe("rejected");
    expect(await f.t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  };
  await reject("<script>alert(1)</script>", "text/html", "x.png");
  await reject("x".repeat(5 * 1024 * 1024 + 1), "image/png", "big.png");
  for (let index = 0; index < 8; index++) {
    const storageId = await f.store(`image-${index}`, "image/webp");
    await f.node.mutation(api.proof.record, {
      ...args,
      storageId,
      name: `shot-${index}.webp`,
      source: "changed",
      contentType: "image/webp",
    });
  }
  await expect(f.node.mutation(api.proof.uploadUrl, args)).rejects.toThrow("LIMIT_EXCEEDED");
});
