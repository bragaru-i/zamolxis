import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authenticatedUser, requireUser } from "./lib/access";

// This is the only human query available to a signed-in, unapproved account.
// It exposes only the caller's own identity/access state, never product data.
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
      accessStatus: v.union(v.literal("pending"), v.literal("allowed"), v.literal("blocked")),
    }),
  ),
  handler: async (ctx) => {
    const user = await authenticatedUser(ctx);
    return user
      ? {
          userId: user._id,
          email: user.email ?? null,
          accessStatus: user.accessStatus ?? "pending",
        }
      : null;
  },
});
export const ensure = mutation({
  args: { displayName: v.optional(v.string()) },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.displayName)
      await ctx.db.patch("users", user._id, { displayName: args.displayName.slice(0, 100) });
    return user._id;
  },
});
