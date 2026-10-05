import { convexTest, type TestConvex } from "convex-test";
import { expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./admin.ts": () => import("../convex/admin"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
};

type T = TestConvex<typeof schema>;

async function makeAdmin(t: T, userId: Id<"users">) {
  await t.run((ctx) => ctx.db.patch("users", userId, { role: "admin" }));
}

// A second browser sign-in for the same user, with refresh tokens.
async function addSignIn(t: T, userId: Id<"users">, name: string) {
  const sessionId = await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3600_000,
    });
    const first = await ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 3600_000,
    });
    await ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 3600_000,
      parentRefreshTokenId: first,
    });
    return sessionId;
  });
  return {
    sessionId,
    user: t.withIdentity({ subject: `${userId}|${sessionId}`, tokenIdentifier: `${name}-2` }),
  };
}

const sessionsOf = (t: T, userId: Id<"users">) =>
  t.run((ctx) =>
    ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect(),
  );
const refreshTokensOf = (t: T, sessionId: Id<"authSessions">) =>
  t.run((ctx) =>
    ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );

it("bootstraps exactly one approved admin deterministically and never a pending or blocked user", async () => {
  const t = convexTest(schema, modules);
  await seedHuman(t, "pending", "pending");
  await seedHuman(t, "blocked", "blocked");
  await expect(t.mutation(internal.admin.bootstrapAdmin, {})).rejects.toThrow("No approved user");
  await expect(
    t.mutation(internal.admin.bootstrapAdmin, { email: "pending@example.com" }),
  ).rejects.toThrow("BOOTSTRAP_AMBIGUOUS");
  const owner = await seedHuman(t, "owner");
  const second = await seedHuman(t, "second");
  await expect(t.mutation(internal.admin.bootstrapAdmin, {})).rejects.toThrow(
    "2 approved users match",
  );
  expect(await t.mutation(internal.admin.bootstrapAdmin, { email: " Owner@Example.com " })).toEqual(
    { status: "promoted", userId: owner.userId, email: "owner@example.com" },
  );
  // Idempotent: a second run, even naming someone else, keeps the existing admin.
  expect(await t.mutation(internal.admin.bootstrapAdmin, { email: "second@example.com" })).toEqual({
    status: "exists",
    userId: owner.userId,
    email: "owner@example.com",
  });
  expect(await owner.user.query(api.admin.viewerRole, {})).toEqual({ isAdmin: true });
  expect(await second.user.query(api.admin.viewerRole, {})).toEqual({ isAdmin: false });
  // Registered as an internal function: not callable from a browser client.
  const { bootstrapAdmin } = await import("../convex/admin");
  expect((bootstrapAdmin as unknown as { isInternal: boolean }).isInternal).toBe(true);
});

it("denies administration to non-admins, unapproved accounts and stale admins", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedHuman(t, "admin");
  await makeAdmin(t, admin.userId);
  const member = await seedHuman(t, "member");
  const pending = await seedHuman(t, "pending", "pending");
  await expect(member.user.query(api.admin.listUsers, {})).rejects.toThrow("FORBIDDEN");
  await expect(
    member.user.mutation(api.admin.setAccess, { userId: pending.userId, accessStatus: "allowed" }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    member.user.mutation(api.admin.setAdmin, { userId: member.userId, admin: true }),
  ).rejects.toThrow();
  await expect(pending.user.query(api.admin.viewerRole, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(
    pending.user.mutation(api.admin.setAccess, { userId: pending.userId, accessStatus: "allowed" }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(t.query(api.admin.listUsers, {})).rejects.toThrow("FORBIDDEN");
  // A role on a blocked row grants nothing.
  await t.run((ctx) =>
    ctx.db.patch("users", member.userId, { role: "admin", accessStatus: "blocked" }),
  );
  await expect(member.user.query(api.admin.listUsers, {})).rejects.toThrow("ACCESS_DENIED");
  expect((await t.run((ctx) => ctx.db.get("users", pending.userId)))?.accessStatus).toBe("pending");
});

it("lists people pending first, approves idempotently and promotes only approved users", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedHuman(t, "admin");
  await makeAdmin(t, admin.userId);
  const pending = await seedHuman(t, "newcomer", "pending");
  await t.run((ctx) => ctx.db.patch("users", pending.userId, { name: "New Comer" }));
  const list = await admin.user.query(api.admin.listUsers, {});
  expect(list.map((row) => [row.email, row.accessStatus, row.isAdmin, row.isSelf])).toEqual([
    ["newcomer@example.com", "pending", false, false],
    ["admin@example.com", "allowed", true, true],
  ]);
  expect(list[0]?.name).toBe("New Comer");
  expect(list[0]?.lastSignInAt).toEqual(expect.any(Number));

  await expect(
    admin.user.mutation(api.admin.setAdmin, { userId: pending.userId, admin: true }),
  ).rejects.toThrow("Approve this person");
  expect(
    await admin.user.mutation(api.admin.setAccess, {
      userId: pending.userId,
      accessStatus: "allowed",
    }),
  ).toEqual({ changed: true, revokedSessions: 0 });
  expect(
    await admin.user.mutation(api.admin.setAccess, {
      userId: pending.userId,
      accessStatus: "allowed",
    }),
  ).toEqual({ changed: false, revokedSessions: 0 });
  expect(await pending.user.mutation(api.profiles.ensure, {})).toBe(pending.userId);
  expect(
    await admin.user.mutation(api.admin.setAdmin, { userId: pending.userId, admin: true }),
  ).toEqual({ changed: true });
  expect(
    await admin.user.mutation(api.admin.setAdmin, { userId: pending.userId, admin: true }),
  ).toEqual({ changed: false });
});

it("refuses self changes, so the last admin can never be removed", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedHuman(t, "admin");
  await makeAdmin(t, admin.userId);
  for (const accessStatus of ["blocked", "pending", "allowed"] as const)
    await expect(
      admin.user.mutation(api.admin.setAccess, { userId: admin.userId, accessStatus }),
    ).rejects.toThrow("own access");
  await expect(
    admin.user.mutation(api.admin.setAdmin, { userId: admin.userId, admin: false }),
  ).rejects.toThrow("own role");
  expect(await t.run((ctx) => ctx.db.get("users", admin.userId))).toMatchObject({
    role: "admin",
    accessStatus: "allowed",
  });

  // With two admins, one may block the other; the blocked one loses the role.
  const other = await seedHuman(t, "other");
  await makeAdmin(t, other.userId);
  expect(
    await other.user.mutation(api.admin.setAccess, {
      userId: admin.userId,
      accessStatus: "blocked",
    }),
  ).toMatchObject({ changed: true });
  expect(await t.run((ctx) => ctx.db.get("users", admin.userId))).toMatchObject({
    accessStatus: "blocked",
  });
  expect((await t.run((ctx) => ctx.db.get("users", admin.userId)))?.role).toBeUndefined();
  // A pending or blocked row keeps no authority even if a role is set by hand.
  await t.run((ctx) => ctx.db.patch("users", admin.userId, { role: "admin" }));
  await expect(
    admin.user.mutation(api.admin.setAccess, { userId: other.userId, accessStatus: "blocked" }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    other.user.mutation(api.admin.setAdmin, { userId: other.userId, admin: false }),
  ).rejects.toThrow("own role");
});

it("blocking revokes all of the target's sessions and refresh tokens without touching data", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedHuman(t, "admin");
  await makeAdmin(t, admin.userId);
  const target = await seedHuman(t, "target");
  const second = await addSignIn(t, target.userId, "target");
  const repositoryId = await target.user.mutation(api.repositories.create, { name: "Kept" });
  expect(await sessionsOf(t, target.userId)).toHaveLength(2);

  expect(
    await admin.user.mutation(api.admin.setAccess, {
      userId: target.userId,
      accessStatus: "blocked",
    }),
  ).toEqual({ changed: true, revokedSessions: 2 });
  expect(await sessionsOf(t, target.userId)).toEqual([]);
  expect(await refreshTokensOf(t, second.sessionId)).toEqual([]);
  expect(await target.user.query(api.profiles.viewer, {})).toBeNull();
  await expect(second.user.mutation(api.profiles.ensure, {})).rejects.toThrow("FORBIDDEN");
  expect(await t.run((ctx) => ctx.db.get("repositories", repositoryId))).not.toBeNull();
  // The admin's own session is untouched.
  expect(await sessionsOf(t, admin.userId)).toHaveLength(1);
  // Idempotent.
  expect(
    await admin.user.mutation(api.admin.setAccess, {
      userId: target.userId,
      accessStatus: "blocked",
    }),
  ).toEqual({ changed: false, revokedSessions: 0 });
});

it("lists and revokes only the caller's own browser sign-ins", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const phone = await addSignIn(t, alice.userId, "alice");
  const laptop = await addSignIn(t, alice.userId, "alice-laptop");
  const bob = await seedHuman(t, "bob");
  await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId: alice.userId, expirationTime: Date.now() - 1 }),
  );

  const list = await alice.user.query(api.admin.mySignIns, {});
  expect(list).toHaveLength(3);
  expect(list[0]).toMatchObject({ sessionId: alice.sessionId, current: true });
  expect(list.filter((row) => row.current)).toHaveLength(1);
  expect((await bob.user.query(api.admin.mySignIns, {})).map((row) => row.sessionId)).toEqual([
    bob.sessionId,
  ]);

  await expect(
    alice.user.mutation(api.admin.revokeSignIn, { sessionId: alice.sessionId }),
  ).rejects.toThrow("Sign out");
  // Bob cannot revoke Alice's session, and learns nothing about it.
  expect(await bob.user.mutation(api.admin.revokeSignIn, { sessionId: phone.sessionId })).toBe(
    false,
  );
  expect(await sessionsOf(t, alice.userId)).toHaveLength(4);

  expect(await alice.user.mutation(api.admin.revokeSignIn, { sessionId: phone.sessionId })).toBe(
    true,
  );
  expect(await refreshTokensOf(t, phone.sessionId)).toEqual([]);
  await expect(phone.user.mutation(api.profiles.ensure, {})).rejects.toThrow("FORBIDDEN");
  expect(await alice.user.mutation(api.admin.revokeSignIn, { sessionId: phone.sessionId })).toBe(
    false,
  );

  expect(await alice.user.mutation(api.admin.signOutOtherDevices, {})).toBe(2);
  expect((await sessionsOf(t, alice.userId)).map((session) => session._id)).toEqual([
    alice.sessionId,
  ]);
  await expect(laptop.user.query(api.admin.mySignIns, {})).rejects.toThrow("FORBIDDEN");
  expect(await alice.user.query(api.profiles.viewer, {})).not.toBeNull();
  expect(await sessionsOf(t, bob.userId)).toHaveLength(1);

  const pending = await seedHuman(t, "pending", "pending");
  await expect(pending.user.query(api.admin.mySignIns, {})).rejects.toThrow("ACCESS_DENIED");
});
