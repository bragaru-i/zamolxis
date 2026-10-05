import type {
  AgentRunId,
  RepositoryId,
  RepositoryLocationId,
  WorkspaceId,
  WorkstationId,
} from "../shared/ids";

export type WorkspaceKind = "canonical" | "worktree" | "integration";
export type WorkspaceStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "in_use"
  | "dirty"
  | "integrating"
  | "completed"
  | "cleanup_pending"
  | "removed"
  | "error";

export interface WorkspaceSnapshotDto {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly repositoryLocationId: RepositoryLocationId;
  readonly workstationId: WorkstationId;
  readonly kind: WorkspaceKind;
  readonly status: WorkspaceStatus;
  readonly localPath: string;
  readonly branchName?: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly dirty: boolean;
  readonly changedFileCount: number;
  readonly ownerRunId?: AgentRunId;
}
