import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { fail } from "./lib/access";

/**
 * After moving the backend to a new address (for example from the Convex cloud to the
 * self-hosted server on 2026-10-19), each computer's identity still names the old
 * address, so its credential is refused. This re-homes the identities that name `from`
 * onto this deployment's own address; credentials and pairings stay as they are.
 * Run once by an operator: `npx convex run migrations:moveNodeIssuer '{"from":"<old site URL>"}'`.
 */
export const moveNodeIssuer = internalMutation({
  args: { from: v.string() },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, args) => {
    const to = process.env.CONVEX_SITE_URL;
    if (!to || !/^https:\/\/[^\s|]+$/.test(args.from) || args.from === to) fail("INVALID_ARGUMENT");
    const prefix = `${args.from}|node:`;
    let moved = 0;
    for (const device of await ctx.db.query("workstations").take(500)) {
      if (!device.nodeAuthSubject?.startsWith(prefix)) continue;
      await ctx.db.patch(device._id, {
        nodeAuthSubject: `${to}|node:${device.nodeAuthSubject.slice(prefix.length)}`,
      });
      moved++;
    }
    return { moved };
  },
});
