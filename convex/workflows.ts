import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";

const NAME_LIMIT = 64;
const WORKFLOWS_PER_PRODUCT = 20;
const FINISHED = ["completed", "failed", "cancelled"];

async function ownProduct(ctx: QueryCtx, ownerId: Id<"users">, productId: Id<"products">) {
  const product = await ctx.db.get(productId);
  if (!product || product.ownerId !== ownerId || product.archivedAt) fail("PRODUCT_MISMATCH");
  return product;
}
async function ownWorkflow(ctx: QueryCtx, ownerId: Id<"users">, workflowId: Id<"agentWorkflows">) {
  const workflow = await ctx.db.get(workflowId);
  if (!workflow || workflow.ownerId !== ownerId || workflow.archivedAt !== undefined)
    fail("NOT_FOUND");
  return workflow;
}
function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_LIMIT) fail("INVALID_ARGUMENT");
  return trimmed;
}
async function scopeProfiles(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
  workflowId: Id<"agentWorkflows"> | undefined,
): Promise<Doc<"agentProfiles">[]> {
  const rows = await ctx.db
    .query("agentProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(201);
  if (rows.length > 200) fail("LIMIT_EXCEEDED");
  return rows.filter((row) => row.productId === productId && row.workflowId === workflowId);
}
async function sessionsUsing(ctx: QueryCtx, workflow: Doc<"agentWorkflows">) {
  const sessions = await ctx.db
    .query("workSessions")
    .withIndex("by_product_activity", (q) => q.eq("productId", workflow.productId))
    .take(500);
  return sessions.filter((session) => session.workflowId === workflow._id);
}

/** A product's named workflows (its Default is implicit: the profiles without a workflow). */
export const list = query({
  args: { productId: v.id("products") },
  returns: v.array(
    v.object({
      _id: v.id("agentWorkflows"),
      name: v.string(),
      roles: v.number(),
      activeSessions: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    await ownProduct(ctx, owner._id, args.productId);
    const workflows = await ctx.db
      .query("agentWorkflows")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .take(WORKFLOWS_PER_PRODUCT + 1);
    const result = [];
    for (const workflow of workflows) {
      if (workflow.ownerId !== owner._id || workflow.archivedAt !== undefined) continue;
      const profiles = await scopeProfiles(ctx, owner._id, args.productId, workflow._id);
      const sessions = await sessionsUsing(ctx, workflow);
      result.push({
        _id: workflow._id,
        name: workflow.name,
        roles: profiles.filter((profile) => profile.enabled).length,
        activeSessions: sessions.filter((session) => !FINISHED.includes(session.status)).length,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * A new workflow for a product, empty (every role uses the product's Default) or copied
 * from another scope: global, a product's Default, or any product's named workflow.
 */
export const create = mutation({
  args: {
    productId: v.id("products"),
    name: v.string(),
    copyFrom: v.optional(
      v.object({
        productId: v.optional(v.id("products")),
        workflowId: v.optional(v.id("agentWorkflows")),
      }),
    ),
  },
  returns: v.id("agentWorkflows"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    await ownProduct(ctx, owner._id, args.productId);
    const name = validName(args.name);
    const existing = await ctx.db
      .query("agentWorkflows")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .take(WORKFLOWS_PER_PRODUCT + 1);
    const active = existing.filter((row) => row.archivedAt === undefined);
    if (active.length >= WORKFLOWS_PER_PRODUCT) fail("LIMIT_EXCEEDED");
    if (active.some((row) => row.name.toLowerCase() === name.toLowerCase()))
      fail("WORKFLOW_NAME_TAKEN");
    let source: Doc<"agentProfiles">[] = [];
    if (args.copyFrom) {
      const { productId, workflowId } = args.copyFrom;
      if (productId) await ownProduct(ctx, owner._id, productId);
      if (workflowId) {
        const from = await ownWorkflow(ctx, owner._id, workflowId);
        if (from.productId !== productId) fail("WORKFLOW_MISMATCH");
      }
      source = (await scopeProfiles(ctx, owner._id, productId, workflowId)).filter(
        (profile) => profile.enabled,
      );
    }
    const now = Date.now();
    const workflowId = await ctx.db.insert("agentWorkflows", {
      ownerId: owner._id,
      productId: args.productId,
      name,
      createdAt: now,
      updatedAt: now,
    });
    await copyProfiles(ctx, source, args.productId, workflowId, now);
    return workflowId;
  },
});

async function copyProfiles(
  ctx: MutationCtx,
  source: Doc<"agentProfiles">[],
  productId: Id<"products">,
  workflowId: Id<"agentWorkflows">,
  now: number,
) {
  for (const profile of source) {
    const { _id, _creationTime, revision, createdAt, updatedAt, ...settings } = profile;
    await ctx.db.insert("agentProfiles", {
      ...settings,
      productId,
      workflowId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export const rename = mutation({
  args: { workflowId: v.id("agentWorkflows"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const workflow = await ownWorkflow(ctx, owner._id, args.workflowId);
    const name = validName(args.name);
    const peers = await ctx.db
      .query("agentWorkflows")
      .withIndex("by_product", (q) => q.eq("productId", workflow.productId))
      .take(WORKFLOWS_PER_PRODUCT + 1);
    if (
      peers.some(
        (row) =>
          row._id !== workflow._id &&
          row.archivedAt === undefined &&
          row.name.toLowerCase() === name.toLowerCase(),
      )
    )
      fail("WORKFLOW_NAME_TAKEN");
    await ctx.db.patch(workflow._id, { name, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Deletes a workflow (kept as history: archived, its profiles turned off). Refused while an
 * unfinished Session uses it; finished Sessions and past runs keep their snapshots.
 */
export const remove = mutation({
  args: { workflowId: v.id("agentWorkflows") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const workflow = await ownWorkflow(ctx, owner._id, args.workflowId);
    const sessions = await sessionsUsing(ctx, workflow);
    if (sessions.some((session) => !FINISHED.includes(session.status)))
      fail("WORKFLOW_IN_USE", "A session that is not finished uses this workflow");
    const now = Date.now();
    for (const profile of await scopeProfiles(ctx, owner._id, workflow.productId, workflow._id))
      if (profile.enabled)
        await ctx.db.patch(profile._id, {
          enabled: false,
          revision: profile.revision + 1,
          updatedAt: now,
        });
    await ctx.db.patch(workflow._id, { archivedAt: now, updatedAt: now });
    return null;
  },
});

/** Every workflow of the owner across products, for "Start from" when creating one. */
export const listAll = query({
  args: {},
  returns: v.array(
    v.object({ _id: v.id("agentWorkflows"), productId: v.id("products"), name: v.string() }),
  ),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const products = await ctx.db
      .query("products")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(100);
    const result = [];
    for (const product of products) {
      if (product.archivedAt) continue;
      const workflows = await ctx.db
        .query("agentWorkflows")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .take(WORKFLOWS_PER_PRODUCT + 1);
      for (const workflow of workflows)
        if (workflow.ownerId === owner._id && workflow.archivedAt === undefined)
          result.push({ _id: workflow._id, productId: product._id, name: workflow.name });
    }
    return result;
  },
});
