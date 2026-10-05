import { DomainError } from "../shared/domain-error";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "needs_approval"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed"
  | "lost";

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["starting", "stopped", "failed"],
  starting: ["running", "stopping", "failed", "lost"],
  running: ["waiting", "needs_approval", "stopping", "completed", "failed", "lost"],
  waiting: ["running", "needs_approval", "stopping", "completed", "failed", "lost"],
  needs_approval: ["running", "stopping", "failed", "lost"],
  // A run may finish its turn before the interrupt lands.
  stopping: ["stopped", "completed", "failed", "lost"],
  stopped: [],
  completed: [],
  failed: [],
  lost: ["running", "stopped", "failed"],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new DomainError("INVALID_STATE", `Run cannot transition from ${from} to ${to}`);
  }
}
