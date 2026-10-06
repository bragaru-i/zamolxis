import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareCodexHome, releaseCodexHome } from "./codex-home";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "zamolxis-codex-home-"));
  roots.push(path);
  writeFileSync(join(path, "user-auth.json"), '{"token":"login"}');
  return path;
}

it("keeps rollouts across restarts, refreshes only the login and prunes old rollouts", () => {
  const base = root();
  const home = join(base, "codex-home");
  const authSource = join(base, "user-auth.json");
  prepareCodexHome(home, { authSource });
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
  const day = join(home, "sessions", "2026", "10", "06");
  mkdirSync(day, { recursive: true });
  const recent = join(day, "rollout-recent.jsonl");
  const old = join(day, "rollout-old.jsonl");
  const other = join(day, "notes.txt");
  for (const path of [recent, old, other]) writeFileSync(path, "{}\n");
  const now = Date.now();
  const ancient = new Date(now - 40 * 24 * 60 * 60 * 1000);
  utimesSync(old, ancient, ancient);
  utimesSync(other, ancient, ancient);
  releaseCodexHome(home);
  expect(existsSync(join(home, "auth.json"))).toBe(false);

  // The next Node start: the login is copied again, recent rollouts survive.
  writeFileSync(authSource, '{"token":"refreshed"}');
  prepareCodexHome(home, { authSource, now: () => now });
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"token":"refreshed"}');
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

it("refuses a symlinked home or login file", () => {
  const base = root();
  const authSource = join(base, "user-auth.json");
  mkdirSync(join(base, "elsewhere"));
  symlinkSync(join(base, "elsewhere"), join(base, "linked"));
  expect(() => prepareCodexHome(join(base, "linked"), { authSource })).toThrow("UNSAFE_CODEX_HOME");
  const home = join(base, "home");
  mkdirSync(home);
  symlinkSync(authSource, join(home, "auth.json"));
  expect(() => prepareCodexHome(home, { authSource })).toThrow("UNSAFE_CODEX_HOME");
  expect(() => prepareCodexHome("relative", { authSource })).toThrow("NOT_ABSOLUTE");
});
