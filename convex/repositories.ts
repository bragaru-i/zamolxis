import { githubRepositoryFromRemote, githubSlug, githubTokenUrl } from "@zamolxis/application";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { bounded, fail, load, requireNode, requireUser } from "./lib/access";
import { deviceOnline } from "./lib/devices";
import { canonicalRepository } from "./lib/repositories";
import { githubAccess } from "./schema";
import { computerWorkflow } from "./workflows";
export const create = mutation({
  args: {
    name: v.string(),
    remoteUrl: v.optional(v.string()),
    productId: v.optional(v.id("products")),
  },
  returns: v.id("repositories"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (args.productId) {
      const product = await load(ctx, "products", args.productId);
      if (product.ownerId !== owner._id) fail("FORBIDDEN");
    }
    const now = Date.now();
    return ctx.db.insert("repositories", {
      ...args,
      ownerId: owner._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});
export const listByProduct = query({
  args: { productId: v.id("products"), limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const product = await load(ctx, "products", args.productId);
    if (product.ownerId !== owner._id) fail("FORBIDDEN");
    const rows = await ctx.db
      .query("repositories")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .take(bounded(args.limit ?? 50));
    return rows.filter((row) => !row.mergedIntoId);
  },
});

// Runs that have not finished (including lost or uncertain ones) still own their
// workspace; workspaces being prepared or integrated are in use as well.
const ACTIVE_RUNS = [
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
  "lost",
] as const;
const ACTIVE_WORKSPACES = ["requested", "provisioning", "in_use", "integrating"] as const;

export async function locationBusy(ctx: MutationCtx, location: Doc<"repositoryLocations">) {
  for (const status of ACTIVE_WORKSPACES) {
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_workstation_status", (q) =>
        q.eq("workstationId", location.workstationId).eq("status", status),
      )
      .take(201);
    if (workspaces.length > 200) return true;
    if (workspaces.some((workspace) => workspace.repositoryLocationId === location._id))
      return true;
  }
  for (const status of ACTIVE_RUNS) {
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_workstation_status", (q) =>
        q.eq("workstationId", location.workstationId).eq("status", status),
      )
      .take(201);
    if (runs.length > 200) return true;
    for (const run of runs) {
      if (run.completedAt !== undefined) continue;
      const workspace = await ctx.db.get("workspaces", run.workspaceId);
      if (!workspace || workspace.repositoryLocationId === location._id) return true;
    }
  }
  return false;
}

// Marks a location removed so no new work is dispatched there (#45). Refused while
// work is active on it. The repository, its Product and history stay as they are.
async function removeLocation(ctx: MutationCtx, location: Doc<"repositoryLocations">) {
  if (location.status === "removed") return;
  if (await locationBusy(ctx, location))
    fail("LOCATION_BUSY", "Work is still running in this repository on this computer");
  const now = Date.now();
  await ctx.db.patch("repositoryLocations", location._id, {
    status: "removed",
    removedAt: now,
    updatedAt: now,
  });
}

// Repositories one of the owner's computers may work on, for Settings.
export const listLocations = query({
  args: { workstationId: v.id("workstations") },
  returns: v.array(
    v.object({
      repositoryLocationId: v.id("repositoryLocations"),
      repositoryName: v.string(),
      canonicalPath: v.string(),
      status: v.string(),
      // Present for GitHub repositories: where the owner creates its publishing token.
      github: v.optional(v.object({ slug: v.string(), tokenUrl: v.string() })),
      githubAccess: v.optional(githubAccess),
      // The repository's product and the workflow new Sessions here start with.
      productId: v.optional(v.id("products")),
      defaultWorkflowId: v.optional(v.id("agentWorkflows")),
    }),
  ),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const device = await ctx.db.get("workstations", args.workstationId);
    if (!device || device.ownerId !== owner._id) fail("FORBIDDEN");
    const locations = await ctx.db
      .query("repositoryLocations")
      .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
      .take(65);
    if (locations.length > 64) fail("LIMIT_EXCEEDED");
    return Promise.all(
      locations
        .filter((location) => location.status !== "removed")
        .map(async (location) => {
          const repository = await ctx.db.get("repositories", location.repositoryId);
          const github = githubRepositoryFromRemote(repository?.remoteUrl);
          return {
            repositoryLocationId: location._id,
            repositoryName: repository?.name ?? "Repository",
            canonicalPath: location.canonicalPath,
            status: location.status,
            ...(repository?.productId ? { productId: repository.productId } : {}),
            ...(location.defaultWorkflowId
              ? { defaultWorkflowId: location.defaultWorkflowId }
              : {}),
            ...(github
              ? { github: { slug: githubSlug(github), tokenUrl: githubTokenUrl(github) } }
              : {}),
            ...(location.githubAccess ? { githubAccess: location.githubAccess } : {}),
          };
        }),
    );
  },
});

// The owner's computers that have this repository, for the "Run on" choice when a Session
// starts: a computer is offered when its copy of the repository is usable, with whether its
// Node is online now and which runtimes it has.
export const computers = query({
  args: { repositoryId: v.id("repositories") },
  returns: v.array(
    v.object({
      workstationId: v.id("workstations"),
      name: v.string(),
      platform: v.optional(v.string()),
      online: v.boolean(),
      runtimes: v.array(v.string()),
      // The workflow new Sessions of this repository start with on this computer: the
      // repository's own there, else the computer's.
      defaultWorkflowId: v.optional(v.id("agentWorkflows")),
    }),
  ),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const repository = await canonicalRepository(ctx, args.repositoryId);
    if (repository.ownerId !== owner._id) fail("FORBIDDEN");
    const locations = await ctx.db
      .query("repositoryLocations")
      .withIndex("by_repository", (q) => q.eq("repositoryId", repository._id))
      .take(33);
    if (locations.length > 32) fail("LIMIT_EXCEEDED");
    const now = Date.now();
    const result = [];
    for (const location of locations) {
      if (location.status !== "available") continue;
      const device = await ctx.db.get("workstations", location.workstationId);
      if (!device || device.ownerId !== owner._id || device.status === "revoked") continue;
      const runtimes = await ctx.db
        .query("runtimeInstallations")
        .withIndex("by_workstation", (q) => q.eq("workstationId", device._id))
        .take(33);
      const workflowId = await computerWorkflow(ctx, device._id, location);
      result.push({
        workstationId: device._id,
        name: device.name,
        ...(device.platform ? { platform: device.platform } : {}),
        online: deviceOnline(device, now),
        runtimes: runtimes
          .filter((runtime) => runtime.status === "available")
          .map((runtime) => runtime.runtime)
          .sort(),
        ...(workflowId ? { defaultWorkflowId: workflowId } : {}),
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

// The owner removes a repository from one computer in Settings.
export const removeLocationForOwner = mutation({
  args: { repositoryLocationId: v.id("repositoryLocations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const location = await ctx.db.get("repositoryLocations", args.repositoryLocationId);
    const device = location && (await ctx.db.get("workstations", location.workstationId));
    if (!location || !device || device.ownerId !== owner._id) fail("FORBIDDEN");
    await removeLocation(ctx, location);
    return null;
  },
});

// The Node removes its own location (`pnpm zamolxis setup`, Add or remove repositories).
// Idempotent: a repository this computer never registered, or already removed, is "absent".
export const removeOwnLocation = mutation({
  args: { workstationId: v.id("workstations"), repositoryId: v.id("repositories") },
  returns: v.union(v.literal("removed"), v.literal("absent")),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    const repository = await canonicalRepository(ctx, args.repositoryId);
    if (repository.ownerId !== device.ownerId) fail("FORBIDDEN");
    const location = await ctx.db
      .query("repositoryLocations")
      .withIndex("by_repository_workstation", (q) =>
        q.eq("repositoryId", repository._id).eq("workstationId", device._id),
      )
      .unique();
    if (!location || location.status === "removed") return "absent" as const;
    await removeLocation(ctx, location);
    return "removed" as const;
  },
});
