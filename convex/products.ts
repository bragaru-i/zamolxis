import { repositoryRemoteKey } from "@zamolxis/application";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, load, requireUser } from "./lib/access";
import { mergeRepository } from "./onboarding";

// Products are created by pairing (one per repository). Before #115 the same repository
// registered from two computers with differently written remotes became two Products;
// the owner can fold such a duplicate away here: its repositories merge into the ones
// another Product already has, then it is archived. History (Sessions) stays readable.

const ACTIVE_SESSION = ["planning", "running", "needs_input"];

/**
 * The repository in another live Product that `repository` duplicates, if any: the same
 * remote origin registered earlier (the oldest entry wins, as when computers register), so
 * only the newer of two Products ever counts as the duplicate.
 */
async function survivorOf(
  ctx: QueryCtx,
  owned: Doc<"repositories">[],
  repository: Doc<"repositories">,
): Promise<{ repository: Doc<"repositories">; product: Doc<"products"> } | undefined> {
  if (!repository.remoteUrl) return undefined;
  const key = repositoryRemoteKey(repository.remoteUrl);
  const candidates = owned
    .filter(
      (row) =>
        row._id !== repository._id &&
        !row.mergedIntoId &&
        row.productId !== repository.productId &&
        row.createdAt < repository.createdAt &&
        row.remoteUrl !== undefined &&
        repositoryRemoteKey(row.remoteUrl) === key,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const candidate of candidates) {
    const product = candidate.productId ? await ctx.db.get("products", candidate.productId) : null;
    if (product && !product.archivedAt) return { repository: candidate, product };
  }
  return undefined;
}

async function ownedRepositories(ctx: QueryCtx, ownerId: Id<"users">) {
  const owned = await ctx.db
    .query("repositories")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(101);
  if (owned.length > 100) fail("LIMIT_EXCEEDED");
  return owned;
}

async function activeSessions(ctx: QueryCtx, productId: Id<"products">) {
  const sessions = await ctx.db
    .query("workSessions")
    .withIndex("by_product_activity", (q) => q.eq("productId", productId))
    .order("desc")
    .take(101);
  return {
    count: sessions.length,
    active: sessions.some((session) => ACTIVE_SESSION.includes(session.status)),
  };
}

/**
 * The owner's live Products with their repositories, how many Sessions each holds and
 * whether it can be archived: only when every repository it still owns is the same
 * repository as one in another Product, so nothing becomes unreachable.
 */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("products"),
      name: v.string(),
      sessions: v.number(),
      repositories: v.array(
        v.object({
          _id: v.id("repositories"),
          name: v.string(),
          // The Product that already has this repository, when this one duplicates it.
          duplicateOf: v.optional(v.object({ productId: v.id("products"), name: v.string() })),
        }),
      ),
      canArchive: v.boolean(),
      reason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const products = (
      await ctx.db
        .query("products")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
        .take(100)
    ).filter((product) => !product.archivedAt);
    const owned = await ownedRepositories(ctx, owner._id);
    const result = [];
    for (const product of products) {
      const repositories = [];
      let unique = 0;
      for (const repository of owned) {
        if (repository.productId !== product._id || repository.mergedIntoId) continue;
        const survivor = await survivorOf(ctx, owned, repository);
        if (!survivor) unique += 1;
        repositories.push({
          _id: repository._id,
          name: repository.name,
          ...(survivor
            ? { duplicateOf: { productId: survivor.product._id, name: survivor.product.name } }
            : {}),
        });
      }
      const sessions = await activeSessions(ctx, product._id);
      const reason = sessions.active
        ? "Work is still running in this product."
        : unique > 0
          ? "A repository of this product exists in no other product."
          : undefined;
      result.push({
        _id: product._id,
        name: product.name,
        sessions: sessions.count,
        repositories,
        canArchive: reason === undefined,
        ...(reason ? { reason } : {}),
      });
    }
    const created = new Map(products.map((product) => [product._id, product.createdAt]));
    return result.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || (created.get(a._id) ?? 0) - (created.get(b._id) ?? 0),
    );
  },
});

/**
 * Archives a duplicate Product: each repository it still owns merges into the same
 * repository in another live Product (locations move, Nodes naming it land on the
 * survivor), then the Product is archived. Refused while work runs in it, while a
 * location is busy, or when a repository exists nowhere else.
 */
export const archive = mutation({
  args: { productId: v.id("products") },
  returns: v.null(),
  handler: async (ctx: MutationCtx, args) => {
    const owner = await requireUser(ctx);
    const product = await load(ctx, "products", args.productId);
    if (product.ownerId !== owner._id) fail("FORBIDDEN");
    if (product.archivedAt) return null;
    if ((await activeSessions(ctx, product._id)).active)
      fail("PRODUCT_IN_USE", "Work is still running in this product");
    const owned = await ownedRepositories(ctx, owner._id);
    for (const repository of owned) {
      if (repository.productId !== product._id || repository.mergedIntoId) continue;
      const survivor = await survivorOf(ctx, owned, repository);
      if (!survivor) fail("PRODUCT_IN_USE", `${repository.name} exists in no other product`);
      if (!(await mergeRepository(ctx, repository, survivor.repository)))
        fail("LOCATION_BUSY", `Work is still running in ${repository.name} on a computer`);
    }
    const now = Date.now();
    await ctx.db.patch("products", product._id, { archivedAt: now, updatedAt: now });
    return null;
  },
});
