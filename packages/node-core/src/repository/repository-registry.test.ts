import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, inspectRepository } from "@zamolxis/git";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { repositoryFixture } from "../testing/git-fixture";
import { RepositoryRegistry } from "./repository-registry";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const f = repositoryFixture(); roots.push(f.root); return f; }
const identity = { remoteUrl: "git@example.invalid:team/repo.git" };

describe("repository registry", () => {
  it("persists different workstation paths for one logical repository", () => {
    const a = fixture(); const b = fixture();
    let store = new LocalStateStore(join(a.root, "state.db"));
    const registry = new RepositoryRegistry(store, () => true);
    registry.register({ repositoryLocationId: "a", repositoryId: "repo", workstationId: "a", path: a.path, expectedIdentity: identity });
    registry.register({ repositoryLocationId: "b", repositoryId: "repo", workstationId: "b", path: b.path, expectedIdentity: identity });
    store.close(); store = new LocalStateStore(join(a.root, "state.db"));
    expect(new RepositoryRegistry(store, () => true).verify("b").path).toBe(b.path);
    expect(store.getRepositoryLocation("a")?.repositoryId).toBe("repo");
    store.close();
  });

  it("rejects wrong identity, subdirectories and revoked grants", () => {
    const f = fixture(); const store = new LocalStateStore(":memory:");
    const input = { repositoryLocationId: "a", repositoryId: "repo", workstationId: "a", path: f.path, expectedIdentity: identity };
    expect(() => new RepositoryRegistry(store, () => false).register(input)).toThrow("DENIED");
    const registry = new RepositoryRegistry(store, () => true);
    expect(() => registry.register({ ...input, expectedIdentity: { remoteUrl: "https://example.invalid/wrong/repo" } })).toThrow("MISMATCH");
    mkdirSync(join(f.path, "sub"));
    expect(() => registry.register({ ...input, path: join(f.path, "sub") })).toThrow("ROOT_REQUIRED");
    registry.register(input);
    git(f.path, ["remote", "set-url", "origin", "https://example.invalid/wrong/repo"]);
    expect(() => registry.verify("a")).toThrow("MISMATCH");
    expect(store.getRepositoryLocation("a")?.status).toBe("invalid");
    store.close();
  });

  it("detects missing locations and understands linked worktrees", () => {
    const f = fixture(); const store = new LocalStateStore(":memory:");
    const registry = new RepositoryRegistry(store, () => true);
    const linked = join(f.root, "linked");
    git(f.path, ["worktree", "add", "-b", "task", linked]);
    expect(inspectRepository(linked).gitCommonDir).toBe(inspectRepository(f.path).gitCommonDir);
    registry.register({ repositoryLocationId: "a", repositoryId: "repo", workstationId: "a", path: f.path, expectedIdentity: identity });
    renameSync(f.path, join(f.root, "moved"));
    expect(() => registry.verify("a")).toThrow("MISSING");
    expect(store.getRepositoryLocation("a")?.status).toBe("missing");
    store.close();
  });
});
