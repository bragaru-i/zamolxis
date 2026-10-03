import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { bounded, fail, load, requireUser } from "./lib/access";
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
