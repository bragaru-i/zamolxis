import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Web onboarding progress (#45): every step state comes from stored backend state.
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./node.ts": () => import("../convex/node"),
  "./onboarding.ts": () => import("../convex/onboarding"),
  "./workstations.ts": () => import("../convex/workstations"),
};

type Progress = Awaited<ReturnType<typeof progressOf>>;
function progressOf(user: { query: TestConvex<typeof schema>["query"] }) {
  return user.query(api.onboarding.progress, {});
}
function states(progress: Progress) {
  return Object.fromEntries(progress.steps.map((step) => [step.id, step.state]));
}
function detail(progress: Progress, id: string) {
  return progress.steps.find((step) => step.id === id)?.detail ?? "";
}

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  const node = t.withIdentity({
    subject: "device",
    issuer: "https://identity.example",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  return { t, user, userId, other, node };
}

// What pairing.approve leaves behind before setup activates the credential.
async function approvedMac(t: Awaited<ReturnType<typeof fixture>>["t"], ownerId: Id<"users">) {
  return t.run((ctx) =>
    ctx.db.insert("workstations", {
      ownerId,
      name: "Studio",
      status: "offline",
      nodeAuthSubject: "device",
      registeredAt: Date.now(),
    }),
  );
}
async function activate(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  workstationId: Id<"workstations">,
) {
  await t.run((ctx) =>
    ctx.db.insert("deviceCredentials", { workstationId, secretHash: "h", createdAt: Date.now() }),
  );
}
async function registerRepository(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  ownerId: Id<"users">,
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const productId = await ctx.db.insert("products", {
      ownerId,
      name: "app",
      slug: "repo-app",
      createdAt: now,
      updatedAt: now,
    });
    return ctx.db.insert("repositories", {
      ownerId,
      productId,
      name: "app",
      remoteUrl: "git@example.com:a/app.git",
      createdAt: now,
      updatedAt: now,
    });
  });
}
const codex = [{ runtime: "codex", capabilities: ["start"], version: "codex-cli 0.160.0" }];

afterEach(() => {
  vi.useRealTimers();
});

describe("onboarding progress", () => {
  it("asks a new owner to run setup and scan the QR code", async () => {
    const { user } = await fixture();
    const progress = await progressOf(user);
    expect(progress.complete).toBe(false);
    expect(states(progress)).toEqual({
      signin: "done",
      access: "done",
      pair: "needs_you",
      repositories: "upcoming",
      service: "upcoming",
      codex: "upcoming",
      session: "upcoming",
    });
    expect(detail(progress, "pair")).toContain("pnpm zamolxis setup");
    expect(detail(progress, "pair")).toContain("QR code");
  });

  it("follows pairing, repository registration, the first heartbeat and Codex to the first session", async () => {
    const { t, user, userId, node } = await fixture();
    const workstationId = await approvedMac(t, userId);
    let progress = await progressOf(user);
    expect(states(progress)).toMatchObject({
      pair: "in_progress",
      repositories: "upcoming",
      service: "upcoming",
    });

    await activate(t, workstationId);
    progress = await progressOf(user);
    expect(states(progress)).toMatchObject({
      pair: "done",
      repositories: "in_progress",
      service: "in_progress",
      codex: "upcoming",
    });
    expect(detail(progress, "service")).toContain("first heartbeat");

    const repositoryId = await registerRepository(t, userId);
    progress = await progressOf(user);
    expect(detail(progress, "repositories")).toContain("1 repository registered");

    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-1",
      runtimeCapabilities: codex,
    });
    await node.mutation(api.node.registerLocation, {
      workstationId,
      repositoryId,
      canonicalPath: "/Users/alice/app",
      gitCommonDir: "/Users/alice/app/.git",
      headSha: "a".repeat(40),
    });
    progress = await progressOf(user);
    expect(states(progress)).toEqual({
      signin: "done",
      access: "done",
      pair: "done",
      repositories: "done",
      service: "done",
      codex: "done",
      session: "needs_you",
    });
    expect(detail(progress, "codex")).toContain("codex-cli 0.160.0");
    // The Mac stops reporting: the client switches to the stale state at this time.
    const service = progress.steps.find((step) => step.id === "service");
    expect(service?.staleAfter).toBeGreaterThan(Date.now());
    expect(service?.stale).toEqual({
      state: "failed",
      detail: expect.stringContaining("pnpm zamolxis setup --repair"),
    });

    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("workSessions", {
        ownerId: userId,
        title: "First",
        goal: "First",
        status: "waiting",
        activeRunCount: 0,
        completedTaskCount: 0,
        totalTaskCount: 0,
        needsInputCount: 0,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    progress = await progressOf(user);
    expect(progress.complete).toBe(true);
    expect(states(progress).session).toBe("done");
  });

  it("reports an offline Mac and tells the owner how to repair it", async () => {
    const { t, user, userId, node } = await fixture();
    const workstationId = await approvedMac(t, userId);
    await activate(t, workstationId);
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-1",
      runtimeCapabilities: codex,
    });
    vi.setSystemTime(Date.now() + 60_000);
    const progress = await progressOf(user);
    expect(states(progress).service).toBe("failed");
    expect(detail(progress, "service")).toBe(
      "Studio is offline. Open Terminal on your Mac and run `pnpm zamolxis setup --repair`.",
    );
    // Codex was reported by the last heartbeat; it stays as reported.
    expect(states(progress).codex).toBe("done");
    expect(states(progress).session).toBe("upcoming");
  });

  it("reports Codex that the Mac does not advertise", async () => {
    const { t, user, userId, node } = await fixture();
    const workstationId = await approvedMac(t, userId);
    await activate(t, workstationId);
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-1",
      runtimeCapabilities: codex,
    });
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-1",
      runtimeCapabilities: [{ runtime: "fake", capabilities: ["start"] }],
    });
    const progress = await progressOf(user);
    expect(states(progress)).toMatchObject({ service: "done", codex: "failed" });
    expect(detail(progress, "codex")).toContain("codex login");
  });

  it("asks for repositories when the running Mac has none, and flags missing ones", async () => {
    const { t, user, userId, node } = await fixture();
    const workstationId = await approvedMac(t, userId);
    await activate(t, workstationId);
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: "instance-1",
      runtimeCapabilities: codex,
    });
    let progress = await progressOf(user);
    expect(states(progress).repositories).toBe("needs_you");
    expect(detail(progress, "repositories")).toContain("Add or remove repositories");

    const repositoryId = await registerRepository(t, userId);
    const locationId = await node.mutation(api.node.registerLocation, {
      workstationId,
      repositoryId,
      canonicalPath: "/Users/alice/app",
      gitCommonDir: "/Users/alice/app/.git",
      headSha: "a".repeat(40),
    });
    await t.run((ctx) => ctx.db.patch("repositoryLocations", locationId, { status: "missing" }));
    progress = await progressOf(user);
    expect(states(progress).repositories).toBe("failed");
    await t.run((ctx) => ctx.db.patch("repositoryLocations", locationId, { status: "removed" }));
    progress = await progressOf(user);
    expect(states(progress).repositories).toBe("needs_you");
  });

  it("only reads the signed-in owner's Macs, repositories and sessions", async () => {
    const { t, user, other, userId } = await fixture();
    const workstationId = await approvedMac(t, userId);
    await activate(t, workstationId);
    await registerRepository(t, userId);
    await t.run((ctx) =>
      ctx.db.patch("workstations", workstationId, {
        status: "online",
        lastHeartbeatAt: Date.now(),
      }),
    );
    expect(states(await progressOf(user)).pair).toBe("done");
    const bob = await progressOf(other);
    expect(states(bob)).toMatchObject({ pair: "needs_you", repositories: "upcoming" });
    expect(bob.steps.some((step) => step.detail.includes("Studio"))).toBe(false);
    // A revoked Mac no longer counts.
    await user.mutation(api.workstations.revoke, { workstationId });
    expect(states(await progressOf(user)).pair).toBe("needs_you");
    // Pending access and anonymous callers get nothing.
    const { user: pending } = await seedHuman(t, "carol", "pending");
    await expect(progressOf(pending)).rejects.toThrow("ACCESS_DENIED");
    await expect(t.query(api.onboarding.progress, {})).rejects.toThrow("FORBIDDEN");
  });
});
