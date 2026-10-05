import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  discoverRepositories,
  type NodeConfig,
  normalizeAppUrl,
  readConfig,
  saveConfig,
  validateConfig,
} from "./setup";

it("persists versioned private config atomically and rejects overlapping grants, insecure permissions and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "zamolxis-setup-"));
  try {
    const config: NodeConfig = {
      version: 1,
      appUrl: "https://app.example",
      convexUrl: "https://backend.example",
      name: "Mac",
      managedRoot: join(root, "managed"),
      builderSlots: 3,
      verifierSlots: 1,
      repositories: [
        { path: join(root, "repo"), name: "Repo", remoteUrl: "https://example.invalid/repo" },
      ],
    };
    const path = join(root, "private", "config.json");
    saveConfig(config, path);
    saveConfig(config, path);
    expect(readConfig(path)).toEqual(config);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() => validateConfig({ ...config, managedRoot: join(root, "repo", "managed") })).toThrow(
      "OVERLAPS",
    );
    expect(() => validateConfig({ ...config, convexUrl: "http://127.0.0.1:3210" })).toThrow(
      "HTTPS",
    );
    chmodSync(path, 0o644);
    expect(() => readConfig(path)).toThrow("PRIVATE");
    rmSync(path);
    symlinkSync(join(root, "target"), path);
    expect(() => saveConfig(config, path)).toThrow("UNSAFE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("normalizes the public app URL to an https origin", () => {
  expect(normalizeAppUrl(" zamolxis.example.com ")).toBe("https://zamolxis.example.com");
  expect(normalizeAppUrl("https://zamolxis.example.com/path?q=1")).toBe(
    "https://zamolxis.example.com",
  );
  expect(() => normalizeAppUrl("http://zamolxis.example.com")).toThrow("HTTPS");
  expect(() => normalizeAppUrl("")).toThrow();
});

it("discovers canonical repository roots and explains unusable candidates", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-discover-")));
  const repository = (name: string, origin = true, commit = true) => {
    const path = join(root, name);
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    if (commit) {
      writeFileSync(join(path, "file.txt"), "x\n");
      git("add", ".");
      git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
    }
    if (origin) git("remote", "add", "origin", "https://example.invalid/team/repo.git");
    return path;
  };
  try {
    const good = repository("good");
    const noOrigin = repository("no-origin", false);
    const empty = repository("empty", true, false);
    const variant = join(root, "GOOD");
    const found = discoverRepositories([good, variant, noOrigin, empty, join(root, "missing")]);
    expect(found).toEqual([
      { path: good, remoteUrl: "https://example.invalid/team/repo.git" },
      { path: noOrigin, problem: "no origin remote" },
      { path: empty, problem: "no commits yet" },
    ]);
    // On case-insensitive volumes the case variant collapses into the canonical root.
    if (existsSync(variant)) expect(found.filter((choice) => choice.path === good)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
