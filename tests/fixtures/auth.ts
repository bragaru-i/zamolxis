import type { TestConvex } from "convex-test";
import type schema from "../../convex/schema";

// Authentication is a fixture; authorization and persistence use real functions.
export async function seedHuman(
  t: TestConvex<typeof schema>,
  name: string,
  accessStatus: "pending" | "allowed" | "blocked" = "allowed",
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authSubject: name,
      email: `${name}@example.com`,
      emailVerificationTime: 1,
      accessStatus,
      createdAt: 0,
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3600_000,
    });
    return { userId, sessionId };
  });
  return {
    userId,
    sessionId,
    user: t.withIdentity({ subject: `${userId}|${sessionId}`, tokenIdentifier: name }),
  };
}
