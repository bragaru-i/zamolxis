import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nodeVersion } from "./node-version";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

it("reports the checkout's short commit, marks uncommitted changes, and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "zamolxis-node-version-"));
  try {
    expect(nodeVersion(dir)).toBe("unknown");
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"]);
    const sha = git(dir, ["rev-parse", "--short=12", "HEAD"]);
    expect(nodeVersion(dir)).toBe(sha);
    // Reported from a subdirectory too: the module does not live at the repository root.
    writeFileSync(join(dir, "a.txt"), "b\n");
    expect(nodeVersion(dir)).toBe(`${sha}+dirty`);
    // Untracked files are not "dirty": a Node's own data folders do not count.
    git(dir, ["checkout", "--", "a.txt"]);
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    expect(nodeVersion(dir)).toBe(sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports this repository's own commit when run from its source tree", () => {
  expect(nodeVersion()).toMatch(/^[0-9a-f]{12}(\+dirty)?$/);
});
