import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";

const role = v.union(
  v.literal("supervisor"),
  v.literal("builder"),
  v.literal("verifier"),
  v.literal("repair"),
  v.literal("integration"),
);

export const list = query({
  args: { productId: v.optional(v.id("products")) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const rows = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(100);
    return rows.filter((row) => row.productId === args.productId);
  },
});

export const upsert = mutation({
  args: {
    profileId: v.optional(v.id("agentProfiles")),
    productId: v.optional(v.id("products")),
    name: v.string(),
    role,
    runtime: v.string(),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    enabled: v.boolean(),
    maxConcurrency: v.optional(v.number()),
  },
  returns: v.id("agentProfiles"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (!args.name.trim() || !args.runtime.trim()) fail("INVALID_ARGUMENT");
    if (args.maxConcurrency !== undefined && (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1 || args.maxConcurrency > 32))
      fail("INVALID_ARGUMENT");
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.ownerId !== owner._id || product.archivedAt) fail("PRODUCT_MISMATCH");
    }
    const peers = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner_role", (q) => q.eq("ownerId", owner._id).eq("role", args.role))
      .take(100);
    if (args.enabled && peers.some((peer) => peer._id !== args.profileId && peer.enabled && peer.productId === args.productId))
      fail("AGENT_PROFILE_CONFLICT");
    const now = Date.now();
    if (args.profileId) {
      const existing = await ctx.db.get(args.profileId);
      if (!existing || existing.ownerId !== owner._id) fail("NOT_FOUND");
      await ctx.db.patch(existing._id, {
        productId: args.productId,
        name: args.name.trim(),
        role: args.role,
        runtime: args.runtime.trim(),
        model: args.model?.trim() || undefined,
        reasoningEffort: args.reasoningEffort?.trim() || undefined,
        enabled: args.enabled,
        maxConcurrency: args.maxConcurrency,
        revision: existing.revision + 1,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("agentProfiles", {
      ownerId: owner._id,
      productId: args.productId,
      name: args.name.trim(),
      role: args.role,
      runtime: args.runtime.trim(),
      model: args.model?.trim() || undefined,
      reasoningEffort: args.reasoningEffort?.trim() || undefined,
      enabled: args.enabled,
      maxConcurrency: args.maxConcurrency,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});
