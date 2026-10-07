import { type Infer, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";
import { agentBackup, MAX_BACKUPS } from "./lib/agentBackup";
import {
  AGENT_ROLES,
  instructionsDigest,
  normalizeInstructions,
  ROLE_LABELS,
  defaultRuntime as resolveDefaultRuntime,
  runtimeAllowedFor,
  TEXT_ONLY_RUNTIMES,
} from "./lib/agentProfiles";
import { approvalPolicy } from "./lib/approvalPolicy";
import { verification } from "./lib/verification";
import { runtimeModel } from "./schema";

const role = v.union(
  v.literal("orchestrator"),
  v.literal("supervisor"),
  v.literal("builder"),
  v.literal("verifier"),
  v.literal("repair"),
  v.literal("integration"),
);

/** A workflow the owner may edit: it belongs to `productId` and is not archived. */
async function ownWorkflow(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
  workflowId: Id<"agentWorkflows"> | undefined,
) {
  if (!workflowId) return undefined;
  const workflow = await ctx.db.get(workflowId);
  if (
    !workflow ||
    workflow.ownerId !== ownerId ||
    workflow.productId !== productId ||
    workflow.archivedAt !== undefined
  )
    fail("WORKFLOW_MISMATCH");
  return workflow;
}

// One scope: global (no product), a product's Default (no workflow) or a named workflow.
export const list = query({
  args: {
    productId: v.optional(v.id("products")),
    workflowId: v.optional(v.id("agentWorkflows")),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const rows = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(201);
    if (rows.length > 200) fail("LIMIT_EXCEEDED");
    return rows.filter(
      (row) => row.productId === args.productId && row.workflowId === args.workflowId,
    );
  },
});

type RuntimeModel = Infer<typeof runtimeModel>;
/**
 * The models the signed-in owner's paired computers report per runtime, for Settings -> Agents.
 * Only available runtimes on non-revoked workstations count; models are deduplicated by
 * id per runtime (first seen wins, default if any computer reports it as default) and sorted
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

/** The runtime every role without an enabled profile uses right now (Settings → Agents). */
export const defaultRuntime = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    return resolveDefaultRuntime(ctx, owner._id);
  },
});

/**
 * One agent for every role in a scope (#7): each role's enabled profile gets the runtime
 * (a changed runtime resets its model and effort, which belong to the old one), its latest
 * disabled profile is turned on with it, and a role without one gets a profile. Names,
 * instructions and limits stay. Running and past runs keep their snapshot.
 */
export const setRuntimeForAllRoles = mutation({
  args: {
    productId: v.optional(v.id("products")),
    workflowId: v.optional(v.id("agentWorkflows")),
    runtime: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const runtime = args.runtime.trim();
    if (!runtime || runtime.length > 64) fail("INVALID_ARGUMENT");
    // A text-only runtime can only be the Orchestrator's: never set it for every role.
    if (TEXT_ONLY_RUNTIMES.includes(runtime)) fail("INVALID_ARGUMENT");
    let scopeName = "All products";
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.ownerId !== owner._id || product.archivedAt) fail("PRODUCT_MISMATCH");
      scopeName = product.name;
    }
    const workflow = await ownWorkflow(ctx, owner._id, args.productId, args.workflowId);
    if (workflow) scopeName = `${scopeName} · ${workflow.name}`;
    const rows = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(201);
    if (rows.length > 200) fail("LIMIT_EXCEEDED");
    const now = Date.now();
    let count = rows.length;
    for (const role of AGENT_ROLES) {
      const own = rows.filter(
        (row) =>
          row.role === role &&
          row.productId === args.productId &&
          row.workflowId === args.workflowId,
      );
      const target =
        own.find((row) => row.enabled) ?? [...own].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (target) {
        if (target.enabled && target.runtime === runtime) continue;
        await ctx.db.patch(target._id, {
          runtime,
          enabled: true,
          ...(target.runtime === runtime ? {} : { model: undefined, reasoningEffort: undefined }),
          revision: target.revision + 1,
          updatedAt: now,
        });
        continue;
      }
      if (++count > 200) fail("LIMIT_EXCEEDED");
      await ctx.db.insert("agentProfiles", {
        ownerId: owner._id,
        ...(args.productId ? { productId: args.productId } : {}),
        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
        name: `${ROLE_LABELS[role]} · ${scopeName}`,
        role,
        runtime,
        enabled: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    return null;
  },
});

export const upsert = mutation({
  args: {
    profileId: v.optional(v.id("agentProfiles")),
    productId: v.optional(v.id("products")),
    // A named workflow of `productId`; absent: the product's Default (or global).
    workflowId: v.optional(v.id("agentWorkflows")),
    name: v.string(),
    role,
    runtime: v.string(),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    enabled: v.boolean(),
    maxConcurrency: v.optional(v.number()),
    // Omitted keeps the stored instructions; an empty string clears them.
    instructions: v.optional(v.string()),
    // Omitted or "ask" means every command approval waits for the owner.
    approvalPolicy: v.optional(approvalPolicy),
    // Verifier only. Omitted or "review" runs a reviewer model; "checks_only" does not.
    verification: v.optional(verification),
    // Omitted keeps the stored backups; an empty list clears them.
    backups: v.optional(v.array(agentBackup)),
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
    // Only roles that run commands can be granted approvals; "ask" is stored as nothing.
    const policy =
      args.approvalPolicy && args.approvalPolicy !== "ask" ? args.approvalPolicy : undefined;
    if (policy && !["builder", "repair"].includes(args.role)) fail("INVALID_ARGUMENT");
    const mode =
      args.verification && args.verification !== "review" ? args.verification : undefined;
    if (mode && args.role !== "verifier") fail("INVALID_ARGUMENT");
    if (!runtimeAllowedFor(args.role, args.runtime.trim())) fail("INVALID_ARGUMENT");
    const backups = args.backups?.map((backup) => ({
      runtime: backup.runtime.trim(),
      ...(backup.model?.trim() ? { model: backup.model.trim() } : {}),
      ...(backup.reasoningEffort?.trim() ? { reasoningEffort: backup.reasoningEffort.trim() } : {}),
    }));
    if (
      backups &&
      (backups.length > MAX_BACKUPS ||
        backups.some(
          (backup) =>
            !backup.runtime ||
            backup.runtime.length > 64 ||
            (backup.model?.length ?? 0) > 256 ||
            (backup.reasoningEffort?.length ?? 0) > 32 ||
            !runtimeAllowedFor(args.role, backup.runtime),
        ))
    )
      fail("INVALID_ARGUMENT");
    const digest = instructions ? await instructionsDigest(instructions) : undefined;
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.ownerId !== owner._id || product.archivedAt) fail("PRODUCT_MISMATCH");
    }
    await ownWorkflow(ctx, owner._id, args.productId, args.workflowId);
    const peers = await ctx.db
      .query("agentProfiles")
      .withIndex("by_owner_role", (q) => q.eq("ownerId", owner._id).eq("role", args.role))
      .take(101);
    if (peers.length > 100) fail("LIMIT_EXCEEDED");
    if (
      args.enabled &&
      peers.some(
        (peer) =>
          peer._id !== args.profileId &&
          peer.enabled &&
          peer.productId === args.productId &&
          peer.workflowId === args.workflowId,
      )
    )
      fail("AGENT_PROFILE_CONFLICT");
    const now = Date.now();
    if (args.profileId) {
      const existing = await ctx.db.get(args.profileId);
      if (!existing || existing.ownerId !== owner._id) fail("NOT_FOUND");
      await ctx.db.patch(existing._id, {
        productId: args.productId,
        workflowId: args.workflowId,
        name: args.name.trim(),
        role: args.role,
        runtime: args.runtime.trim(),
        model: args.model?.trim() || undefined,
        reasoningEffort: args.reasoningEffort?.trim() || undefined,
        enabled: args.enabled,
        maxConcurrency: args.maxConcurrency,
        ...(args.instructions !== undefined ? { instructions, instructionsDigest: digest } : {}),
        approvalPolicy: policy,
        verification: mode,
        ...(backups ? { backups: backups.length ? backups : undefined } : {}),
        revision: existing.revision + 1,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("agentProfiles", {
      ownerId: owner._id,
      ...(args.productId ? { productId: args.productId } : {}),
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      name: args.name.trim(),
      role: args.role,
      runtime: args.runtime.trim(),
      ...(args.model?.trim() ? { model: args.model.trim() } : {}),
      ...(args.reasoningEffort?.trim() ? { reasoningEffort: args.reasoningEffort.trim() } : {}),
      enabled: args.enabled,
      ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
      ...(instructions && digest ? { instructions, instructionsDigest: digest } : {}),
      ...(policy ? { approvalPolicy: policy } : {}),
      ...(mode ? { verification: mode } : {}),
      ...(backups?.length ? { backups } : {}),
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
