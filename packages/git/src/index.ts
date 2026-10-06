export interface GitRepositorySnapshot {
  readonly headSha: string;
  readonly branchName?: string;
}
export * from "./publish";
export * from "./repository-inspector";
export * from "./worktree-manager";
