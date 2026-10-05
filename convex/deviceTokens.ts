"use node";
import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

const result = v.object({
  workstationId: v.id("workstations"),
  token: v.string(),
  expiresAt: v.number(),
});
function hash(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("INVALID_CREDENTIAL");
  return createHash("sha256").update(secret).digest("hex");
}
function signer() {
  const pem = process.env.ZAMOLXIS_DEVICE_PRIVATE_KEY;
  const issuer = process.env.CONVEX_SITE_URL;
  const jwks = process.env.ZAMOLXIS_DEVICE_JWKS;
  if (!pem || !issuer || !jwks) throw new Error("DEVICE_ISSUER_NOT_CONFIGURED");
  const key = createPrivateKey(pem);
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  const keys = JSON.parse(jwks).keys as Array<{ kid: string; n: string; e: string }>;
  const published = keys.find(
    (candidate) => candidate.n === publicKey.n && candidate.e === publicKey.e,
  );
  if (!published?.kid) throw new Error("DEVICE_SIGNING_KEY_MISMATCH");
  return (identity: { subject: string; ownerSubject: string }) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: published.kid }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: identity.subject,
        ownerSubject: identity.ownerSubject,
        iss: issuer,
        aud: "zamolxis-node",
        iat: now,
        exp: now + 900,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(input).sign(key, "base64url");
    return { token: `${input}.${signature}`, expiresAt: (now + 900) * 1000 };
  };
}
export const enroll = action({
  args: { pairingId: v.id("pairingRequests"), pollSecret: v.string(), credential: v.string() },
  returns: result,
  handler: async (
    ctx,
    args,
  ): Promise<{ workstationId: Id<"workstations">; token: string; expiresAt: number }> => {
    const sign = signer();
    const identity = await ctx.runMutation(internal.pairing.activate, {
      pairingId: args.pairingId,
      pollHash: hash(args.pollSecret),
      credentialHash: hash(args.credential),
    });
    return { workstationId: identity.workstationId, ...sign(identity) };
  },
});
export const refresh = action({
  args: { credential: v.string() },
  returns: result,
  handler: async (
    ctx,
    args,
  ): Promise<{ workstationId: Id<"workstations">; token: string; expiresAt: number }> => {
    const sign = signer();
    const identity = await ctx.runMutation(internal.pairing.authenticateCredential, {
      credentialHash: hash(args.credential),
    });
    return { workstationId: identity.workstationId, ...sign(identity) };
  },
});
