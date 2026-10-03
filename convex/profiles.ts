import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { fail } from "./lib/access";
export const ensure = mutation({
  args: { displayName: v.optional(v.string()) },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail("FORBIDDEN");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_auth_subject", (q) => q.eq("authSubject", identity.tokenIdentifier))
      .unique();
    if (existing) return existing._id;
    return ctx.db.insert("users", {
      authSubject: identity.tokenIdentifier,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      createdAt: Date.now(),
    });
  },
});
