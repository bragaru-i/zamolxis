import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// One repository is one Product however its remote is written on each computer (#45).
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./admin.ts": () => import("../convex/admin"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./node.ts": () => import("../convex/node"),
  "./onboarding.ts": () => import("../convex/onboarding"),
  "./products.ts": () => import("../convex/products"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./workstations.ts": () => import("../convex/workstations"),
};
const HTTPS = "https://github.com/bragaru-i/zamolxis.git";
const SSH = "git@github.com:Bragaru-I/Zamolxis";

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const nodeFor = (subject: string) =>
    t.withIdentity({
      subject,
      issuer: "https://identity.example",
      tokenIdentifier: subject,
      ownerSubject: "alice",
    });
  const macId = await user.mutation(api.workstations.register, {
    name: "Studio",
    nodeAuthSubject: "mac",
  });
  const linuxId = await user.mutation(api.workstations.register, {
    name: "ubuntu",
    nodeAuthSubject: "linux",
  });
  const mac = nodeFor("mac");
  const linux = nodeFor("linux");
  const locate = (
    node: typeof mac,
    workstationId: Id<"workstations">,
    repositoryId: Id<"repositories">,
    path: string,
  ) =>
    node.mutation(api.node.registerLocation, {
      workstationId,
      repositoryId,
      canonicalPath: path,
      gitCommonDir: `${path}/.git`,
      headSha: "base",
    });
  return { t, user, userId, mac, linux, macId, linuxId, locate };
}

describe("repository identity across computers", () => {
  it("registers the same remote written differently as one repository and one Product", async () => {
    const f = await fixture();
    const [first] = await f.mac.mutation(api.onboarding.registerRepositories, {
      workstationId: f.macId,
      repositories: [{ name: "zamolxis", remoteUrl: HTTPS }],
    });
    const [second] = await f.linux.mutation(api.onboarding.registerRepositories, {
      workstationId: f.linuxId,
      repositories: [{ name: "zamolxis", remoteUrl: SSH }],
    });
    expect(second).toMatchObject({
      repositoryId: first?.repositoryId,
      productId: first?.productId,
      remoteUrl: SSH,
    });
    expect(await f.user.query(api.supervisor.products, {})).toHaveLength(1);
    // A different repository on the same host stays separate.
    const [other] = await f.linux.mutation(api.onboarding.registerRepositories, {
      workstationId: f.linuxId,
      repositories: [{ name: "docs", remoteUrl: "git@github.com:bragaru-i/zamolxis-docs.git" }],
    });
    expect(other?.productId).not.toBe(first?.productId);
    expect(await f.user.query(api.supervisor.products, {})).toHaveLength(2);
  });

  it("merges entries registered before remotes were compared by identity", async () => {
    const f = await fixture();
    // Two entries as the old rule left them: one per computer, each with its own Product.
    const [a, b] = await f.t.run(async (ctx) => {
      const product = async (slug: string, createdAt: number) =>
        ctx.db.insert("products", {
          ownerId: f.userId,
          name: "zamolxis",
          slug,
          createdAt,
          updatedAt: createdAt,
        });
      const repository = async (remoteUrl: string, productId: Id<"products">, createdAt: number) =>
        ctx.db.insert("repositories", {
          ownerId: f.userId,
          productId,
          name: "zamolxis",
          remoteUrl,
          createdAt,
          updatedAt: createdAt,
        });
      const productA = await product("a", 1);
      const productB = await product("b", 2);
      const repoA = await repository(SSH, productA, 1);
      const repoB = await repository(HTTPS, productB, 2);
      // History in the older Product must survive; the newer one is empty.
      await ctx.db.insert("workSessions", {
        ownerId: f.userId,
        productId: productA,
        title: "Earlier work",
        goal: "Earlier work",
        status: "completed",
        activeRunCount: 0,
        completedTaskCount: 1,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return [
        { repositoryId: repoA, productId: productA },
        { repositoryId: repoB, productId: productB },
      ];
    });
    if (!a || !b) throw new Error("fixture");
    await f.locate(f.mac, f.macId, a.repositoryId, "/Users/me/zamolxis");
    const linuxLocation = await f.locate(f.linux, f.linuxId, b.repositoryId, "/home/me/zamolxis");
    // The Linux computer runs setup again (its config still says https).
    const [registered] = await f.linux.mutation(api.onboarding.registerRepositories, {
      workstationId: f.linuxId,
      repositories: [{ name: "zamolxis", remoteUrl: HTTPS }],
    });
    expect(registered).toMatchObject({ repositoryId: a.repositoryId, productId: a.productId });
    const after = await f.t.run(async (ctx) => ({
      b: await ctx.db.get("repositories", b.repositoryId),
      productB: await ctx.db.get("products", b.productId),
      location: await ctx.db.get("repositoryLocations", linuxLocation),
    }));
    expect(after.b).toMatchObject({ mergedIntoId: a.repositoryId, productId: a.productId });
    expect(after.productB?.archivedAt).toBeTypeOf("number");
    expect(after.location).toMatchObject({ repositoryId: a.repositoryId, status: "available" });
    expect(await f.user.query(api.supervisor.products, {})).toHaveLength(1);
    expect(
      (await f.user.query(api.repositories.listByProduct, { productId: a.productId })).map(
        (row: { _id: Id<"repositories"> }) => row._id,
      ),
    ).toEqual([a.repositoryId]);
    expect(
      await f.user.query(api.repositories.listLocations, { workstationId: f.linuxId }),
    ).toHaveLength(1);
    // A Node whose config still names the merged entry lands on the survivor.
    expect(await f.locate(f.linux, f.linuxId, b.repositoryId, "/home/me/zamolxis")).toBe(
      linuxLocation,
    );
    const progress = await f.user.query(api.onboarding.progress, {});
    expect(progress.steps.find((step) => step.id === "repositories")?.detail).toBe(
      "1 repository ready on ubuntu.",
    );
    expect(
      await f.linux.mutation(api.repositories.removeOwnLocation, {
        workstationId: f.linuxId,
        repositoryId: b.repositoryId,
      }),
    ).toBe("removed");
  });

  it("archives a duplicate Product on the owner's request, merging its repository first", async () => {
    const f = await fixture();
    const { user: other } = await seedHuman(f.t, "bob");
    // Two Products for one remote, as the old rule left them, plus an unrelated Product.
    const seeded = await f.t.run(async (ctx) => {
      const product = (name: string, slug: string, createdAt: number) =>
        ctx.db.insert("products", {
          ownerId: f.userId,
          name,
          slug,
          createdAt,
          updatedAt: createdAt,
        });
      const repository = (
        name: string,
        remoteUrl: string,
        productId: Id<"products">,
        createdAt: number,
      ) =>
        ctx.db.insert("repositories", {
          ownerId: f.userId,
          productId,
          name,
          remoteUrl,
          createdAt,
          updatedAt: createdAt,
        });
      const productA = await product("zamolxis", "a", 1);
      const productB = await product("zamolxis", "b", 2);
      const productC = await product("docs", "c", 3);
      const repoA = await repository("zamolxis", SSH, productA, 1);
      const repoB = await repository("zamolxis", HTTPS, productB, 2);
      const repoC = await repository("docs", "https://github.com/bragaru-i/docs.git", productC, 3);
      await ctx.db.insert("workSessions", {
        ownerId: f.userId,
        productId: productB,
        title: "Earlier work in the duplicate",
        goal: "Earlier work",
        status: "completed",
        activeRunCount: 0,
        completedTaskCount: 1,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return { productA, productB, productC, repoA, repoB, repoC };
    });
    await f.locate(f.mac, f.macId, seeded.repoA, "/Users/me/zamolxis");
    const linuxLocation = await f.locate(f.linux, f.linuxId, seeded.repoB, "/home/me/zamolxis");
    const list = await f.user.query(api.products.list, {});
    expect(list.map((row) => [row.name, row.canArchive, row.sessions])).toEqual([
      ["docs", false, 0],
      ["zamolxis", false, 0],
      ["zamolxis", true, 1],
    ]);
    const duplicate = list.find((row) => row._id === seeded.productB);
    expect(duplicate?.repositories[0]?.duplicateOf).toEqual({
      productId: seeded.productA,
      name: "zamolxis",
    });
    // A Product whose repository exists nowhere else cannot be archived.
    await expect(
      f.user.mutation(api.products.archive, { productId: seeded.productC }),
    ).rejects.toThrow("PRODUCT_IN_USE");
    await expect(
      other.mutation(api.products.archive, { productId: seeded.productB }),
    ).rejects.toThrow("FORBIDDEN");
    await f.user.mutation(api.products.archive, { productId: seeded.productB });
    const after = await f.t.run(async (ctx) => ({
      b: await ctx.db.get("repositories", seeded.repoB),
      productB: await ctx.db.get("products", seeded.productB),
      location: await ctx.db.get("repositoryLocations", linuxLocation),
    }));
    expect(after.b).toMatchObject({ mergedIntoId: seeded.repoA, productId: seeded.productA });
    expect(after.productB?.archivedAt).toBeTypeOf("number");
    expect(after.location).toMatchObject({ repositoryId: seeded.repoA, status: "available" });
    expect((await f.user.query(api.supervisor.products, {})).map((row) => row.name)).toEqual([
      "zamolxis",
      "docs",
    ]);
    // Archiving again is a no-op; the Session history of the duplicate stays readable.
    await f.user.mutation(api.products.archive, { productId: seeded.productB });
    expect(
      await f.user.query(api.sessions.listMine, { paginationOpts: { numItems: 10, cursor: null } }),
    ).toMatchObject({
      page: [expect.objectContaining({ title: "Earlier work in the duplicate" })],
    });
  });

  it("leaves a duplicate alone while work runs in it", async () => {
    const f = await fixture();
    const [a] = await f.mac.mutation(api.onboarding.registerRepositories, {
      workstationId: f.macId,
      repositories: [{ name: "zamolxis", remoteUrl: HTTPS }],
    });
    if (!a) throw new Error("fixture");
    // Registered later than the first entry, so the first one survives.
    const later = Date.now() + 1000;
    const b = await f.t.run(async (ctx) => {
      const productId = await ctx.db.insert("products", {
        ownerId: f.userId,
        name: "zamolxis",
        slug: "b",
        createdAt: later,
        updatedAt: later,
      });
      const repositoryId = await ctx.db.insert("repositories", {
        ownerId: f.userId,
        productId,
        name: "zamolxis",
        remoteUrl: SSH,
        createdAt: later,
        updatedAt: later,
      });
      return { productId, repositoryId };
    });
    const location = await f.locate(f.linux, f.linuxId, b.repositoryId, "/home/me/zamolxis");
    await f.t.run(async (ctx) => {
      const workSessionId = await ctx.db.insert("workSessions", {
        ownerId: f.userId,
        productId: b.productId,
        title: "Running",
        goal: "Running",
        status: "running",
        activeRunCount: 1,
        completedTaskCount: 0,
        totalTaskCount: 1,
        needsInputCount: 0,
        lastActivityAt: 5,
        createdAt: 5,
        updatedAt: 5,
      });
      await ctx.db.insert("workspaces", {
        workSessionId,
        repositoryId: b.repositoryId,
        repositoryLocationId: location,
        workstationId: f.linuxId,
        kind: "worktree",
        status: "in_use",
        baseRef: "main",
        dirty: false,
        changedFileCount: 0,
        createdAt: 5,
        updatedAt: 5,
      });
    });
    const [registered] = await f.linux.mutation(api.onboarding.registerRepositories, {
      workstationId: f.linuxId,
      repositories: [{ name: "zamolxis", remoteUrl: SSH }],
    });
    expect(registered?.repositoryId).toBe(a.repositoryId);
    const after = await f.t.run(async (ctx) => ({
      b: await ctx.db.get("repositories", b.repositoryId),
      productB: await ctx.db.get("products", b.productId),
      location: await ctx.db.get("repositoryLocations", location),
    }));
    expect(after.b?.mergedIntoId).toBeUndefined();
    expect(after.productB?.archivedAt).toBeUndefined();
    expect(after.location?.repositoryId).toBe(b.repositoryId);
  });
});
