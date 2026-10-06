import { existsSync, realpathSync } from "node:fs";
import { git, inspectRepository, type RepositorySnapshot } from "./repository-inspector";

export interface WorktreeRegistration {
  readonly path: string;
  readonly branch?: string;
  readonly headSha: string;
}

export function listWorktrees(repositoryPath: string): WorktreeRegistration[] {
  const records = git(repositoryPath, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
  return records.filter(Boolean).flatMap((record) => {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const headSha = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
    if (!path || !headSha) throw new Error("INVALID_WORKTREE_RECORD");
    // Git retains registrations for missing worktrees until prune/gc. They must not make
    // every healthy workspace fail validation merely because their old path cannot resolve.
    if (!existsSync(path)) return [];
    return [{ path, headSha, ...(branch ? { branch } : {}) }];
  });
}

export function resolveBase(repositoryPath: string, ref: string): string {
  if (ref.startsWith("-") || ref.includes("\0")) throw new Error("INVALID_BASE_REF");
  return git(repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export function validateWorktree(
  repositoryPath: string,
  path: string,
  branch: string,
  commonDir: string,
): RepositorySnapshot {
  const snapshot = inspectRepository(path);
  const registered = listWorktrees(repositoryPath).some(
    (entry) => realpathSync.native(entry.path) === snapshot.path && entry.branch === branch,
  );
  if (snapshot.gitCommonDir !== commonDir || snapshot.branch !== branch || !registered)
    throw new Error("WORKSPACE_IDENTITY_MISMATCH");
  return snapshot;
}

export function createWorktree(
  repositoryPath: string,
  path: string,
  branch: string,
  baseSha: string,
): void {
  git(repositoryPath, ["check-ref-format", "--branch", branch]);
  git(repositoryPath, ["worktree", "add", "-b", branch, "--", path, baseSha]);
}

export function removeWorktree(repositoryPath: string, path: string): void {
  // No force flag: Git provides a final dirty-state/lock check immediately before removal.
  git(repositoryPath, ["worktree", "remove", "--", path]);
}

/**
 * Drops registrations of worktrees whose directory no longer exists. Git itself does this
 * during `gc`; it never removes a directory or a branch.
 */
export function pruneWorktrees(repositoryPath: string): void {
  git(repositoryPath, ["worktree", "prune"]);
}

/**
 * Deletes a Zamolxis-managed branch (`zam/...`) only if it still points at exactly
 * `expectedSha` and no worktree has it checked out. Returns whether it was deleted.
 * User branches and published `zamolxis/*` branches are never candidates.
 */
export function deleteManagedBranch(
  repositoryPath: string,
  branch: string,
  expectedSha: string,
): boolean {
  if (!branch.startsWith("zam/") || !/^[a-f0-9]{40,64}$/.test(expectedSha))
    throw new Error("BRANCH_NOT_MANAGED");
  git(repositoryPath, ["check-ref-format", "--branch", branch]);
  const ref = `refs/heads/${branch}`;
  let tip: string;
  try {
    tip = git(repositoryPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]);
  } catch {
    return false;
  }
  if (tip !== expectedSha) return false;
  if (listWorktrees(repositoryPath).some((entry) => entry.branch === branch)) return false;
  // Compare-and-delete: a branch moved since the check is left alone.
  try {
    git(repositoryPath, ["update-ref", "-d", ref, expectedSha]);
  } catch {
    return false;
  }
  return true;
}

export function workspaceChanges(
  path: string,
  baseSha: string,
): { statusPorcelain: string; commitsSinceBase: string[] } {
  return {
    statusPorcelain: git(path, ["status", "--porcelain=v1", "-z"]),
    commitsSinceBase: git(path, ["rev-list", `${baseSha}..HEAD`])
      .split("\n")
      .filter(Boolean),
  };
}

/** Merge already trusted dependency commits into an isolated task branch. */
export function mergeDependencies(path: string, shas: readonly string[]): void {
  for (const sha of shas) {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("INVALID_DEPENDENCY_SHA");
    git(path, [
      "-c",
      "user.name=Zamolxis",
      "-c",
      "user.email=zamolxis@localhost",
      "merge",
      "--no-edit",
      "--",
      sha,
    ]);
  }
}
/** Runtime edits become a candidate commit only in the assigned managed worktree. */
export function commitCandidate(path: string): string {
  const snapshot = inspectRepository(path);
  if (snapshot.dirty) {
    const files = git(path, ["status", "--porcelain=v1", "-z"]);
    if (/(?:^|\0).{3}(?:.*\/)?(?:\.env(?:\.[^/]*)?|auth\.json|.*\.(?:pem|key))(?:\0|$)/.test(files))
      throw new Error("SENSITIVE_CANDIDATE_FILE");
    git(path, ["add", "--all"]);
    git(path, [
      "-c",
      "user.name=Zamolxis",
      "-c",
      "user.email=zamolxis@localhost",
      "commit",
      "-m",
      "Zamolxis candidate",
    ]);
  }
  return inspectRepository(path).headSha;
}

/** Files added or modified between two commits, relative to the repository root. */
export function addedOrModifiedFiles(path: string, from: string, to: string): string[] {
  if (from === to) return [];
  return git(path, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=AM", from, to])
    .split("\0")
    .filter(Boolean);
}
