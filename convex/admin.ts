import { getAuthSessionId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { fail, requireUser } from "./lib/access";

// In-app access administration (#47). Every function derives the caller from the
// signed Convex Auth session; nothing here trusts a submitted email or role.
const accessStatus = v.union(v.literal("pending"), v.literal("allowed"), v.literal("blocked"));
const MAX_USERS = 500;

function isEffectiveAdmin(user: Doc<"users">) {
  return user.role === "admin" && user.accessStatus === "allowed";
}

async function requireAdmin(ctx: QueryCtx) {
  const user = await requireUser(ctx);
  if (user.role !== "admin") fail("FORBIDDEN", "Only an administrator can manage people");
  return user;
}

async function effectiveAdmins(ctx: QueryCtx) {
  const admins = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "admin"))
    .take(MAX_USERS);
  return admins.filter(isEffectiveAdmin);
}

// Mirrors @convex-dev/auth deleteSession: the session plus all its refresh tokens.
// The access JWT stops working immediately because authenticatedUser requires a
// live authSessions row.
async function deleteAuthSession(ctx: MutationCtx, sessionId: Id<"authSessions">) {
  const tokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const token of tokens) await ctx.db.delete("authRefreshTokens", token._id);
  const label = await ctx.db
    .query("signInLabels")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (label) await ctx.db.delete("signInLabels", label._id);
  await ctx.db.delete("authSessions", sessionId);
}

async function deleteAuthSessions(
  ctx: MutationCtx,
  userId: Id<"users">,
  except?: Id<"authSessions">,
) {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  let deleted = 0;
  for (const session of sessions) {
    if (session._id === except) continue;
    await deleteAuthSession(ctx, session._id);
    deleted += 1;
  }
  return deleted;
}

async function currentSessionId(ctx: QueryCtx) {
  const raw = await getAuthSessionId(ctx);
  const sessionId = raw && ctx.db.normalizeId("authSessions", raw);
  if (!sessionId) fail("FORBIDDEN");
  return sessionId;
}

// Whether the signed-in, approved user may see the People section.
export const viewerRole = query({
  args: {},
  returns: v.object({ isAdmin: v.boolean() }),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return { isAdmin: user.role === "admin" };
  },
});

export const listUsers = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
      name: v.union(v.string(), v.null()),
      accessStatus,
      isAdmin: v.boolean(),
      isSelf: v.boolean(),
      createdAt: v.number(),
      lastSignInAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const admin = await requireAdmin(ctx);
    const users = await ctx.db.query("users").order("desc").take(MAX_USERS);
    const rows = await Promise.all(
      users.map(async (user) => {
        // Sessions are created at sign-in; the newest one is the last sign-in.
        const latest = await ctx.db
          .query("authSessions")
          .withIndex("userId", (q) => q.eq("userId", user._id))
          .order("desc")
          .first();
        return {
          userId: user._id,
          email: user.email ?? null,
          name: user.name ?? user.displayName ?? null,
          accessStatus: user.accessStatus ?? "pending",
          isAdmin: user.role === "admin",
          isSelf: user._id === admin._id,
          createdAt: user.createdAt ?? user._creationTime,
          lastSignInAt: latest?._creationTime ?? null,
        };
      }),
    );
    const rank = { pending: 0, allowed: 1, blocked: 2 } as const;
    return rows.sort(
      (a, b) => rank[a.accessStatus] - rank[b.accessStatus] || b.createdAt - a.createdAt,
    );
  },
});

// Approve, block or reset another user. Idempotent: repeating a request changes
// nothing (blocking again only re-sweeps sessions). Never touches their data.
export const setAccess = mutation({
  args: { userId: v.id("users"), accessStatus },
  returns: v.object({ changed: v.boolean(), revokedSessions: v.number() }),
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (args.userId === admin._id) fail("INVALID_STATE", "You can't change your own access");
    const target = await ctx.db.get("users", args.userId);
    if (!target) fail("NOT_FOUND");
    const current = target.accessStatus ?? "pending";
    let changed = false;
    if (current !== args.accessStatus) {
      // A pending or blocked user can never hold the admin role.
      const demote = args.accessStatus !== "allowed" && target.role === "admin";
      if (demote) {
        const others = (await effectiveAdmins(ctx)).filter((user) => user._id !== target._id);
        if (!others.length) fail("LAST_ADMIN", "At least one administrator must keep access");
      }
      await ctx.db.patch(
        "users",
        target._id,
        demote
          ? { accessStatus: args.accessStatus, role: undefined }
          : { accessStatus: args.accessStatus },
      );
      changed = true;
    }
    const revokedSessions =
      args.accessStatus === "blocked" ? await deleteAuthSessions(ctx, target._id) : 0;
    return { changed, revokedSessions };
  },
});

// Grant or remove the admin role of another approved user.
export const setAdmin = mutation({
  args: { userId: v.id("users"), admin: v.boolean() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    if (args.userId === admin._id) fail("INVALID_STATE", "You can't change your own role");
    const target = await ctx.db.get("users", args.userId);
    if (!target) fail("NOT_FOUND");
    if ((target.role === "admin") === args.admin) return { changed: false };
    if (args.admin) {
      if (target.accessStatus !== "allowed")
        fail("INVALID_STATE", "Approve this person before making them an administrator");
      await ctx.db.patch("users", target._id, { role: "admin" });
    } else {
      const others = (await effectiveAdmins(ctx)).filter((user) => user._id !== target._id);
      if (!others.length) fail("LAST_ADMIN", "At least one administrator must keep access");
      await ctx.db.patch("users", target._id, { role: undefined });
    }
    return { changed: true };
  },
});

// One-time operator bootstrap, callable only with deployment credentials
// (`npx convex run admin:bootstrapAdmin` or the Dashboard), never from a client.
// No-op when an approved admin exists. Otherwise promotes the single approved
// user (or the approved user with the given email). Pending/blocked users are
// never eligible and ambiguity is refused rather than guessed.
export const bootstrapAdmin = internalMutation({
  args: { email: v.optional(v.string()) },
  returns: v.object({
    status: v.union(v.literal("exists"), v.literal("promoted")),
    userId: v.id("users"),
    email: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const existing = (await effectiveAdmins(ctx))[0];
    if (existing)
      return { status: "exists" as const, userId: existing._id, email: existing.email ?? null };
    const email = args.email?.trim().toLowerCase();
    const allowed = (await ctx.db.query("users").take(MAX_USERS * 10)).filter(
      (user) =>
        user.accessStatus === "allowed" &&
        (email === undefined || user.email?.trim().toLowerCase() === email),
    );
    if (allowed.length !== 1)
      fail(
        "BOOTSTRAP_AMBIGUOUS",
        allowed.length
          ? `${allowed.length} approved users match; pass the intended admin's email`
          : "No approved user matches; approve the account first",
      );
    const user = allowed[0] as Doc<"users">;
    await ctx.db.patch("users", user._id, { role: "admin" });
    return { status: "promoted" as const, userId: user._id, email: user.email ?? null };
  },
});

// Browser sign-ins of the current user (Convex Auth sessions). Owner-only.
export const mySignIns = query({
  args: {},
  returns: v.array(
    v.object({
      sessionId: v.id("authSessions"),
      createdAt: v.number(),
      expiresAt: v.number(),
      lastActiveAt: v.number(),
      current: v.boolean(),
      label: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const current = await currentSessionId(ctx);
    const now = Date.now();
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(100);
    const rows = await Promise.all(
      sessions
        .filter((session) => session.expirationTime > now)
        .map(async (session) => {
          // A refresh token is issued at sign-in and on each refresh.
          const latest = await ctx.db
            .query("authRefreshTokens")
            .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
            .order("desc")
            .first();
          const label = await ctx.db
            .query("signInLabels")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .unique();
          return {
            sessionId: session._id,
            label: label?.userId === user._id ? label.label : null,
            createdAt: session._creationTime,
            expiresAt: session.expirationTime,
            lastActiveAt: latest?._creationTime ?? session._creationTime,
            current: session._id === current,
          };
        }),
    );
    return rows.sort((a, b) => Number(b.current) - Number(a.current));
  },
});

// Sign out one other device. Idempotent; foreign or missing sessions are not
// revealed. The current device signs out through Convex Auth's signOut.
export const revokeSignIn = mutation({
  args: { sessionId: v.id("authSessions") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.sessionId === (await currentSessionId(ctx)))
      fail("INVALID_STATE", "Use Sign out for this device");
    const session = await ctx.db.get("authSessions", args.sessionId);
    if (!session || session.userId !== user._id) return false;
    await deleteAuthSession(ctx, session._id);
    return true;
  },
});

export const signOutOtherDevices = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    return deleteAuthSessions(ctx, user._id, await currentSessionId(ctx));
  },
});

// The signed-in browser names itself (e.g. "Safari on iPhone", derived client-side from
// its user agent). Bounded and keyed to the caller's own auth session, so a browser can
// only label itself; the raw user agent is never stored.
export const labelThisDevice = mutation({
  args: { label: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const sessionId = await currentSessionId(ctx);
    const label = args.label.replace(/\s+/g, " ").trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters.
    if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label))
      fail("INVALID_ARGUMENT", "Use a label of 1 to 64 characters");
    const existing = await ctx.db
      .query("signInLabels")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (existing?.label === label && existing.userId === user._id) return null;
    if (existing)
      await ctx.db.patch("signInLabels", existing._id, {
        userId: user._id,
        label,
        updatedAt: Date.now(),
      });
    else
      await ctx.db.insert("signInLabels", {
        userId: user._id,
        sessionId,
        label,
        updatedAt: Date.now(),
      });
    return null;
  },
});
