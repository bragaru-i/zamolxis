import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import {
  convexInvocation,
  serializeAuthVariables,
  validateConfig,
  validateCredentials,
} from "../scripts/lib/google-auth-setup.mjs";

const config = {
  version: 1,
  environment: "dev",
  deployment: "zamolxis-test-123",
  appUrl: "https://dev.example.com",
} as const;
const credentials = {
  deployKey: "dev:zamolxis-test-123|test-secret",
  googleClientId: "123-example.apps.googleusercontent.com",
  googleClientSecret: "GOCSPX-test",
};
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/google-auth-setup.mjs", ...args], { encoding: "utf8" });

describe("environment-specific Google auth setup", () => {
  it("pins deployment key and removes inherited cross-project selectors", () => {
    const invocation = convexInvocation(["env", "set"], "/private/setup", config, credentials, {
      PATH: "/usr/bin",
      CONVEX_DEPLOY_KEY: "prod:other|secret",
      CONVEX_DEPLOYMENT: "prod:other",
      CONVEX_SELF_HOSTED_URL: "https://other",
      ZAMOLXIS_APP_URL: "https://other",
      CONVEX_AGENT_MODE: "anonymous",
    });
    expect(invocation.args).toEqual(["env", "set", "--env-file", "/private/setup/deployment.env"]);
    expect(invocation.envFileContent).toBe(`CONVEX_DEPLOY_KEY=${credentials.deployKey}\n`);
    expect(invocation.env).toEqual({ PATH: "/usr/bin", CONVEX_DEPLOY_KEY: credentials.deployKey });
    expect(convexInvocation(["deploy"], "/private/setup", config, credentials, {}).args).toEqual([
      "deploy",
      "--env-file",
      "/private/setup/deployment.env",
    ]);
    for (const deployKey of [
      "prod:zamolxis-test-123|secret",
      "dev:other|secret",
      "project:team:project|secret",
      "preview:team:project|secret",
      "legacy|secret",
    ])
      expect(() => validateCredentials(config, { ...credentials, deployKey })).toThrow();
  });

  it("requires explicit environments and canonical HTTPS origins", () => {
    expect(validateConfig(config).appUrl).toBe(config.appUrl);
    const regional = validateConfig({
      ...config,
      convexUrl: "https://zamolxis-test-123.eu-west-1.convex.cloud",
    });
    expect(regional.convexUrl).toBe("https://zamolxis-test-123.eu-west-1.convex.cloud");
    expect(regional.httpActionsUrl).toBe("https://zamolxis-test-123.eu-west-1.convex.site");
    for (const convexUrl of [
      "https://other.eu-west-1.convex.cloud",
      "https://zamolxis-test-123.attacker.example",
      "http://zamolxis-test-123.convex.cloud",
      "https://zamolxis-test-123.convex.cloud/path",
    ])
      expect(() => validateConfig({ ...config, convexUrl })).toThrow();
    for (const appUrl of [
      "http://localhost:3000",
      "https://example.com/path",
      "https://name:secret@example.com",
      "https://example.com/?q=1",
    ])
      expect(() => validateConfig({ ...config, appUrl })).toThrow();
    expect(() => validateConfig({ ...config, environment: "preview" })).toThrow();
  });

  it("prepares separate private keys, callback URLs and frontend files without deploying", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "zamolxis-google-setup-"));
    try {
      for (const environment of ["dev", "prod"]) {
        const directory = resolve(parent, environment);
        const deployment = `zamolxis-${environment}-123`;
        const result = run(
          "prepare",
          "--environment",
          environment,
          "--deployment",
          deployment,
          "--convex-url",
          `https://${deployment}.eu-west-1.convex.cloud`,
          "--app-url",
          `https://${environment}.example.com`,
          "--directory",
          directory,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(
          `https://${deployment}.eu-west-1.convex.site/api/auth/callback/google`,
        );
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        for (const file of [
          "config.json",
          "credentials.json",
          "frontend.env",
          "JWT_PRIVATE_KEY.pem",
          "JWKS.json",
          "ZAMOLXIS_DEVICE_PRIVATE_KEY.pem",
          "ZAMOLXIS_DEVICE_JWKS.json",
        ])
          expect(statSync(resolve(directory, file)).mode & 0o777).toBe(0o600);
        expect(readFileSync(resolve(directory, "frontend.env"), "utf8")).toContain(
          `NEXT_PUBLIC_CONVEX_URL=https://${deployment}.eu-west-1.convex.cloud`,
        );
        expect(result.stdout).not.toContain("PRIVATE KEY");
        expect(run("inspect", "--environment", environment, "--directory", directory).status).toBe(
          0,
        );
        expect(
          run(
            "apply",
            "--environment",
            environment === "dev" ? "prod" : "dev",
            "--directory",
            directory,
          ).status,
        ).toBe(1);
        writeFileSync(
          resolve(directory, "credentials.json"),
          JSON.stringify({ ...credentials, deployKey: "prod:other|never-print-this" }),
        );
        const rejected = run("apply", "--environment", environment, "--directory", directory);
        expect(rejected.status).toBe(1);
        expect(rejected.stdout + rejected.stderr).not.toContain("never-print-this");
        expect(
          run(
            "prepare",
            "--environment",
            environment,
            "--deployment",
            deployment,
            "--app-url",
            `https://${environment}.example.com`,
            "--directory",
            directory,
          ).status,
        ).toBe(1);
      }
      expect(readFileSync(resolve(parent, "dev/JWKS.json"), "utf8")).not.toBe(
        readFileSync(resolve(parent, "prod/JWKS.json"), "utf8"),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

it("preserves signing-key JSON and PEM through the dotenv version bundled by Convex", () => {
  const variables = {
    SITE_URL: "https://zamolxis.example.com",
    AUTH_GOOGLE_SECRET: "GOCSPX-test",
    JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: "public-test", e: "AQAB" }] }),
    ZAMOLXIS_DEVICE_JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: "device-test" }] }),
    JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
  };
  const parsed = parse(serializeAuthVariables(variables));
  expect(parsed).toEqual(variables);
  expect(JSON.parse(parsed.JWKS ?? "")).toEqual(JSON.parse(variables.JWKS));
  expect(() => serializeAuthVariables({ SECRET: "can't quote" })).toThrow();
});
