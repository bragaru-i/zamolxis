import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  deployedCommitMatches,
  gitProblem,
  nodeServiceRunsFrom,
  parseDeployArgs,
  vercelArgs,
} from "../scripts/lib/deploy.mjs";

const sha = "a".repeat(40);

describe("production deploy", () => {
  it("requires the private prod directory unless only the Node is restarted", () => {
    const previous = process.env.ZAMOLXIS_PROD_SETUP_DIR;
    delete process.env.ZAMOLXIS_PROD_SETUP_DIR;
    try {
      expect(() => parseDeployArgs([])).toThrow("--directory");
      expect(parseDeployArgs(["--skip-convex", "--skip-web"]).node).toBe(true);
      expect(parseDeployArgs(["--directory", "/private/prod", "--pull", "--yes"])).toMatchObject({
        directory: "/private/prod",
        pull: true,
        yes: true,
        check: true,
      });
      expect(() => parseDeployArgs(["--directory", "/x", "--force"])).toThrow("Unknown option");
    } finally {
      if (previous !== undefined) process.env.ZAMOLXIS_PROD_SETUP_DIR = previous;
    }
  });

  it("deploys only a clean main that matches origin/main", () => {
    const clean = { branch: "main", head: sha, remoteHead: sha, dirty: false };
    expect(gitProblem(clean)).toBeUndefined();
    expect(gitProblem({ ...clean, branch: "feature" })).toContain("main");
    expect(gitProblem({ ...clean, branch: "" })).toContain("detached");
    expect(gitProblem({ ...clean, dirty: true })).toContain("local changes");
    expect(gitProblem({ ...clean, remoteHead: "b".repeat(40) })).toContain("--pull");
  });

  it("stamps the commit into the production web deployment and verifies it", () => {
    expect(vercelArgs(sha)).toEqual([
      "deploy",
      "--prod",
      "--yes",
      "--build-env",
      `ZAMOLXIS_COMMIT=${sha}`,
      "--env",
      `ZAMOLXIS_COMMIT=${sha}`,
    ]);
    expect(() => vercelArgs("main")).toThrow("SHA");
    expect(deployedCommitMatches({ version: 1, commit: sha }, sha)).toBe(true);
    expect(deployedCommitMatches({ version: 1, commit: "b".repeat(40) }, sha)).toBe(false);
    expect(deployedCommitMatches({ version: 1 }, sha)).toBe(false);
    expect(deployedCommitMatches(undefined, sha)).toBe(false);
  });

  it("restarts the Node service only when it runs this checkout", () => {
    const plist = "<string>/repo/apps/node/src/daemon.ts</string>";
    expect(nodeServiceRunsFrom(plist, "/repo")).toBe(true);
    expect(nodeServiceRunsFrom(plist, "/other")).toBe(false);
  });

  it("prints usage without touching Git or production", () => {
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pnpm deploy:prod --directory");
  });
});
