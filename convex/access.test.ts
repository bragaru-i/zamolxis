import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { seedHuman } from "../tests/fixtures/auth";
import { authRedirect, googleProfile } from "./lib/authPolicy";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./profiles.ts": () => import("./profiles"),
  "./workstations.ts": () => import("./workstations"),
  "./node.ts": () => import("./node"),
  "./pairing.ts": () => import("./pairing"),
  "./supervisor.ts": () => import("./supervisor"),
  "./repositories.ts": () => import("./repositories"),
};
it("defaults new Google users to pending and denies direct product, profile and pairing APIs", async () => {
  const t = convexTest(schema, modules);
  const f = await seedHuman(t, "new", "pending");
  await t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: undefined }));
  expect(await f.user.query(api.profiles.viewer, {})).toEqual({
    userId: f.userId,
    email: "new@example.com",
    accessStatus: "pending",
  });
  await expect(f.user.query(api.supervisor.products, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(f.user.query(api.workstations.listMine, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(f.user.mutation(api.profiles.ensure, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(f.user.mutation(api.repositories.create, { name: "Unauthorized" })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  await expect(
    f.user.mutation(api.pairing.approve, { approvalCode: "a".repeat(64) }),
  ).rejects.toThrow("ACCESS_DENIED");
  const user = await t.run((ctx) => ctx.db.get("users", f.userId));
  expect(user?.accessStatus).toBeUndefined();
});
it("database grant enables access; blocking revokes existing human and Node authority without deleting data", async () => {
  const t = convexTest(schema, modules);
  const f = await seedHuman(t, "owner", "pending");
  await t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "allowed" }));
  const repositoryId = await f.user.mutation(api.repositories.create, { name: "Private" });
  const workstationId = await f.user.mutation(api.workstations.register, {
    name: "Mac",
    nodeAuthSubject: "device",
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "owner",
  });
  expect(await node.query(api.node.listPending, { workstationId })).toEqual([]);
  await t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "blocked" }));
  expect((await f.user.query(api.profiles.viewer, {}))?.accessStatus).toBe("blocked");
  await expect(f.user.query(api.supervisor.products, {})).rejects.toThrow("ACCESS_DENIED");
  await expect(node.query(api.node.listPending, { workstationId })).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(await t.run((ctx) => ctx.db.get("repositories", repositoryId))).not.toBeNull();
  await t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "allowed" }));
  expect(await node.query(api.node.listPending, { workstationId })).toEqual([]);
});
it("Google sessions use immutable user IDs, not session tokenIdentifier or submitted email", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const bob = await seedHuman(t, "bob", "blocked");
  const changedToken = t.withIdentity({
    subject: `${alice.userId}|${alice.sessionId}`,
    tokenIdentifier: "new-session-token",
    email: "bob@example.com",
  });
  expect(await changedToken.mutation(api.profiles.ensure, {})).toBe(alice.userId);
  const forgedLookup = t.withIdentity({
    subject: `${bob.userId}|${bob.sessionId}`,
    tokenIdentifier: "alice",
  });
  await expect(forgedLookup.mutation(api.profiles.ensure, {})).rejects.toThrow("ACCESS_DENIED");
  const nodeAsHuman = t.withIdentity({
    subject: `${alice.userId}|${alice.sessionId}`,
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  expect(await nodeAsHuman.query(api.profiles.viewer, {})).toBeNull();
  await expect(nodeAsHuman.mutation(api.profiles.ensure, {})).rejects.toThrow("FORBIDDEN");
  await t.run((ctx) => ctx.db.patch("authSessions", alice.sessionId, { expirationTime: 0 }));
  expect(await changedToken.query(api.profiles.viewer, {})).toBeNull();
  await t.run((ctx) => ctx.db.delete("authSessions", alice.sessionId));
  expect(await changedToken.query(api.profiles.viewer, {})).toBeNull();
  await expect(changedToken.mutation(api.profiles.ensure, {})).rejects.toThrow("FORBIDDEN");
});
it("requires a matching live session and does not allow accounts to grant themselves access", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedHuman(t, "alice");
  const bob = await seedHuman(t, "bob", "pending");
  const swapped = t.withIdentity({
    subject: `${alice.userId}|${bob.sessionId}`,
    tokenIdentifier: "alice",
  });
  expect(await swapped.query(api.profiles.viewer, {})).toBeNull();
  await expect(
    bob.user.mutation(api.profiles.ensure, { accessStatus: "allowed" } as never),
  ).rejects.toThrow();
  expect((await bob.user.query(api.profiles.viewer, {}))?.accessStatus).toBe("pending");
  expect(await t.query(api.profiles.viewer, {})).toBeNull();
});
it("accepts only verified Google profiles and redirects only to the canonical HTTPS origin", () => {
  expect(
    googleProfile({ sub: "google-id", email: "owner@example.com", email_verified: true }),
  ).toEqual({ id: "google-id", email: "owner@example.com", emailVerified: true });
  expect(() =>
    googleProfile({ sub: "google-id", email: "owner@example.com", email_verified: false }),
  ).toThrow("verified");
  expect(authRedirect("https://zamolxis.example", "/?pair=abc")).toBe(
    "https://zamolxis.example/?pair=abc",
  );
  for (const destination of [
    "https://evil.example",
    "//evil.example",
    "https://zamolxis.example.evil.example",
    "https://user@zamolxis.example",
  ]) {
    expect(() => authRedirect("https://zamolxis.example", destination)).toThrow();
  }
  expect(() => authRedirect("http://zamolxis.example", "/")).toThrow();
  expect(() => authRedirect(undefined, "/")).toThrow();
});
