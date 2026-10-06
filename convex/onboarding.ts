import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation } from "./_generated/server";
import { fail, load, requireNode } from "./lib/access";
import { digest } from "./pairing";

async function reactivate(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  workstationId: Id<"workstations">,
) {
  const location = await ctx.db
    .query("repositoryLocations")
    .withIndex("by_repository_workstation", (q) =>
      q.eq("repositoryId", repositoryId).eq("workstationId", workstationId),
    )
    .unique();
  if (location?.status !== "removed") return;
  // "missing" until the Node registers the location again and finds it intact.
  await ctx.db.patch("repositoryLocations", location._id, {
    status: "missing",
    removedAt: undefined,
    updatedAt: Date.now(),
  });
}
export const registerRepositories = mutation({
  args: {
    workstationId: v.id("workstations"),
    repositories: v.array(v.object({ name: v.string(), remoteUrl: v.string() })),
    // The owner re-granted these repositories in setup: locations removed earlier on
    // this Mac become eligible again once the Node verifies them (#45).
    reactivate: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      repositoryId: v.id("repositories"),
      productId: v.id("products"),
      remoteUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const node = await requireNode(ctx, args.workstationId);
    if (args.repositories.length > 32) fail("INVALID_ARGUMENT");
    const result = [];
    for (const item of args.repositories) {
      if (
        !item.name.trim() ||
        item.name.length > 100 ||
        !item.remoteUrl ||
        item.remoteUrl.length > 2048
      )
        fail("INVALID_ARGUMENT");
      const previous = await ctx.db
        .query("repositories")
        .withIndex("by_owner_remote", (q) =>
          q.eq("ownerId", node.ownerId).eq("remoteUrl", item.remoteUrl),
        )
        .unique();
      if (previous && args.reactivate) await reactivate(ctx, previous._id, node._id);
      if (previous?.productId) {
        const product = await load(ctx, "products", previous.productId);
        if (product.ownerId !== node.ownerId || product.archivedAt) fail("FORBIDDEN");
        result.push({
          repositoryId: previous._id,
          productId: product._id,
          remoteUrl: item.remoteUrl,
        });
        continue;
      }
      const slug = `repo-${(await digest(item.remoteUrl)).slice(0, 32)}`;
      const product = await ctx.db
        .query("products")
        .withIndex("by_owner_slug", (q) => q.eq("ownerId", node.ownerId).eq("slug", slug))
        .unique();
      const now = Date.now();
      const productId =
        product?._id ??
        (await ctx.db.insert("products", {
          ownerId: node.ownerId,
          name: item.name,
          slug,
          createdAt: now,
          updatedAt: now,
        }));
      if (product?.archivedAt) fail("FORBIDDEN");
      const repositoryId =
        previous?._id ??
        (await ctx.db.insert("repositories", {
          ownerId: node.ownerId,
          productId,
          ...item,
          createdAt: now,
          updatedAt: now,
        }));
      if (previous) await ctx.db.patch("repositories", repositoryId, { productId, updatedAt: now });
      result.push({ repositoryId, productId, remoteUrl: item.remoteUrl });
    }
    return result;
  },
});
