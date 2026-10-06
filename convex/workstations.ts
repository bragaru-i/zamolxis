import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { bounded, fail, ownerSubject, requireNode, requireUser } from "./lib/access";
export const listMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const devices = await ctx.db
      .query("workstations")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(bounded(args.limit ?? 50));
    return Promise.all(
      devices.map(async ({ nodeAuthSubject: _, ...device }) => {
        const runtimes = await ctx.db
          .query("runtimeInstallations")
          .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
          .take(33);
        if (runtimes.length > 32) fail("LIMIT_EXCEEDED");
        return {
          ...device,
          runtimes: runtimes.map(({ runtime, status }) => ({ runtime, status })),
        };
      }),
    );
  },
});
export const register = mutation({
  args: { name: v.string(), nodeAuthSubject: v.string() },
  returns: v.id("workstations"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (args.nodeAuthSubject === ownerSubject(owner))
      fail("INVALID_ARGUMENT", "Device identity must differ from user identity");
    const existing = await ctx.db
      .query("workstations")
      .withIndex("by_node_subject", (q) => q.eq("nodeAuthSubject", args.nodeAuthSubject))
      .unique();
    if (existing) {
      if (existing.ownerId !== owner._id) fail("FORBIDDEN");
      return existing._id;
    }
    return ctx.db.insert("workstations", {
      ownerId: owner._id,
      name: args.name,
      nodeAuthSubject: args.nodeAuthSubject,
      status: "offline",
      registeredAt: Date.now(),
    });
  },
});
export const revoke = mutation({
  args: { workstationId: v.id("workstations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const device = await ctx.db.get("workstations", args.workstationId);
    if (!device || device.ownerId !== owner._id) fail("FORBIDDEN");
    await ctx.db.patch("workstations", device._id, { status: "revoked", revokedAt: Date.now() });
    return null;
  },
});

// A Mac's display name: trimmed, 1..64 characters, no control characters.
export function workstationName(value: string) {
  const name = value.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters.
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name))
    fail("INVALID_ARGUMENT", "Use a name of 1 to 64 characters");
  return name;
}

// Owner renames one of their Macs from Settings.
export const rename = mutation({
  args: { workstationId: v.id("workstations"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const device = await ctx.db.get("workstations", args.workstationId);
    if (!device || device.ownerId !== owner._id) fail("FORBIDDEN");
    if (device.status === "revoked") fail("INVALID_STATE", "This Mac was removed");
    await ctx.db.patch("workstations", device._id, { name: workstationName(args.name) });
    return null;
  },
});

// The Node renames its own workstation (`pnpm zamolxis setup` → Rename this Mac).
export const renameSelf = mutation({
  args: { workstationId: v.id("workstations"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    await ctx.db.patch("workstations", device._id, { name: workstationName(args.name) });
    return null;
  },
});

// After a Mac pairs again from the same local config, setup proves the previous entry
// with its still-valid credential and retires it in favour of the new one. The token of
// the previous entry is required, so nobody can revoke a Mac they cannot authenticate as.
export const retireReplaced = mutation({
  args: { workstationId: v.id("workstations"), replacementId: v.id("workstations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const previous = await requireNode(ctx, args.workstationId);
    const replacement = await ctx.db.get("workstations", args.replacementId);
    if (
      !replacement ||
      replacement._id === previous._id ||
      replacement.ownerId !== previous.ownerId ||
      replacement.status === "revoked"
    )
      fail("FORBIDDEN");
    await ctx.db.patch("workstations", previous._id, {
      status: "revoked",
      revokedAt: Date.now(),
      replacedBy: replacement._id,
    });
    return null;
  },
});
