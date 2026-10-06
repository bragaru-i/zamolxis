import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { bounded, fail, load, requireNode, requireUser } from "./lib/access";
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
    return ctx.db
      .query("repositories")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .take(bounded(args.limit ?? 50));
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

async function locationBusy(ctx: MutationCtx, location: Doc<"repositoryLocations">) {
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
    fail("LOCATION_BUSY", "Work is still running in this repository on this Mac");
  const now = Date.now();
  await ctx.db.patch("repositoryLocations", location._id, {
    status: "removed",
    removedAt: now,
    updatedAt: now,
  });
}

// Repositories one of the owner's Macs may work on, for Settings.
export const listLocations = query({
  args: { workstationId: v.id("workstations") },
  returns: v.array(
    v.object({
      repositoryLocationId: v.id("repositoryLocations"),
      repositoryName: v.string(),
      canonicalPath: v.string(),
      status: v.string(),
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
          return {
            repositoryLocationId: location._id,
            repositoryName: repository?.name ?? "Repository",
            canonicalPath: location.canonicalPath,
            status: location.status,
          };
        }),
    );
  },
});

// The owner removes a repository from one Mac in Settings.
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
// Idempotent: a repository this Mac never registered, or already removed, is "absent".
export const removeOwnLocation = mutation({
  args: { workstationId: v.id("workstations"), repositoryId: v.id("repositories") },
  returns: v.union(v.literal("removed"), v.literal("absent")),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    const repository = await ctx.db.get("repositories", args.repositoryId);
    if (!repository || repository.ownerId !== device.ownerId) fail("FORBIDDEN");
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
