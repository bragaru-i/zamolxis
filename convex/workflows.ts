import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";
import { ROLE_LABELS } from "./lib/agentProfiles";
import { offeredModels, presetProfiles, workflowPreset } from "./lib/workflowPresets";

/**
 * Workflows: named sets of agents, one per job. They belong to the owner (not to a project
 * or a computer); each computer picks the one its new work uses, and a repository on a
 * computer may have its own. A Session keeps the workflow it started with.
 */
const NAME_LIMIT = 64;
const WORKFLOWS_LIMIT = 30;
const FINISHED = ["completed", "failed", "cancelled"];

async function ownWorkflow(ctx: QueryCtx, ownerId: Id<"users">, workflowId: Id<"agentWorkflows">) {
  const workflow = await ctx.db.get(workflowId);
  if (!workflow || workflow.ownerId !== ownerId || workflow.archivedAt !== undefined)
    fail("NOT_FOUND");
  return workflow;
}
async function ownWorkflows(ctx: QueryCtx, ownerId: Id<"users">) {
  const rows = await ctx.db
    .query("agentWorkflows")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(WORKFLOWS_LIMIT * 4);
  return rows.filter((row) => row.archivedAt === undefined);
}
function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_LIMIT) fail("INVALID_ARGUMENT");
  return trimmed;
}
async function ownerProfiles(ctx: QueryCtx, ownerId: Id<"users">) {
  const rows = await ctx.db
    .query("agentProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(301);
  if (rows.length > 300) fail("LIMIT_EXCEEDED");
  return rows;
}
// A workflow's own profiles; the Default is the owner's global profiles (no product, no workflow).
function scopeOf(rows: Doc<"agentProfiles">[], workflowId: Id<"agentWorkflows"> | undefined) {
  return rows.filter((row) =>
    workflowId ? row.workflowId === workflowId : !row.workflowId && !row.productId,
  );
}
async function sessionsUsing(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  workflowId: Id<"agentWorkflows">,
) {
  const sessions = await ctx.db
    .query("workSessions")
    .withIndex("by_owner_activity", (q) => q.eq("ownerId", ownerId))
    .order("desc")
    .take(500);
  return sessions.filter((session) => session.workflowId === workflowId);
}

/** The owner's workflows, with the computers that use them. */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("agentWorkflows"),
      name: v.string(),
      roles: v.number(),
      activeSessions: v.number(),
      computers: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const workflows = await ownWorkflows(ctx, owner._id);
    const profiles = await ownerProfiles(ctx, owner._id);
    const devices = (
      await ctx.db
        .query("workstations")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
        .take(50)
    ).filter((device) => device.status !== "revoked");
    const result = [];
    for (const workflow of workflows) {
      const sessions = await sessionsUsing(ctx, owner._id, workflow._id);
      result.push({
        _id: workflow._id,
        name: workflow.name,
        roles: scopeOf(profiles, workflow._id).filter((profile) => profile.enabled).length,
        activeSessions: sessions.filter((session) => !FINISHED.includes(session.status)).length,
        computers: devices
          .filter((device) => device.defaultWorkflowId === workflow._id)
          .map((device) => device.name),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * A new workflow: empty (every job uses the Default), copied from the Default or another
 * workflow, or a recommended preset matched to the owner's computers.
 */
export const create = mutation({
  args: {
    name: v.string(),
    copyFrom: v.optional(v.object({ workflowId: v.optional(v.id("agentWorkflows")) })),
    preset: v.optional(workflowPreset),
  },
  returns: v.id("agentWorkflows"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const name = validName(args.name);
    if (args.copyFrom && args.preset) fail("INVALID_ARGUMENT");
    const existing = await ownWorkflows(ctx, owner._id);
    if (existing.length >= WORKFLOWS_LIMIT) fail("LIMIT_EXCEEDED");
    if (existing.some((row) => row.name.toLowerCase() === name.toLowerCase()))
      fail("WORKFLOW_NAME_TAKEN");
    if (args.copyFrom?.workflowId) await ownWorkflow(ctx, owner._id, args.copyFrom.workflowId);
    const now = Date.now();
    const workflowId = await ctx.db.insert("agentWorkflows", {
      ownerId: owner._id,
      name,
      createdAt: now,
      updatedAt: now,
    });
    if (args.copyFrom) {
      const source = scopeOf(await ownerProfiles(ctx, owner._id), args.copyFrom.workflowId).filter(
        (profile) => profile.enabled,
      );
      for (const profile of source) {
        const { _id, _creationTime, revision, createdAt, updatedAt, productId, ...settings } =
          profile;
        await ctx.db.insert("agentProfiles", {
          ...settings,
          workflowId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (args.preset)
      for (const profile of presetProfiles(args.preset, await offeredModels(ctx, owner._id)))
        await ctx.db.insert("agentProfiles", {
          ownerId: owner._id,
          workflowId,
          name: `${ROLE_LABELS[profile.role]} · ${name}`,
          role: profile.role,
          runtime: profile.runtime,
          ...(profile.model ? { model: profile.model } : {}),
          ...(profile.backups.length ? { backups: profile.backups } : {}),
          ...(profile.checksOnly ? { verification: "checks_only" as const } : {}),
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
    return workflowId;
  },
});

export const rename = mutation({
  args: { workflowId: v.id("agentWorkflows"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const workflow = await ownWorkflow(ctx, owner._id, args.workflowId);
    const name = validName(args.name);
    if (
      (await ownWorkflows(ctx, owner._id)).some(
        (row) => row._id !== workflow._id && row.name.toLowerCase() === name.toLowerCase(),
      )
    )
      fail("WORKFLOW_NAME_TAKEN");
    await ctx.db.patch(workflow._id, { name, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Deletes a workflow (archived, its profiles turned off). Refused while an unfinished
 * Session uses it; computers and repositories that used it go back to the Default.
 */
export const remove = mutation({
  args: { workflowId: v.id("agentWorkflows") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const workflow = await ownWorkflow(ctx, owner._id, args.workflowId);
    if (
      (await sessionsUsing(ctx, owner._id, workflow._id)).some(
        (session) => !FINISHED.includes(session.status),
      )
    )
      fail("WORKFLOW_IN_USE", "A session that is not finished uses this workflow");
    const now = Date.now();
    for (const profile of scopeOf(await ownerProfiles(ctx, owner._id), workflow._id))
      if (profile.enabled)
        await ctx.db.patch(profile._id, {
          enabled: false,
          revision: profile.revision + 1,
          updatedAt: now,
        });
    const devices = await ctx.db
      .query("workstations")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(50);
    for (const device of devices) {
      if (device.defaultWorkflowId === workflow._id)
        await ctx.db.patch(device._id, { defaultWorkflowId: undefined });
      const locations = await ctx.db
        .query("repositoryLocations")
        .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
        .take(65);
      for (const location of locations)
        if (location.defaultWorkflowId === workflow._id)
          await ctx.db.patch(location._id, { defaultWorkflowId: undefined });
    }
    await ctx.db.patch(workflow._id, { archivedAt: now, updatedAt: now });
    return null;
  },
});

async function ownComputer(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  workstationId: Id<"workstations">,
) {
  const device = await ctx.db.get(workstationId);
  if (!device || device.ownerId !== ownerId) fail("FORBIDDEN");
  return device;
}

/** The workflow new work on a computer uses (absent: the Default). */
export const setForComputer = mutation({
  args: { workstationId: v.id("workstations"), workflowId: v.optional(v.id("agentWorkflows")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const device = await ownComputer(ctx, owner._id, args.workstationId);
    if (args.workflowId) await ownWorkflow(ctx, owner._id, args.workflowId);
    await ctx.db.patch(device._id, { defaultWorkflowId: args.workflowId });
    return null;
  },
});

/**
 * A repository's own workflow on one computer, overriding the computer's (absent: follow
 * the computer).
 */
export const setForLocation = mutation({
  args: {
    repositoryLocationId: v.id("repositoryLocations"),
    workflowId: v.optional(v.id("agentWorkflows")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const location = await ctx.db.get(args.repositoryLocationId);
    if (!location) fail("NOT_FOUND");
    await ownComputer(ctx, owner._id, location.workstationId);
    if (args.workflowId) await ownWorkflow(ctx, owner._id, args.workflowId);
    await ctx.db.patch(location._id, { defaultWorkflowId: args.workflowId });
    return null;
  },
});

/**
 * Switches an open Session to another workflow (absent: the Default). Only agents started
 * from now on use it; running and finished runs keep their snapshot.
 */
export const setForSession = mutation({
  args: { workSessionId: v.id("workSessions"), workflowId: v.optional(v.id("agentWorkflows")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const session = await ctx.db.get(args.workSessionId);
    if (!session || session.ownerId !== owner._id) fail("NOT_FOUND");
    if (args.workflowId) await ownWorkflow(ctx, owner._id, args.workflowId);
    await ctx.db.patch(session._id, { workflowId: args.workflowId, updatedAt: Date.now() });
    return null;
  },
});

/**
 * The workflow a computer starts new work with: the repository's own on that computer, else
 * the computer's; archived ones are skipped.
 */
export async function computerWorkflow(
  ctx: QueryCtx,
  workstationId: Id<"workstations">,
  location?: Doc<"repositoryLocations">,
): Promise<Id<"agentWorkflows"> | undefined> {
  const device = await ctx.db.get(workstationId);
  for (const id of [location?.defaultWorkflowId, device?.defaultWorkflowId]) {
    if (!id) continue;
    const workflow = await ctx.db.get(id);
    if (workflow && workflow.archivedAt === undefined) return id;
  }
  return undefined;
}
