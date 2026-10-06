import { type Infer, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";
import { instructionsDigest, normalizeInstructions } from "./lib/agentProfiles";
import { runtimeModel } from "./schema";

const role = v.union(
  v.literal("orchestrator"),
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
      .take(101);
    if (rows.length > 100) fail("LIMIT_EXCEEDED");
    return rows.filter((row) => row.productId === args.productId);
  },
});

type RuntimeModel = Infer<typeof runtimeModel>;
/**
 * The models the signed-in owner's paired Macs report per runtime, for Settings -> Agents.
 * Only available runtimes on non-revoked workstations count; models are deduplicated by
 * id per runtime (first seen wins, default if any Mac reports it as default) and sorted
 * default first, then by display name.
 */
export const models = query({
  args: {},
  returns: v.array(v.object({ runtime: v.string(), models: v.array(runtimeModel) })),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const workstations = await ctx.db
      .query("workstations")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(50);
    const byRuntime = new Map<string, Map<string, RuntimeModel>>();
    for (const workstation of workstations) {
      if (workstation.status === "revoked" || workstation.revokedAt !== undefined) continue;
      const installations = await ctx.db
        .query("runtimeInstallations")
        .withIndex("by_workstation", (q) => q.eq("workstationId", workstation._id))
        .take(32);
      for (const installation of installations) {
        if (installation.status !== "available" || !installation.models?.length) continue;
        const known = byRuntime.get(installation.runtime) ?? new Map<string, RuntimeModel>();
        byRuntime.set(installation.runtime, known);
        for (const model of installation.models) {
          const seen = known.get(model.id);
          if (!seen) known.set(model.id, model);
          else if (model.isDefault && !seen.isDefault)
            known.set(model.id, { ...seen, isDefault: true });
        }
      }
    }
    return [...byRuntime.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([runtime, known]) => ({
        runtime,
        models: [...known.values()].sort(
          (a, b) =>
            Number(b.isDefault === true) - Number(a.isDefault === true) ||
            a.displayName.localeCompare(b.displayName),
        ),
      }));
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
    // Omitted keeps the stored instructions; an empty string clears them.
    instructions: v.optional(v.string()),
  },
  returns: v.id("agentProfiles"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (!args.name.trim() || args.name.trim().length > 64 || !args.runtime.trim())
      fail("INVALID_ARGUMENT");
    if (
      args.maxConcurrency !== undefined &&
      (!Number.isInteger(args.maxConcurrency) ||
        args.maxConcurrency < 1 ||
        args.maxConcurrency > 32)
    )
      fail("INVALID_ARGUMENT");
    const instructions =
      args.instructions === undefined ? undefined : normalizeInstructions(args.instructions);
    const digest = instructions ? await instructionsDigest(instructions) : undefined;
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.ownerId !== owner._id || product.archivedAt) fail("PRODUCT_MISMATCH");
    }
    const peers = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner_role", (q) => q.eq("ownerId", owner._id).eq("role", args.role))
      .take(101);
    if (peers.length > 100) fail("LIMIT_EXCEEDED");
    if (
      args.enabled &&
      peers.some(
        (peer) => peer._id !== args.profileId && peer.enabled && peer.productId === args.productId,
      )
    )
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
        ...(args.instructions !== undefined ? { instructions, instructionsDigest: digest } : {}),
        revision: existing.revision + 1,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("agentProfiles", {
      ownerId: owner._id,
      ...(args.productId ? { productId: args.productId } : {}),
      name: args.name.trim(),
      role: args.role,
      runtime: args.runtime.trim(),
      ...(args.model?.trim() ? { model: args.model.trim() } : {}),
      ...(args.reasoningEffort?.trim() ? { reasoningEffort: args.reasoningEffort.trim() } : {}),
      enabled: args.enabled,
      ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
      ...(instructions && digest ? { instructions, instructionsDigest: digest } : {}),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Removes a per-product override so the product falls back to the All products profile
// (#48). Global profiles are turned off instead. Refused while unfinished runs started
// from it still count against its concurrency limit; past runs keep their snapshot.
export const removeOverride = mutation({
  args: { profileId: v.id("agentProfiles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.ownerId !== owner._id) fail("NOT_FOUND");
    if (!profile.productId) fail("INVALID_STATE", "Only a product override can be removed");
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_profile", (q) => q.eq("agentProfileId", profile._id))
      .take(1001);
    if (runs.length > 1000 || runs.some((run) => run.completedAt === undefined))
      fail("AGENT_PROFILE_IN_USE", "Runs started with this profile are still active");
    await ctx.db.delete(profile._id);
    return null;
  },
});
