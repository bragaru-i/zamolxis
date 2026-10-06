import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { fail, load, ownerSubject, requireAllowed, requireUser } from "./lib/access";
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function secret(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) fail("INVALID_ARGUMENT");
}
export const begin = mutation({
  args: { approvalCode: v.string(), pollSecret: v.string(), name: v.string() },
  returns: v.id("pairingRequests"),
  handler: async (ctx, args) => {
    secret(args.approvalCode);
    secret(args.pollSecret);
    if (args.approvalCode === args.pollSecret || !args.name.trim() || args.name.length > 100)
      fail("INVALID_ARGUMENT");
    const approvalHash = await digest(args.approvalCode);
    const existing = await ctx.db
      .query("pairingRequests")
      .withIndex("by_approval_hash", (q) => q.eq("approvalHash", approvalHash))
      .unique();
    if (existing) fail("PAIRING_ALREADY_EXISTS");
    return ctx.db.insert("pairingRequests", {
      approvalHash,
      pollHash: await digest(args.pollSecret),
      name: args.name,
      expiresAt: Date.now() + 5 * 60_000,
      status: "pending",
    });
  },
});
export const approve = mutation({
  args: { approvalCode: v.string() },
  returns: v.id("workstations"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    secret(args.approvalCode);
    const hash = await digest(args.approvalCode);
    const request = await ctx.db
      .query("pairingRequests")
      .withIndex("by_approval_hash", (q) => q.eq("approvalHash", hash))
      .unique();
    if (!request || request.expiresAt <= Date.now() || request.status !== "pending")
      fail("PAIRING_EXPIRED_OR_USED");
    const issuer = process.env.CONVEX_SITE_URL;
    if (!issuer || !process.env.ZAMOLXIS_DEVICE_JWKS) fail("DEVICE_ISSUER_NOT_CONFIGURED");
    const workstationId = await ctx.db.insert("workstations", {
      ownerId: owner._id,
      name: request.name,
      status: "offline",
      nodeAuthSubject: `${issuer}|node:${request._id}`,
      registeredAt: Date.now(),
    });
    await ctx.db.patch("pairingRequests", request._id, {
      status: "approved",
      workstationId,
      ownerSubject: ownerSubject(owner),
    });
    return workstationId;
  },
});
export const poll = query({
  args: { pairingId: v.id("pairingRequests"), pollSecret: v.string() },
  returns: v.object({ status: v.string(), name: v.string() }),
  handler: async (ctx, args) => {
    secret(args.pollSecret);
    const request = await load(ctx, "pairingRequests", args.pairingId);
    if (request.pollHash !== (await digest(args.pollSecret))) fail("FORBIDDEN");
    return {
      status: request.expiresAt <= Date.now() ? "expired" : request.status,
      name: request.name,
    };
  },
});
export const activate = internalMutation({
  args: { pairingId: v.id("pairingRequests"), pollHash: v.string(), credentialHash: v.string() },
  returns: v.object({
    workstationId: v.id("workstations"),
    subject: v.string(),
    ownerSubject: v.string(),
  }),
  handler: async (ctx, args) => {
    const request = await load(ctx, "pairingRequests", args.pairingId);
    if (
      request.pollHash !== args.pollHash ||
      request.expiresAt <= Date.now() ||
      !request.workstationId ||
      !request.ownerSubject ||
      request.status === "pending"
    )
      fail("FORBIDDEN");
    const device = await load(ctx, "workstations", request.workstationId);
    if (device.status === "revoked") fail("FORBIDDEN");
    requireAllowed(await load(ctx, "users", device.ownerId));
    const credential = await ctx.db
      .query("deviceCredentials")
      .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
      .unique();
    if (credential) {
      if (credential.secretHash !== args.credentialHash) fail("PAIRING_EXPIRED_OR_USED");
    } else {
      await ctx.db.insert("deviceCredentials", {
        workstationId: device._id,
        secretHash: args.credentialHash,
        createdAt: Date.now(),
      });
      await ctx.db.patch("pairingRequests", request._id, { status: "consumed" });
    }
    return {
      workstationId: device._id,
      subject: `node:${request._id}`,
      ownerSubject: request.ownerSubject,
    };
  },
});
export const authenticateCredential = internalMutation({
  args: { credentialHash: v.string() },
  returns: v.object({
    workstationId: v.id("workstations"),
    subject: v.string(),
    ownerSubject: v.string(),
  }),
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("deviceCredentials")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.credentialHash))
      .unique();
    if (!credential) fail("FORBIDDEN");
    const device = await load(ctx, "workstations", credential.workstationId);
    const owner = await load(ctx, "users", device.ownerId);
    requireAllowed(owner);
    const issuer = process.env.CONVEX_SITE_URL;
    if (
      device.status === "revoked" ||
      !issuer ||
      !device.nodeAuthSubject?.startsWith(`${issuer}|node:`)
    )
      fail("FORBIDDEN");
    return {
      workstationId: device._id,
      subject: device.nodeAuthSubject.slice(issuer.length + 1),
      ownerSubject: ownerSubject(owner),
    };
  },
});

export const preview = query({
  args: { approvalCode: v.string() },
  returns: v.union(
    v.null(),
    v.object({ name: v.string(), expiresAt: v.number(), pending: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    secret(args.approvalCode);
    const hash = await digest(args.approvalCode);
    const request = await ctx.db
      .query("pairingRequests")
      .withIndex("by_approval_hash", (q) => q.eq("approvalHash", hash))
      .unique();
    return request
      ? {
          name: request.name,
          expiresAt: request.expiresAt,
          pending: request.status === "pending" && request.expiresAt > Date.now(),
        }
      : null;
  },
});
