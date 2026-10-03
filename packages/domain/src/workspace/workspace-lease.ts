import { DomainError } from "../shared/domain-error";
import type { WorkspaceStatus } from "./workspace-status";

export interface WorkspaceLeaseState {
  readonly status: WorkspaceStatus;
  readonly ownerRunId?: string;
}

export function canAcquireWorkspaceLease(workspace: WorkspaceLeaseState, runId: string): boolean {
  if (workspace.status !== "ready" && workspace.status !== "dirty" && workspace.status !== "in_use") return false;
  return workspace.ownerRunId === undefined || workspace.ownerRunId === runId;
}

export function assertCanAcquireWorkspaceLease(workspace: WorkspaceLeaseState, runId: string): void {
  if (!canAcquireWorkspaceLease(workspace, runId)) {
    throw new DomainError("WORKSPACE_BUSY", "Workspace is not available for this Run");
  }
}
