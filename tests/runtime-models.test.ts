import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

// Runtime model catalog: Nodes report models in the heartbeat; Settings -> Agents reads them.
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
const sol = {
  id: "gpt-sol",
  displayName: "GPT Sol",
  description: "Workhorse",
  isDefault: true,
  efforts: ["low", "medium", "high"],
  defaultEffort: "low",
};
const mini = { id: "gpt-mini", displayName: "GPT Mini", efforts: ["low"] };
const alpha = { id: "alpha", displayName: "Alpha" };

async function fixture() {
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  const pair = async (owner: typeof user, subject: string, ownerSubject: string) => {
    const workstationId = await owner.mutation(api.workstations.register, {
      name: subject,
      nodeAuthSubject: subject,
    });
    const node = t.withIdentity({
      subject,
      issuer: "https://identity.example",
      tokenIdentifier: subject,
      ownerSubject,
    });
    const beat = (models?: unknown[], runtime = "codex") =>
      node.mutation(api.node.heartbeat, {
        workstationId,
        instanceId: "instance",
        runtimeCapabilities: [
          { runtime, capabilities: ["start"], ...(models ? { models: models as never } : {}) },
        ],
      });
    return { workstationId, beat };
  };
  const stored = (workstationId: Id<"workstations">) =>
    t.run((ctx) =>
      ctx.db
        .query("runtimeInstallations")
        .withIndex("by_workstation_runtime", (q) =>
          q.eq("workstationId", workstationId).eq("runtime", "codex"),
        )
        .unique(),
    );
  return { t, user, other, pair, stored };
}

describe("runtime models", () => {
  it("stores reported models and keeps them when a heartbeat omits them", async () => {
    const { user, pair, stored } = await fixture();
    const mac = await pair(user, "device", "alice");
    await mac.beat([mini, sol]);
    const first = await stored(mac.workstationId);
    expect(first?.models).toEqual([mini, sol]);
    expect(first?.modelsUpdatedAt).toBeTypeOf("number");
    await mac.beat();
    expect((await stored(mac.workstationId))?.models).toEqual([mini, sol]);
    await mac.beat([alpha]);
    expect((await stored(mac.workstationId))?.models).toEqual([alpha]);
  });

  it("bounds models server-side", async () => {
    const { user, pair, stored } = await fixture();
    const mac = await pair(user, "device", "alice");
    await expect(
      mac.beat(Array.from({ length: 51 }, (_, i) => ({ id: `m${i}`, displayName: `M${i}` }))),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await mac.beat([
      {
        id: "x",
        displayName: "d".repeat(500),
        efforts: Array.from({ length: 20 }, (_, i) => `${i}`),
      },
      { id: "i".repeat(400), displayName: "Too long" },
    ]);
    const models = (await stored(mac.workstationId))?.models ?? [];
    expect(models).toHaveLength(1);
    expect(models[0]?.displayName).toHaveLength(128);
    expect(models[0]?.efforts).toHaveLength(10);
  });

  it("aggregates the owner's available runtimes, deduplicated and sorted default first", async () => {
    const { user, other, pair } = await fixture();
    const studio = await pair(user, "studio", "alice");
    const laptop = await pair(user, "laptop", "alice");
    await studio.beat([mini, { ...sol, isDefault: false }]);
    await laptop.beat([{ ...mini, displayName: "Later name" }, sol, alpha]);
    expect(await user.query(api.agentProfiles.models, {})).toEqual([
      {
        runtime: "codex",
        models: [{ ...sol, isDefault: true }, alpha, mini],
      },
    ]);
    // Owner isolation: another user sees nothing of Alice's Macs.
    expect(await other.query(api.agentProfiles.models, {})).toEqual([]);
    const bobs = await pair(other, "bob-mac", "bob");
    await bobs.beat([{ id: "bob-model", displayName: "Bob model" }]);
    expect(await other.query(api.agentProfiles.models, {})).toEqual([
      { runtime: "codex", models: [{ id: "bob-model", displayName: "Bob model" }] },
    ]);
    expect((await user.query(api.agentProfiles.models, {}))[0]?.models).toHaveLength(3);
  });

  it("ignores unavailable runtimes and revoked Macs", async () => {
    const { user, pair } = await fixture();
    const studio = await pair(user, "studio", "alice");
    const laptop = await pair(user, "laptop", "alice");
    await studio.beat([mini]);
    await laptop.beat([sol]);
    // The laptop stops advertising codex: its installation becomes unavailable.
    await laptop.beat(undefined, "fake");
    expect(await user.query(api.agentProfiles.models, {})).toEqual([
      { runtime: "codex", models: [mini] },
    ]);
    await user.mutation(api.workstations.revoke, { workstationId: studio.workstationId });
    expect(await user.query(api.agentProfiles.models, {})).toEqual([]);
  });

  it("requires a signed-in owner", async () => {
    const { t } = await fixture();
    await expect(t.query(api.agentProfiles.models, {})).rejects.toThrow();
  });
});
