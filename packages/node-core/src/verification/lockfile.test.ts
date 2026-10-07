import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedManifests, updateLockfile } from "./lockfile";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
function project(): string {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "zx-lockfile-")));
  const pnpm = execFileSync("pnpm", ["--version"]).toString().trim();
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "app", private: true, packageManager: `pnpm@${pnpm}` }),
  );
  mkdirSync(join(cwd, "dep"));
  writeFileSync(
    join(cwd, "dep", "package.json"),
    JSON.stringify({ name: "dep", version: "1.0.0" }),
  );
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd });
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

describe("lockfile update before the candidate commit", () => {
  it("finds changed package.json files only", () => {
    expect(
      changedManifests(
        " M package.json\0 M apps/web/package.json\0?? src/a.ts\0 M x/package.json5\0",
      ),
    ).toEqual(["package.json", "apps/web/package.json"]);
  });

  it("adds a new dependency to the lockfile without installing it", async () => {
    const cwd = project();
    expect(await updateLockfile(cwd)).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ ...manifest, dependencies: { dep: "file:./dep" } }),
    );
    const update = await updateLockfile(cwd);
    expect(update).toMatchObject({
      command: "pnpm install --lockfile-only --ignore-scripts",
      result: "passed",
    });
    expect(readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8")).toContain("dep:");
    // Only the lockfile changed: nothing was installed.
    expect(() => readFileSync(join(cwd, "node_modules", "dep", "package.json"))).toThrow();
    // The frozen install the Verifier runs now accepts it.
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], {
      cwd,
    });
  }, 60_000);

  it("also updates it for a manifest committed earlier in the task (a Repair after a Builder)", async () => {
    const cwd = project();
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ ...manifest, dependencies: { dep: "file:./dep" } }),
    );
    git(cwd, ["commit", "-qam", "builder candidate without lockfile"]);
    expect(await updateLockfile(cwd)).toBeUndefined();
    expect(await updateLockfile(cwd, base)).toMatchObject({ result: "passed" });
    expect(readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8")).toContain("dep:");
  }, 60_000);
});
