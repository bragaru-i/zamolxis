import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./migrations.ts": () => import("../convex/migrations"),
};
const OLD = "https://cheery-fox-709.eu-west-1.convex.site";
const NEW = "https://convex-site.bragaru.cc";

afterEach(() => vi.unstubAllEnvs());

it("moves computer identities from the old backend address to this one, once", async () => {
  vi.stubEnv("CONVEX_SITE_URL", NEW);
  const t = convexTest(schema, modules);
  const owner = await seedHuman(t, "owner");
  const device = (subject: string) =>
    t.run((ctx) =>
      ctx.db.insert("workstations", {
        ownerId: owner.userId,
        name: subject,
        status: "online",
        registeredAt: 0,
        nodeAuthSubject: subject,
      }),
    );
  const mac = await device(`${OLD}|node:mac`);
  const other = await device("https://elsewhere.example|node:x");
  expect(await t.mutation(internal.migrations.moveNodeIssuer, { from: OLD })).toEqual({ moved: 1 });
  const subject = (id: typeof mac) => t.run(async (ctx) => (await ctx.db.get(id))?.nodeAuthSubject);
  expect(await subject(mac)).toBe(`${NEW}|node:mac`);
  expect(await subject(other)).toBe("https://elsewhere.example|node:x");
  // Running it again changes nothing.
  expect(await t.mutation(internal.migrations.moveNodeIssuer, { from: OLD })).toEqual({ moved: 0 });
  await expect(t.mutation(internal.migrations.moveNodeIssuer, { from: NEW })).rejects.toThrow(
    "INVALID_ARGUMENT",
  );
});
