import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateTrust } from "@zamolxis/application";
import { git } from "@zamolxis/git";
import { expect, it, vi } from "vitest";
import { repositoryFixture } from "../testing/git-fixture";
import { type CheckObservation, runVerificationChecks } from "./checks";

it("does not hide a failed explicit check behind a static-only policy", async () => {
  const f = repositoryFixture();
  try {
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({ scripts: { test: "node -e 'process.exit(3)'" } }),
    );
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "check"]);
    const evidence = await runVerificationChecks(f.path, ["test"], ["static"]);
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ modality: "test", result: "failed" })]),
    );
    expect(
      evaluateTrust(
        "builder",
        "sha",
        evidence.map((item) => ({
          ...item,
          subjectSha: "sha",
          verifierRunId: "verifier",
          origin: "independent-verifier" as const,
        })),
        ["static"],
      ).eligible,
    ).toBe(false);
    // The failing script's output is kept, bounded, for Repair.
    expect(evidence.find((item) => item.modality === "test")?.summary).toContain(
      "Failure output:\n$ npm run test",
    );
    const missing = await runVerificationChecks(f.path, [], ["test"]);
    expect(missing.find((item) => item.modality === "test")?.result).toBe("failed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("runs repository scripts without GitHub tokens", async () => {
  const f = repositoryFixture();
  vi.stubEnv("GH_TOKEN", "ghp_from_the_node_environment");
  vi.stubEnv("GITHUB_TOKEN", "ghp_from_the_node_environment");
  try {
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e 'process.exit(process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? 5 : 0)'",
        },
      }),
    );
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "check"]);
    const evidence = await runVerificationChecks(f.path, ["test"], ["test"]);
    expect(evidence.find((item) => item.modality === "test")?.result).toBe("passed");
  } finally {
    vi.unstubAllEnvs();
    rmSync(f.root, { recursive: true, force: true });
  }
});

const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
`;
// The installed pnpm, so the manifest's packageManager field never triggers a download.
const pnpmVersion = () => execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();

it("installs a pnpm repository's dependencies from its lockfile before the scripts", async () => {
  const f = repositoryFixture();
  try {
    // A dependency the fixture itself provides, so the install needs no registry.
    mkdirSync(join(f.path, "local-dep"));
    writeFileSync(
      join(f.path, "local-dep", "package.json"),
      JSON.stringify({ name: "local-dep", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(f.path, "local-dep", "index.js"), "module.exports = 'installed';\n");
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({
        name: "fixture",
        packageManager: `pnpm@${pnpmVersion()}`,
        dependencies: { "local-dep": "file:local-dep" },
        scripts: { test: "node -e \"require('local-dep')\"" },
      }),
    );
    execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: f.path, stdio: "ignore" });
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "check"]);
    expect(existsSync(join(f.path, "node_modules"))).toBe(false);
    const observed: CheckObservation[] = [];
    const evidence = await runVerificationChecks(f.path, ["test"], ["test"], (check) =>
      observed.push(check),
    );
    expect(existsSync(join(f.path, "node_modules", "local-dep", "index.js"))).toBe(true);
    expect(evidence.find((item) => item.modality === "test")?.result).toBe("passed");
    expect(observed.map((check) => [check.command, check.result])).toEqual([
      ["git diff --check HEAD^ HEAD", "passed"],
      ["pnpm install --frozen-lockfile --prefer-offline", "passed"],
      ["pnpm run test", "passed"],
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("does not run the scripts when the lockfile install fails", async () => {
  const f = repositoryFixture();
  try {
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({
        name: "fixture",
        packageManager: `pnpm@${pnpmVersion()}`,
        dependencies: { "left-pad": "1.3.0" },
        scripts: { test: "node -e 'process.exit(0)'" },
      }),
    );
    // The lockfile does not match the manifest, which a frozen install refuses.
    writeFileSync(join(f.path, "pnpm-lock.yaml"), PNPM_LOCK);
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "check"]);
    const observed: CheckObservation[] = [];
    const evidence = await runVerificationChecks(f.path, ["test"], ["test"], (check) =>
      observed.push(check),
    );
    expect(evidence.find((item) => item.modality === "test")?.result).toBe("failed");
    expect(observed.map((check) => [check.command, check.result])).toEqual([
      ["git diff --check HEAD^ HEAD", "passed"],
      ["pnpm install --frozen-lockfile --prefer-offline", "failed"],
      ["pnpm run test", "failed"],
    ]);
    expect(observed[2]?.output).toContain("could not be installed");
    // The real error reaches the evidence a Repair gets (#163).
    expect(evidence.find((item) => item.modality === "test")?.summary).toMatch(
      /Failure output:\n\$ pnpm install --frozen-lockfile --prefer-offline\n[\s\S]*ERR_PNPM/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
