import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Device labels of browser sign-ins (#47).
const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./admin.ts": () => import("../convex/admin"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./node.ts": () => import("../convex/node"),
  "./onboarding.ts": () => import("../convex/onboarding"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./workstations.ts": () => import("../convex/workstations"),
};

async function fixture() {
  const t = convexTest(schema, modules);
  const { user, userId } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  return { t, user, userId, other };
}

describe("signed-in device labels", () => {
  it("labels only the caller's own session, bounded, and cleans up on sign-out", async () => {
    const { t, user, userId: aliceId, other } = await fixture();
    await user.mutation(api.admin.labelThisDevice, { label: " Safari   on iPhone " });
    await user.mutation(api.admin.labelThisDevice, { label: "Safari on iPhone" });
    const [mine] = await user.query(api.admin.mySignIns, {});
    expect(mine).toMatchObject({ current: true, label: "Safari on iPhone" });
    expect((await other.query(api.admin.mySignIns, {}))[0]?.label).toBeNull();
    for (const label of ["", "x".repeat(65), "a\u0000b"])
      await expect(user.mutation(api.admin.labelThisDevice, { label })).rejects.toThrow(
        "INVALID_ARGUMENT",
      );
    expect(await t.run((ctx) => ctx.db.query("signInLabels").collect())).toHaveLength(1);
    // Signing a device out from another browser removes its label too.
    const second = await t.run((ctx) =>
      ctx.db.insert("authSessions", { userId: aliceId, expirationTime: Date.now() + 3600_000 }),
    );
    const secondBrowser = t.withIdentity({
      subject: `${aliceId}|${second}`,
      tokenIdentifier: "alice-2",
    });
    await secondBrowser.mutation(api.admin.signOutOtherDevices, {});
    expect(await t.run((ctx) => ctx.db.query("signInLabels").collect())).toHaveLength(0);
    const pending = await seedHuman(t, "carol", "pending");
    await expect(
      pending.user.mutation(api.admin.labelThisDevice, { label: "Chrome on Mac" }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});
