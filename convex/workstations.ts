import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { bounded, fail, requireUser } from "./lib/access";
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
    if (args.nodeAuthSubject === owner.authSubject)
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
