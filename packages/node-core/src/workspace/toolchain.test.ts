import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Execute, WorkspaceToolchain } from "./toolchain";

const dirs: string[] = [];
function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "zamolxis-toolchain-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
function worktree(files: Record<string, string>): string {
  const cwd = dir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  return cwd;
}
// A fake npm/pnpm: `npm install --prefix <dir>` creates a pnpm binary there.
function fakeExecute(ok = true) {
  return vi.fn<Execute>(async (executable, args) => {
    if (ok && executable === "npm" && args[0] === "install") {
      const bin = join(args[2]!, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pnpm"), "");
    }
    return ok;
  });
}
const PNPM_REPO = {
  "package.json": JSON.stringify({ packageManager: "pnpm@10.17.1+sha512.abc" }),
  "pnpm-lock.yaml": "",
};

describe("WorkspaceToolchain", () => {
  it("installs the pinned pnpm once and the worktree dependencies with it", async () => {
    const tools = dir();
    const run = fakeExecute();
    const toolchain = new WorkspaceToolchain(tools, run);
    const cwd = worktree(PNPM_REPO);
    const bin = join(tools, "pnpm@10.17.1", "node_modules", ".bin");
    expect(await toolchain.prepare(cwd, "builder")).toEqual([bin]);
    expect(run.mock.calls.map(([executable, args]) => [executable, args[0]])).toEqual([
      ["npm", "install"],
      ["pnpm", "install"],
    ]);
    const install = run.mock.calls[1]!;
    expect(install[1]).toEqual(["install", "--frozen-lockfile", "--prefer-offline"]);
    expect(install[2].cwd).toBe(cwd);
    expect(install[2].env.PATH?.startsWith(bin)).toBe(true);

    // A second worktree reuses the pinned pnpm; one with dependencies installs nothing.
    run.mockClear();
    const other = worktree(PNPM_REPO);
    mkdirSync(join(other, "node_modules"));
    expect(await toolchain.prepare(other, "repair")).toEqual([bin]);
    expect(run).not.toHaveBeenCalled();
    expect(readdirSync(tools)).toEqual(["pnpm@10.17.1"]);
  });
  it("gives read-only roles the pinned pnpm but installs nothing in their worktree", async () => {
    const run = fakeExecute();
    const toolchain = new WorkspaceToolchain(dir(), run);
    const paths = await toolchain.prepare(worktree(PNPM_REPO), "verifier");
    expect(paths).toHaveLength(1);
    expect(run.mock.calls.map(([executable]) => executable)).toEqual(["npm"]);
  });
  it("uses npm ci for an npm lockfile and ignores unpinned or unsafe manifests", async () => {
    const run = fakeExecute();
    const toolchain = new WorkspaceToolchain(dir(), run);
    const cwd = worktree({ "package.json": "{}", "package-lock.json": "{}" });
    expect(await toolchain.prepare(cwd, "builder")).toEqual([]);
    expect(run.mock.calls.map(([executable, args]) => [executable, ...args])).toEqual([
      ["npm", "ci"],
    ]);
    run.mockClear();
    const loose = worktree({ "package.json": JSON.stringify({ packageManager: "pnpm@latest" }) });
    expect(await toolchain.prepare(loose, "builder")).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it("returns no tool path when the pinned pnpm cannot be installed", async () => {
    const tools = dir();
    const run = fakeExecute(false);
    const toolchain = new WorkspaceToolchain(tools, run);
    expect(await toolchain.prepare(worktree(PNPM_REPO), "verifier")).toEqual([]);
    expect(readdirSync(tools)).toEqual([]);
    expect(existsSync(join(tools, "pnpm@10.17.1"))).toBe(false);
  });
});
