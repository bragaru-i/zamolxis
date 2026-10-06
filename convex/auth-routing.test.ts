import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./auth.ts": () => import("./auth"),
  "./http.ts": () => import("./http"),
};
afterEach(() => vi.unstubAllEnvs());
it("routes Convex Auth discovery/JWKS and starts Google OAuth without granting product access", async () => {
  vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
  vi.stubEnv("SITE_URL", "https://zamolxis.example");
  vi.stubEnv("JWKS", JSON.stringify({ keys: [] }));
  const t = convexTest(schema, modules);
  const metadata = await t.fetch("/.well-known/openid-configuration");
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).issuer).toBe("https://fixture.convex.site");
  const jwks = await t.fetch("/.well-known/jwks.json");
  expect(jwks.status).toBe(200);
  expect(await jwks.json()).toEqual({ keys: [] });
  const start = await t.action(api.auth.signIn, {
    provider: "google",
    params: { redirectTo: "/" },
  });
  expect(start.redirect).toContain("https://fixture.convex.site/api/auth/signin/google");
  expect(start.verifier).toBeTruthy();
  expect(await t.run((ctx) => ctx.db.query("users").take(1))).toEqual([]);
});
