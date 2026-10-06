import { ConvexError } from "convex/values";
import { convexTest, type TestConvex } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Second-account isolation (#47): another approved user walks every user-facing query
// and mutation against the owner's data and gets FORBIDDEN/NOT_FOUND or nothing back.
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./admin.ts": () => import("../convex/admin"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./approvals.ts": () => import("../convex/approvals"),
  "./events.ts": () => import("../convex/events"),
  "./node.ts": () => import("../convex/node"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./runDetail.ts": () => import("../convex/runDetail"),
  "./runs.ts": () => import("../convex/runs"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./traces.ts": () => import("../convex/traces"),
  "./trust.ts": () => import("../convex/trust"),
  "./usage.ts": () => import("../convex/usage"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./workstations.ts": () => import("../convex/workstations"),
};

type T = TestConvex<typeof schema>;

// The owner's data, written directly: this test is about who may read and change it.
async function ownerData(t: T, ownerId: Awaited<ReturnType<typeof seedHuman>>["userId"]) {
  return t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch("users", ownerId, { role: "admin" });
    const productId = await ctx.db.insert("products", {
      ownerId,
      name: "Secret product",
      slug: "secret",
      createdAt: now,
      updatedAt: now,
    });
    const repositoryId = await ctx.db.insert("repositories", {
      ownerId,
      productId,
      name: "secret-repo",
      remoteUrl: "https://example.invalid/secret.git",
      createdAt: now,
      updatedAt: now,
    });
    const workstationId = await ctx.db.insert("workstations", {
      ownerId,
      name: "Owner's computer",
      status: "online",
      nodeAuthSubject: "owner-device",
      lastHeartbeatAt: now,
      registeredAt: now,
    });
    const repositoryLocationId = await ctx.db.insert("repositoryLocations", {
      repositoryId,
      workstationId,
      canonicalPath: "/Users/owner/secret",
      status: "available",
      updatedAt: now,
    });
    const workSessionId = await ctx.db.insert("workSessions", {
      ownerId,
      productId,
      title: "Secret session",
      goal: "Secret goal",
      status: "running",
      activeRunCount: 1,
      completedTaskCount: 0,
      totalTaskCount: 1,
      needsInputCount: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("sessionRepositories", { workSessionId, repositoryId, role: "primary" });
    const taskId = await ctx.db.insert("tasks", {
      workSessionId,
      title: "Secret task",
      description: "Secret",
      kind: "implementation",
      status: "running",
      runtimePolicyMode: "auto",
      priority: 1,
      createdAt: now,
      updatedAt: now,
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
      createdAt: now,
      updatedAt: now,
    });
    const profileId = await ctx.db.insert("agentProfiles", {
      ownerId,
      productId,
      name: "Secret builder",
      role: "builder",
      runtime: "codex",
      enabled: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("agentRuns", {
      workSessionId,
      taskId,
      workspaceId,
      workstationId,
      role: "builder",
      runtime: "codex",
      agentProfileId: profileId,
      status: "waiting",
      attempt: 1,
      totalTokens: 1234,
      lastActivityAt: now,
      startedAt: now,
    });
    await ctx.db.insert("runEvents", {
      runId,
      workstationId,
      eventId: "e1",
      sequence: 1,
      type: "run.started",
      occurredAt: now,
      payload: { secret: true },
    });
    const approvalId = await ctx.db.insert("approvals", {
      ownerId,
      workSessionId,
      runId,
      workstationId,
      action: "command",
      risk: "high",
      request: { command: "secret" },
      status: "pending",
      requestedAt: now,
    });
    const textCommandId = await ctx.db.insert("textCommands", {
      ownerId,
      idempotencyKey: "owner-message",
      text: "Secret message",
      productId,
      repositoryId,
      workSessionId,
    });
    const [ownerSession] = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", ownerId))
      .collect();
    if (!ownerSession) throw new Error("owner session missing");
    await ctx.db.insert("signInLabels", {
      userId: ownerId,
      sessionId: ownerSession._id,
      label: "Safari on iPhone",
      updatedAt: now,
    });
    return {
      productId,
      repositoryId,
      workstationId,
      repositoryLocationId,
      workSessionId,
      taskId,
      workspaceId,
      profileId,
      runId,
      approvalId,
      textCommandId,
      ownerSessionId: ownerSession._id,
    };
  });
}

const DENIED = ["FORBIDDEN", "NOT_FOUND", "PRODUCT_MISMATCH"];
async function denied(name: string, call: () => Promise<unknown>) {
  const error = await call().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const code =
    error instanceof ConvexError ? (error.data as { code?: string }).code : String(error);
  expect(DENIED, `${name} must be refused, got ${code}`).toContain(code);
}

it("keeps every user-facing function closed to a second approved account", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedHuman(t, "owner");
  const { user: other } = await seedHuman(t, "other");
  const o = await ownerData(t, owner.userId);
  const page = { numItems: 10, cursor: null };

  // Reads of the owner's data are refused.
  await denied("sessions.get", () =>
    other.query(api.sessions.get, { workSessionId: o.workSessionId }),
  );
  await denied("supervisor.messages", () =>
    other.query(api.supervisor.messages, { workSessionId: o.workSessionId }),
  );
  await denied("tasks.listBySession", () =>
    other.query(api.tasks.listBySession, { workSessionId: o.workSessionId }),
  );
  await denied("workspaces.listBySession", () =>
    other.query(api.workspaces.listBySession, { workSessionId: o.workSessionId }),
  );
  await denied("runs.get", () => other.query(api.runs.get, { runId: o.runId }));
  await denied("runs.listBySession", () =>
    other.query(api.runs.listBySession, { workSessionId: o.workSessionId }),
  );
  await denied("events.listByRun", () =>
    other.query(api.events.listByRun, { runId: o.runId, paginationOpts: page }),
  );
  await denied("traces.listByRun", () =>
    other.query(api.traces.listByRun, { runId: o.runId, paginationOpts: page }),
  );
  await denied("trust.listByRun", () => other.query(api.trust.listByRun, { runId: o.runId }));
  await denied("runDetail.get", () => other.query(api.runDetail.get, { runId: o.runId }));
  await denied("runDetail.changedFiles", () =>
    other.query(api.runDetail.changedFiles, { runId: o.runId }),
  );
  await denied("usage.session", () =>
    other.query(api.usage.session, { workSessionId: o.workSessionId }),
  );
  await denied("approvals.listPendingBySession", () =>
    other.query(api.approvals.listPendingBySession, { workSessionId: o.workSessionId }),
  );
  await denied("repositories.listByProduct", () =>
    other.query(api.repositories.listByProduct, { productId: o.productId }),
  );
  await denied("repositories.listLocations", () =>
    other.query(api.repositories.listLocations, { workstationId: o.workstationId }),
  );
  await denied("admin.listUsers", () => other.query(api.admin.listUsers, {}));

  // Lists scoped to the caller show none of the owner's data.
  expect((await other.query(api.sessions.listMine, { paginationOpts: page })).page).toEqual([]);
  expect(await other.query(api.supervisor.products, {})).toEqual([]);
  expect(await other.query(api.approvals.listPending, {})).toEqual([]);
  expect(await other.query(api.agentProfiles.list, {})).toEqual([]);
  expect(await other.query(api.agentProfiles.list, { productId: o.productId })).toEqual([]);
  expect(await other.query(api.workstations.listMine, {})).toEqual([]);
  expect(await other.query(api.admin.viewerRole, {})).toEqual({ isAdmin: false });
  const usage = await other.query(api.usage.summary, { period: "30d" });
  expect(usage.sessionCount).toBe(0);
  expect(usage.topSessions).toEqual([]);
  const signIns = await other.query(api.admin.mySignIns, {});
  expect(signIns).toHaveLength(1);
  expect(signIns.map((row) => row.sessionId)).not.toContain(o.ownerSessionId);
  expect(signIns[0]?.label).toBeNull();

  // Changes to the owner's data are refused.
  await denied("sessions.cancel", () =>
    other.mutation(api.sessions.cancel, { workSessionId: o.workSessionId }),
  );
  await denied("sessions.create", () =>
    other.mutation(api.sessions.create, { title: "x", goal: "x", repositoryIds: [o.repositoryId] }),
  );
  await denied("supervisor.submit", () =>
    other.mutation(api.supervisor.submit, {
      productId: o.productId,
      repositoryId: o.repositoryId,
      text: "hello",
      idempotencyKey: "other-message",
    }),
  );
  await denied("supervisor.submit into the owner's session", () =>
    other.mutation(api.supervisor.submit, {
      productId: o.productId,
      repositoryId: o.repositoryId,
      text: "hello",
      idempotencyKey: "other-follow-up",
      sessionId: o.workSessionId,
    }),
  );
  await denied("supervisor.stop", () =>
    other.mutation(api.supervisor.stop, { textCommandId: o.textCommandId }),
  );
  await denied("tasks.create", () =>
    other.mutation(api.tasks.create, {
      workSessionId: o.workSessionId,
      title: "x",
      description: "x",
      kind: "implementation",
      priority: 1,
      runtimePolicy: { mode: "auto" },
    }),
  );
  await denied("tasks.cancel", () => other.mutation(api.tasks.cancel, { taskId: o.taskId }));
  await denied("workspaces.request", () =>
    other.mutation(api.workspaces.request, {
      taskId: o.taskId,
      repositoryLocationId: o.repositoryLocationId,
      baseRef: "main",
    }),
  );
  await denied("runs.request", () =>
    other.mutation(api.runs.request, {
      taskId: o.taskId,
      workspaceId: o.workspaceId,
      runtime: "codex",
    }),
  );
  await denied("runs.sendMessage", () =>
    other.mutation(api.runs.sendMessage, {
      runId: o.runId,
      message: "x",
      idempotencyKey: "other-steer",
    }),
  );
  await denied("runs.stop", () => other.mutation(api.runs.stop, { runId: o.runId }));
  await denied("approvals.resolve", () =>
    other.mutation(api.approvals.resolve, { approvalId: o.approvalId, decision: "approved" }),
  );
  await denied("admin.setAccess", () =>
    other.mutation(api.admin.setAccess, { userId: owner.userId, accessStatus: "blocked" }),
  );
  await denied("admin.setAdmin", () =>
    other.mutation(api.admin.setAdmin, { userId: owner.userId, admin: false }),
  );
  expect(await other.mutation(api.admin.revokeSignIn, { sessionId: o.ownerSessionId })).toBe(false);
  await denied("agentProfiles.upsert of the owner's profile", () =>
    other.mutation(api.agentProfiles.upsert, {
      profileId: o.profileId,
      name: "Mine now",
      role: "builder",
      runtime: "codex",
      enabled: false,
    }),
  );
  await denied("agentProfiles.upsert into the owner's product", () =>
    other.mutation(api.agentProfiles.upsert, {
      productId: o.productId,
      name: "Mine now",
      role: "builder",
      runtime: "codex",
      enabled: false,
    }),
  );
  await denied("agentProfiles.removeOverride", () =>
    other.mutation(api.agentProfiles.removeOverride, { profileId: o.profileId }),
  );
  await denied("agentProfiles.setRuntimeForAllRoles into the owner's product", () =>
    other.mutation(api.agentProfiles.setRuntimeForAllRoles, {
      productId: o.productId,
      runtime: "claude",
    }),
  );
  await denied("workstations.rename", () =>
    other.mutation(api.workstations.rename, { workstationId: o.workstationId, name: "Mine" }),
  );
  await denied("workstations.revoke", () =>
    other.mutation(api.workstations.revoke, { workstationId: o.workstationId }),
  );
  await denied("workstations.register with the owner's device identity", () =>
    other.mutation(api.workstations.register, { name: "Mine", nodeAuthSubject: "owner-device" }),
  );
  await denied("repositories.create in the owner's product", () =>
    other.mutation(api.repositories.create, { name: "x", productId: o.productId }),
  );
  await denied("repositories.removeLocationForOwner", () =>
    other.mutation(api.repositories.removeLocationForOwner, {
      repositoryLocationId: o.repositoryLocationId,
    }),
  );
  // A human session is never a Node identity.
  await denied("node.health", () =>
    other.query(api.node.health, { workstationId: o.workstationId }),
  );
  await denied("workstations.renameSelf", () =>
    other.mutation(api.workstations.renameSelf, { workstationId: o.workstationId, name: "x" }),
  );
  // Labelling only ever touches the caller's own sign-in.
  await other.mutation(api.admin.labelThisDevice, { label: "Chrome on Windows" });

  // Nothing of the owner's changed.
  const after = await t.run(async (ctx) => ({
    session: await ctx.db.get("workSessions", o.workSessionId),
    task: await ctx.db.get("tasks", o.taskId),
    run: await ctx.db.get("agentRuns", o.runId),
    approval: await ctx.db.get("approvals", o.approvalId),
    workstation: await ctx.db.get("workstations", o.workstationId),
    location: await ctx.db.get("repositoryLocations", o.repositoryLocationId),
    profile: await ctx.db.get("agentProfiles", o.profileId),
    owner: await ctx.db.get("users", owner.userId),
    ownerSession: await ctx.db.get("authSessions", o.ownerSessionId),
    commands: await ctx.db.query("commands").collect(),
    sessions: await ctx.db.query("workSessions").collect(),
  }));
  expect(after.session?.status).toBe("running");
  expect(after.task?.status).toBe("running");
  expect(after.run?.status).toBe("waiting");
  expect(after.approval?.status).toBe("pending");
  expect(after.workstation).toMatchObject({ name: "Owner's computer", status: "online" });
  expect(after.location?.status).toBe("available");
  expect(after.profile).toMatchObject({ name: "Secret builder", enabled: true, revision: 1 });
  expect(after.owner).toMatchObject({ accessStatus: "allowed", role: "admin" });
  expect(after.ownerSession).not.toBeNull();
  expect(after.commands).toEqual([]);
  expect(after.sessions).toHaveLength(1);
  const ownerSignIns = await owner.user.query(api.admin.mySignIns, {});
  expect(ownerSignIns[0]?.label).toBe("Safari on iPhone");
  // The owner still sees all of it.
  expect(
    (await owner.user.query(api.sessions.listMine, { paginationOpts: page })).page,
  ).toHaveLength(1);
  expect(await owner.user.query(api.approvals.listPending, {})).toHaveLength(1);
});

it("gives an account without access nothing at all", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedHuman(t, "owner");
  const { user: pending } = await seedHuman(t, "pending", "pending");
  const o = await ownerData(t, owner.userId);
  const page = { numItems: 10, cursor: null };
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["sessions.listMine", () => pending.query(api.sessions.listMine, { paginationOpts: page })],
    ["supervisor.products", () => pending.query(api.supervisor.products, {})],
    ["approvals.listPending", () => pending.query(api.approvals.listPending, {})],
    ["usage.summary", () => pending.query(api.usage.summary, { period: "7d" })],
    ["agentProfiles.list", () => pending.query(api.agentProfiles.list, {})],
    ["agentProfiles.defaultRuntime", () => pending.query(api.agentProfiles.defaultRuntime, {})],
    ["workstations.listMine", () => pending.query(api.workstations.listMine, {})],
    ["admin.mySignIns", () => pending.query(api.admin.mySignIns, {})],
    ["runs.get", () => pending.query(api.runs.get, { runId: o.runId })],
    ["admin.labelThisDevice", () => pending.mutation(api.admin.labelThisDevice, { label: "x" })],
  ];
  for (const [name, call] of calls) {
    const error = await call().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(
      error instanceof ConvexError ? (error.data as { code?: string }).code : String(error),
      name,
    ).toBe("ACCESS_DENIED");
  }
});
