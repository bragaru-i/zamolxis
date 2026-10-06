import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  createWorktree,
  deleteManagedBranch,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  resolveBase,
  validateWorktree,
  workspaceChanges,
} from "@zamolxis/git";
import type { LocalStateStore, ManagedWorkspace } from "../persistence/local-state";
import type { RepositoryRegistry } from "../repository/repository-registry";

export interface ProvisionWorkspace {
  readonly workspaceId: string;
  readonly repositoryLocationId: string;
  readonly baseRef: string;
  readonly kind?: "worktree" | "integration";
}
export interface CleanupPolicy {
  readonly artifactsCaptured: boolean;
  readonly integrationPending: boolean;
  readonly retentionAllows: boolean;
}
export interface CleanupOptions {
  /** Delete the worktree's `zam/...` branch only if it still points at this commit. */
  readonly deleteBranchAt?: string;
}
export interface CleanupResult {
  readonly branchDeleted: boolean;
}
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("INVALID_WORKSPACE_ID");
  return id;
}

function canonicalDestination(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  return join(canonicalDestination(dirname(path)), basename(path));
}

export class WorkspaceManager {
  readonly #root: string;
  constructor(
    private readonly store: LocalStateStore,
    private readonly repositories: RepositoryRegistry,
    root: string,
    private readonly nodeInstanceId: string,
    private readonly isGranted: (path: string) => boolean,
  ) {
    if (!isGranted(resolve(root))) throw new Error("WORKSPACE_ROOT_DENIED");
    const destination = canonicalDestination(resolve(root));
    if (!isGranted(destination)) throw new Error("WORKSPACE_ROOT_DENIED");
    mkdirSync(destination, { recursive: true });
    this.#root = realpathSync.native(destination);
    if (!isGranted(this.#root)) throw new Error("WORKSPACE_ROOT_DENIED");
  }

  provision(input: ProvisionWorkspace): ManagedWorkspace {
    const location = this.repositories.verify(input.repositoryLocationId);
    const directory = join(this.#root, safeId(location.repositoryId));
    if (!this.isGranted(directory)) throw new Error("WORKSPACE_DENIED");
    mkdirSync(directory, { recursive: true });
    if (realpathSync.native(directory) !== directory) throw new Error("WORKSPACE_PATH_REDIRECTED");
    const path = join(directory, safeId(input.workspaceId));
    const branch = `zam/${location.repositoryId}/${input.workspaceId}`;
    const previous = this.store.getManagedWorkspace(input.workspaceId);
    if (previous) {
      if (
        previous.path !== path ||
        previous.branch !== branch ||
        previous.repositoryLocationId !== input.repositoryLocationId ||
        previous.baseRef !== input.baseRef ||
        previous.kind !== (input.kind ?? "worktree") ||
        previous.status === "removed"
      ) {
        throw new Error("WORKSPACE_REQUEST_CONFLICT");
      }
      if (existsSync(path)) return this.inspect(input.workspaceId);
      if (previous.status !== "provisioning") throw new Error("WORKSPACE_MISSING");
    } else if (existsSync(path)) throw new Error("UNOWNED_WORKSPACE_PATH");
    const workspace: ManagedWorkspace = previous ?? {
      workspaceId: input.workspaceId,
      repositoryLocationId: input.repositoryLocationId,
      repositoryId: location.repositoryId,
      path,
      branch,
      baseRef: input.baseRef,
      baseSha: resolveBase(location.path, input.baseRef),
      kind: input.kind ?? "worktree",
      dirty: false,
      status: "provisioning",
    };
    this.store.saveManagedWorkspace(workspace);
    createWorktree(location.path, path, branch, workspace.baseSha);
    return this.inspect(input.workspaceId);
  }

  inspect(id: string): ManagedWorkspace {
    const workspace = this.#get(id);
    const location = this.repositories.verify(workspace.repositoryLocationId);
    try {
      if (!this.isGranted(workspace.path)) throw new Error("WORKSPACE_DENIED");
      const snapshot = validateWorktree(
        location.path,
        workspace.path,
        workspace.branch,
        location.gitCommonDir,
      );
      if (snapshot.path !== workspace.path) throw new Error("WORKSPACE_PATH_REDIRECTED");
      const updated = {
        ...workspace,
        ...workspaceChanges(workspace.path, workspace.baseSha),
        headSha: snapshot.headSha,
        dirty: snapshot.dirty,
        status: this.store.getWorkspaceLease(id) ? "in_use" : snapshot.dirty ? "dirty" : "ready",
      };
      this.store.saveManagedWorkspace(updated);
      return updated;
    } catch (error) {
      this.store.saveManagedWorkspace({ ...workspace, status: "error" });
      throw error;
    }
  }

  acquire(id: string, runId: string, cwd: string, branch: string): ManagedWorkspace {
    const workspace = this.inspect(id);
    if (realpathSync.native(cwd) !== workspace.path || branch !== workspace.branch)
      throw new Error("RUN_WORKSPACE_MISMATCH");
    this.store.acquireWorkspaceLease(id, runId, this.nodeInstanceId);
    return this.inspect(id);
  }

  release(id: string, runId: string): ManagedWorkspace {
    this.store.releaseWorkspaceLease(id, runId, this.nodeInstanceId);
    return this.inspect(id);
  }

  /**
   * Removes a clean managed worktree (never forced), prunes stale worktree registrations and,
   * only when the backend names the exact commit, deletes the worktree's own `zam/...` branch.
   */
  cleanup(id: string, policy: CleanupPolicy, options: CleanupOptions = {}): CleanupResult {
    const workspace = this.#get(id);
    if (workspace.status === "removed") return { branchDeleted: false };
    if (!policy.artifactsCaptured || policy.integrationPending || !policy.retentionAllows)
      throw new Error("CLEANUP_DENIED");
    // Claim the same lock used by runtime start so another Node cannot start a Run during cleanup.
    const cleanupRun = `cleanup:${id}`;
    this.store.acquireWorkspaceLease(id, cleanupRun, this.nodeInstanceId);
    try {
      const location = this.repositories.verify(workspace.repositoryLocationId);
      let removed: ManagedWorkspace;
      if (!existsSync(workspace.path)) {
        // Deleted outside Zamolxis: nothing on disk to preserve, only Git's registration.
        pruneWorktrees(location.path);
        if (listWorktrees(location.path).some((entry) => entry.path === workspace.path))
          throw new Error("WORKSPACE_MISSING");
        removed = { ...workspace, status: "removed" };
      } else {
        const checked = this.inspect(id);
        if (checked.dirty) throw new Error("DIRTY_WORKSPACE_PRESERVED");
        removeWorktree(location.path, checked.path);
        pruneWorktrees(location.path);
        removed = { ...checked, status: "removed" };
      }
      this.store.saveManagedWorkspace(removed);
      const branchDeleted =
        options.deleteBranchAt !== undefined &&
        removed.branch === `zam/${removed.repositoryId}/${removed.workspaceId}` &&
        deleteManagedBranch(location.path, removed.branch, options.deleteBranchAt);
      return { branchDeleted };
    } finally {
      this.store.releaseWorkspaceLease(id, cleanupRun, this.nodeInstanceId);
    }
  }

  reconcile(): Array<{ workspaceId: string; status: string; staleLease: boolean }> {
    return this.store.listManagedWorkspaces().map((workspace) => {
      const lease = this.store.getWorkspaceLease(workspace.workspaceId);
      if (workspace.status === "removed")
        return { workspaceId: workspace.workspaceId, status: "removed", staleLease: false };
      let status: string;
      try {
        status = this.inspect(workspace.workspaceId).status;
      } catch {
        status = "error";
      }
      return {
        workspaceId: workspace.workspaceId,
        status,
        staleLease: !!lease && lease.nodeInstanceId !== this.nodeInstanceId,
      };
    });
  }

  releaseStaleLease(id: string, isRunStopped: (runId: string) => boolean): void {
    const lease = this.store.getWorkspaceLease(id);
    if (!lease || lease.nodeInstanceId === this.nodeInstanceId || !isRunStopped(lease.runId))
      throw new Error("LEASE_NOT_RECONCILED");
    this.store.releaseWorkspaceLease(id, lease.runId, lease.nodeInstanceId);
    this.inspect(id);
  }

  listUnownedWorktrees(repositoryLocationId: string): string[] {
    const location = this.repositories.verify(repositoryLocationId);
    const owned = new Set(this.store.listManagedWorkspaces().map((workspace) => workspace.path));
    return listWorktrees(location.path)
      .filter((entry) => entry.path !== location.path && !owned.has(entry.path))
      .map((entry) => entry.path);
  }

  #get(id: string): ManagedWorkspace {
    const workspace = this.store.getManagedWorkspace(id);
    if (!workspace) throw new Error("WORKSPACE_NOT_REGISTERED");
    return workspace;
  }
}
