import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type NodeConfig, readConfig, saveConfig, validateConfig } from "./setup";

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
