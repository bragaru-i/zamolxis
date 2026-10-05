import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { seedHuman } from "../tests/fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./profiles.ts": () => import("./profiles"),
  "./pairing.ts": () => import("./pairing"),
  "./deviceTokens.ts": () => import("./deviceTokens"),
  "./workstations.ts": () => import("./workstations"),
  "./onboarding.ts": () => import("./onboarding"),
};
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  vi.stubEnv(
    "ZAMOLXIS_DEVICE_PRIVATE_KEY",
    privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
  vi.stubEnv(
    "ZAMOLXIS_DEVICE_JWKS",
    JSON.stringify({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }],
    }),
  );
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  await user.mutation(api.profiles.ensure, {});
  const approvalCode = "a".repeat(64);
  const pollSecret = "b".repeat(64);
  const credential = "c".repeat(64);
  const pairingId = await t.mutation(api.pairing.begin, {
    approvalCode,
    pollSecret,
    name: "Fixture Mac",
  });
  return { t, user, userId, pairingId, approvalCode, pollSecret, credential, publicKey };
}
it("requires authenticated single-use approval and a separate Mac secret before minting a signed device credential", async () => {
  const f = await fixture();
  await expect(f.t.mutation(api.pairing.approve, { approvalCode: f.approvalCode })).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    f.t.action(api.deviceTokens.enroll, {
      pairingId: f.pairingId,
      pollSecret: f.pollSecret,
      credential: f.credential,
    }),
  ).rejects.toThrow("FORBIDDEN");
  const workstationId = await f.user.mutation(api.pairing.approve, {
    approvalCode: f.approvalCode,
  });
  await expect(
    f.user.mutation(api.pairing.approve, { approvalCode: f.approvalCode }),
  ).rejects.toThrow("PAIRING_EXPIRED_OR_USED");
  await expect(
    f.t.query(api.pairing.poll, { pairingId: f.pairingId, pollSecret: f.approvalCode }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.t.action(api.deviceTokens.enroll, {
      pairingId: f.pairingId,
      pollSecret: f.approvalCode,
      credential: f.credential,
    }),
  ).rejects.toThrow("FORBIDDEN");
  const issued = await f.t.action(api.deviceTokens.enroll, {
    pairingId: f.pairingId,
    pollSecret: f.pollSecret,
    credential: f.credential,
  });
  expect(issued.workstationId).toBe(workstationId);
  const [header, payload, signature] = issued.token.split(".");
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(f.publicKey.export({ type: "spki", format: "pem" })),
      Buffer.from(signature ?? "", "base64url"),
    ),
  ).toBe(true);
  const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
  expect(claims.ownerSubject).toBe("alice");
  expect(claims.aud).toBe("zamolxis-node");
  expect(claims.exp - claims.iat).toBe(900);
  expect(
    (await f.t.query(api.pairing.poll, { pairingId: f.pairingId, pollSecret: f.pollSecret }))
      .status,
  ).toBe("consumed");
  await expect(
    f.t.action(api.deviceTokens.enroll, {
      pairingId: f.pairingId,
      pollSecret: f.pollSecret,
      credential: "d".repeat(64),
    }),
  ).rejects.toThrow("PAIRING_EXPIRED_OR_USED");
  await f.t.action(api.deviceTokens.refresh, { credential: f.credential });
  const node = f.t.withIdentity({
    subject: claims.sub,
    tokenIdentifier: `${claims.iss}|${claims.sub}`,
    ownerSubject: "alice",
  });
  const input = {
    workstationId,
    repositories: [{ name: "Repo", remoteUrl: "https://example.invalid/repo" }],
  };
  const registered = await node.mutation(api.onboarding.registerRepositories, input);
  expect(await node.mutation(api.onboarding.registerRepositories, input)).toEqual(registered);
  await f.user.mutation(api.workstations.revoke, { workstationId });
  await expect(f.t.action(api.deviceTokens.refresh, { credential: f.credential })).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("expires pending pairing and never mints credentials from QR alone", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch("pairingRequests", f.pairingId, { expiresAt: Date.now() - 1 });
  });
  await expect(
    f.user.mutation(api.pairing.approve, { approvalCode: f.approvalCode }),
  ).rejects.toThrow("PAIRING_EXPIRED_OR_USED");
  expect(
    (await f.t.query(api.pairing.poll, { pairingId: f.pairingId, pollSecret: f.pollSecret }))
      .status,
  ).toBe("expired");
  await expect(
    f.t.action(api.deviceTokens.refresh, { credential: f.approvalCode }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.t.mutation(internal.pairing.activate, {
      pairingId: f.pairingId,
      pollHash: "invalid",
      credentialHash: "invalid",
    }),
  ).rejects.toThrow("FORBIDDEN");
});

it("binds device ownership to the stable auth user and denies activation/refresh after owner access is blocked", async () => {
  const f = await fixture();
  await f.t.run((ctx) => ctx.db.patch("users", f.userId, { authSubject: undefined }));
  await f.user.mutation(api.pairing.approve, { approvalCode: f.approvalCode });
  await f.t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "blocked" }));
  await expect(
    f.t.action(api.deviceTokens.enroll, {
      pairingId: f.pairingId,
      pollSecret: f.pollSecret,
      credential: f.credential,
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await f.t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "allowed" }));
  const token = await f.t.action(api.deviceTokens.enroll, {
    pairingId: f.pairingId,
    pollSecret: f.pollSecret,
    credential: f.credential,
  });
  const claims = JSON.parse(Buffer.from(token.token.split(".")[1] ?? "", "base64url").toString());
  expect(claims.ownerSubject).toBe(`convex-auth:${f.userId}`);
  await f.t.run((ctx) => ctx.db.patch("users", f.userId, { accessStatus: "blocked" }));
  await expect(f.t.action(api.deviceTokens.refresh, { credential: f.credential })).rejects.toThrow(
    "ACCESS_DENIED",
  );
});
