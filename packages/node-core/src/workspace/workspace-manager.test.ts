import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteManagedBranch, git } from "@zamolxis/git";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "./workspace-manager";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const f = repositoryFixture();
  cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));
  const database = join(f.root, "state.db");
  const store = new LocalStateStore(database);
  cleanup.push(() => store.close());
  const registry = new RepositoryRegistry(store, () => true);
  registry.register({
    repositoryLocationId: "location",
    repositoryId: "repo",
    workstationId: "node",
    path: f.path,
    expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
  });
  const root = join(f.root, "workspaces");
  const manager = new WorkspaceManager(store, registry, root, "instance-a", () => true);
  const provision = (workspaceId: string) =>
    manager.provision({ workspaceId, repositoryLocationId: "location", baseRef: "main" });
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
    expect(
      () =>
        new WorkspaceManager(
          f.store,
          new RepositoryRegistry(f.store, () => true),
          join(redirect, "new"),
          "instance",
          (path) => path.startsWith(redirect),
        ),
    ).toThrow("ROOT_DENIED");
    expect(existsSync(join(outside, "new"))).toBe(false);
  });
  it("isolates parallel edits, retries provision and reuses dirty work after runtime replacement", () => {
    const f = fixture();
    const a = f.provision("a");
    const b = f.provision("b");
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
    const f = fixture();
    const a = f.provision("a");
    expect(() => f.manager.acquire("a", "run", f.path, a.branch)).toThrow("MISMATCH");
    expect(() => f.manager.acquire("a", "run", a.path, "main")).toThrow("MISMATCH");
    expect(() => f.provision("../escape")).toThrow("INVALID");
    expect(() =>
      f.manager.provision({ workspaceId: "a", repositoryLocationId: "location", baseRef: "HEAD" }),
    ).toThrow("CONFLICT");
    git(a.path, ["checkout", "-b", "wrong"]);
    expect(() => f.manager.acquire("a", "run", a.path, a.branch)).toThrow("IDENTITY");
  });

  it("keeps leases across connections and requires stopped-run evidence after restart", () => {
    const f = fixture();
    const a = f.provision("a");
    f.manager.acquire("a", "run-a", a.path, a.branch);
    const secondStore = new LocalStateStore(f.database);
    cleanup.push(() => secondStore.close());
    const second = new WorkspaceManager(
      secondStore,
      new RepositoryRegistry(secondStore, () => true),
      f.root,
      "instance-b",
      () => true,
    );
    expect(second.reconcile()).toContainEqual({
      workspaceId: "a",
      status: "in_use",
      staleLease: true,
    });
    expect(() => second.acquire("a", "run-a", a.path, a.branch)).toThrow("BUSY");
    expect(() => second.releaseStaleLease("a", () => false)).toThrow("NOT_RECONCILED");
    second.releaseStaleLease("a", () => true);
    second.acquire("a", "run-b", a.path, a.branch);
    expect(() => f.manager.cleanup("a", retention)).toThrow("BUSY");
    second.release("a", "run-b");
    second.cleanup("a", retention);
    second.cleanup("a", retention);
    expect(secondStore.getManagedWorkspace("a")?.status).toBe("removed");
  });

  it("recovers interrupted provision and reports orphans without deleting them", () => {
    const f = fixture();
    const a = f.provision("a");
    f.store.saveManagedWorkspace({ ...a, status: "provisioning" });
    expect(f.provision("a").status).toBe("ready");
    const orphan = join(f.root, "orphan");
    git(f.path, ["worktree", "add", "-b", "orphan", orphan]);
    writeFileSync(join(orphan, "source.txt"), "valuable\n");
    expect(f.manager.listUnownedWorktrees("location")).toContain(orphan);
    f.manager.reconcile();
    expect(readFileSync(join(orphan, "source.txt"), "utf8")).toBe("valuable\n");
    expect(() => f.manager.cleanup("a", { ...retention, integrationPending: true })).toThrow(
      "DENIED",
    );
  });
});

describe("worktree cleanup and Git metadata (#8)", () => {
  const branches = (path: string) =>
    git(path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").sort();
  const commit = (path: string, file: string, content = `${file}\n`) => {
    writeFileSync(join(path, file), content);
    git(path, ["add", "."]);
    git(path, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-m", file]);
    return git(path, ["rev-parse", "HEAD"]);
  };

  it("removes a clean worktree with ignored output and deletes its branch only at the named commit", () => {
    const f = fixture();
    const canonicalHead = git(f.path, ["rev-parse", "HEAD"]);
    const canonicalStatus = git(f.path, ["status", "--porcelain"]);
    // User branches and a published zamolxis/* branch must survive every cleanup.
    git(f.path, ["branch", "feature/mine"]);
    git(f.path, ["branch", "zamolxis/task-1234567"]);
    const a = f.provision("a");
    const stale = commit(a.path, "a.txt");
    // Ignored build output does not make a worktree dirty and is removed with it.
    commit(a.path, ".gitignore", "build/\n");
    mkdirSync(join(a.path, "build"));
    writeFileSync(join(a.path, "build", "out.js"), "x\n");
    // A stale commit name keeps the branch: the backend did not authorize this tip.
    expect(f.manager.cleanup("a", retention, { deleteBranchAt: stale })).toEqual({
      branchDeleted: false,
    });
    expect(existsSync(a.path)).toBe(false);
    expect(branches(f.path)).toContain(a.branch);
    expect(f.store.getManagedWorkspace("a")?.status).toBe("removed");
    // Removal is idempotent and never touches the branch again.
    const tip = git(f.path, ["rev-parse", a.branch]);
    expect(f.manager.cleanup("a", retention, { deleteBranchAt: tip })).toEqual({
      branchDeleted: false,
    });
    expect(branches(f.path)).toContain(a.branch);

    const b = f.provision("b");
    const bHead = commit(b.path, "b.txt");
    expect(f.manager.cleanup("b", retention, { deleteBranchAt: bHead })).toEqual({
      branchDeleted: true,
    });
    expect(branches(f.path)).not.toContain(b.branch);
    expect(branches(f.path)).toEqual(
      expect.arrayContaining(["feature/mine", "main", "zamolxis/task-1234567", a.branch]),
    );
    expect(git(f.path, ["worktree", "list", "--porcelain"])).not.toContain(b.path);
    // The canonical checkout is never a cleanup target and stays exactly as it was.
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(canonicalHead);
    expect(git(f.path, ["status", "--porcelain"])).toBe(canonicalStatus);
  });

  it("preserves untracked work and keeps the branch when nothing was authorized", () => {
    const f = fixture();
    const a = f.provision("a");
    writeFileSync(join(a.path, "notes.txt"), "untracked\n");
    expect(() => f.manager.cleanup("a", retention, { deleteBranchAt: a.baseSha })).toThrow(
      "DIRTY_WORKSPACE_PRESERVED",
    );
    expect(readFileSync(join(a.path, "notes.txt"), "utf8")).toBe("untracked\n");
    expect(branches(f.path)).toContain(a.branch);
    rmSync(join(a.path, "notes.txt"));
    expect(f.manager.cleanup("a", retention)).toEqual({ branchDeleted: false });
    expect(branches(f.path)).toContain(a.branch);
  });

  it("prunes the registration of a worktree deleted outside Zamolxis", () => {
    const f = fixture();
    const a = f.provision("a");
    rmSync(a.path, { recursive: true, force: true });
    expect(git(f.path, ["worktree", "list", "--porcelain"])).toContain(a.path);
    expect(f.manager.cleanup("a", retention, { deleteBranchAt: a.baseSha })).toEqual({
      branchDeleted: true,
    });
    expect(git(f.path, ["worktree", "list", "--porcelain"])).not.toContain(a.path);
    expect(f.store.getManagedWorkspace("a")?.status).toBe("removed");
    expect(branches(f.path)).toEqual(["main"]);
  });

  it("never deletes a branch outside zam/ or one checked out in a worktree", () => {
    const f = fixture();
    const head = git(f.path, ["rev-parse", "HEAD"]);
    expect(() => deleteManagedBranch(f.path, "main", head)).toThrow("BRANCH_NOT_MANAGED");
    expect(() => deleteManagedBranch(f.path, "zamolxis/task-1", head)).toThrow(
      "BRANCH_NOT_MANAGED",
    );
    const a = f.provision("a");
    expect(deleteManagedBranch(f.path, a.branch, a.baseSha)).toBe(false);
    expect(deleteManagedBranch(f.path, "zam/repo/missing", head)).toBe(false);
    expect(branches(f.path)).toContain(a.branch);
  });
});
