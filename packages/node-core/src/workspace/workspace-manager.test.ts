import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@zamolxis/git";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "./workspace-manager";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const f = repositoryFixture(); cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));
  const database = join(f.root, "state.db");
  const store = new LocalStateStore(database); cleanup.push(() => store.close());
  const registry = new RepositoryRegistry(store, () => true);
  registry.register({ repositoryLocationId: "location", repositoryId: "repo", workstationId: "node", path: f.path,
    expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" } });
  const root = join(f.root, "workspaces");
  const manager = new WorkspaceManager(store, registry, root, "instance-a", () => true);
  const provision = (workspaceId: string) => manager.provision({ workspaceId, repositoryLocationId: "location", baseRef: "main" });
  return { ...f, root, store, manager, provision, database };
}
const retention = { artifactsCaptured: true, integrationPending: false, retentionAllows: true };

describe("workspace lifecycle with real Git", () => {
  it("checks resolved root grants before creating directories through symlinks", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    const redirect = join(f.root, "redirect");
    mkdirSync(outside);
    symlinkSync(outside, redirect);
    expect(() => new WorkspaceManager(f.store, new RepositoryRegistry(f.store, () => true),
      join(redirect, "new"), "instance", (path) => path.startsWith(redirect))).toThrow("ROOT_DENIED");
    expect(existsSync(join(outside, "new"))).toBe(false);
  });
  it("isolates parallel edits, retries provision and reuses dirty work after runtime replacement", () => {
    const f = fixture(); const a = f.provision("a"); const b = f.provision("b");
    expect(a.path).not.toBe(b.path);
    writeFileSync(join(a.path, "source.txt"), "runtime A\n");
    writeFileSync(join(b.path, "source.txt"), "runtime B\n");
    expect(readFileSync(join(f.path, "source.txt"), "utf8")).toBe("base\n");
    expect(f.provision("a").path).toBe(a.path);
    f.manager.acquire("a", "run-a", a.path, a.branch);
    expect(() => f.manager.acquire("a", "run-b", a.path, a.branch)).toThrow("BUSY");
    f.manager.release("a", "run-a");
    expect(f.manager.acquire("a", "replacement", a.path, a.branch).dirty).toBe(true);
    expect(readFileSync(join(a.path, "source.txt"), "utf8")).toBe("runtime A\n");
    f.manager.release("a", "replacement");
    expect(() => f.manager.cleanup("a", retention)).toThrow("DIRTY");
  });

  it("rejects wrong cwd, branch, path traversal, conflicting retries and changed Git branch", () => {
    const f = fixture(); const a = f.provision("a");
    expect(() => f.manager.acquire("a", "run", f.path, a.branch)).toThrow("MISMATCH");
    expect(() => f.manager.acquire("a", "run", a.path, "main")).toThrow("MISMATCH");
    expect(() => f.provision("../escape")).toThrow("INVALID");
    expect(() => f.manager.provision({ workspaceId: "a", repositoryLocationId: "location", baseRef: "HEAD" })).toThrow("CONFLICT");
    git(a.path, ["checkout", "-b", "wrong"]);
    expect(() => f.manager.acquire("a", "run", a.path, a.branch)).toThrow("IDENTITY");
  });

  it("keeps leases across connections and requires stopped-run evidence after restart", () => {
    const f = fixture(); const a = f.provision("a");
    f.manager.acquire("a", "run-a", a.path, a.branch);
    const secondStore = new LocalStateStore(f.database); cleanup.push(() => secondStore.close());
    const second = new WorkspaceManager(secondStore, new RepositoryRegistry(secondStore, () => true), f.root, "instance-b", () => true);
    expect(second.reconcile()).toContainEqual({ workspaceId: "a", status: "in_use", staleLease: true });
    expect(() => second.acquire("a", "run-a", a.path, a.branch)).toThrow("BUSY");
    expect(() => second.releaseStaleLease("a", () => false)).toThrow("NOT_RECONCILED");
    second.releaseStaleLease("a", () => true);
    second.acquire("a", "run-b", a.path, a.branch);
    expect(() => f.manager.cleanup("a", retention)).toThrow("BUSY");
    second.release("a", "run-b");
    second.cleanup("a", retention); second.cleanup("a", retention);
    expect(secondStore.getManagedWorkspace("a")?.status).toBe("removed");
  });

  it("recovers interrupted provision and reports orphans without deleting them", () => {
    const f = fixture(); const a = f.provision("a");
    f.store.saveManagedWorkspace({ ...a, status: "provisioning" });
    expect(f.provision("a").status).toBe("ready");
    const orphan = join(f.root, "orphan");
    git(f.path, ["worktree", "add", "-b", "orphan", orphan]);
    writeFileSync(join(orphan, "source.txt"), "valuable\n");
    expect(f.manager.listUnownedWorktrees("location")).toContain(orphan);
    f.manager.reconcile();
    expect(readFileSync(join(orphan, "source.txt"), "utf8")).toBe("valuable\n");
    expect(() => f.manager.cleanup("a", { ...retention, integrationPending: true })).toThrow("DENIED");
  });
});
