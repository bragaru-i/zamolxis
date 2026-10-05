import {
  assertRunTransition,
  DomainError,
  type RunStatus,
  type TaskStatus,
} from "@zamolxis/domain";

export function assertCanQueueRun(
  taskStatus: TaskStatus,
  workspaceStatus: string,
  owned: boolean,
): void {
  if (taskStatus !== "ready" || workspaceStatus !== "ready" || owned)
    throw new DomainError("INVALID_STATE", "Task and Workspace must be ready and unowned");
}
export function assertCanCancelTask(status: TaskStatus): void {
  if (["completed", "failed", "cancelled"].includes(status))
    throw new DomainError("INVALID_STATE", "Task is terminal");
}
export function applyRunEvent(status: RunStatus, type: string): RunStatus {
  const transitions: Record<string, RunStatus> = {
    "run.started": "running",
    "run.waiting": "waiting",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.stopped": "stopped",
  };
  const next = transitions[type];
  if (!next) {
    if (!["running", "waiting", "needs_approval"].includes(status))
      throw new DomainError("INVALID_STATE", "Run is not active");
    return status;
  }
  assertRunTransition(status, next);
  return next;
}
export interface TrustEvidence {
  readonly subjectSha: string;
  readonly verifierRunId: string;
  readonly origin: "builder" | "independent-verifier";
  readonly modality: string;
  readonly result: "passed" | "failed";
}
export function evaluateTrust(
  candidateRunId: string,
  candidateSha: string,
  evidence: readonly TrustEvidence[],
  requiredModalities: readonly string[] = ["static", "behavioral"],
): { eligible: boolean; reasons: string[] } {
  const matching = evidence.filter(
    (item) =>
      item.subjectSha === candidateSha &&
      item.origin === "independent-verifier" &&
      item.verifierRunId !== candidateRunId,
  );
  const reasons: string[] = [];
  if (!candidateSha || !requiredModalities.length)
    reasons.push("Missing subject SHA or trust policy");
  if (matching.some((item) => item.result === "failed"))
    reasons.push("Independent verification failed");
  for (const modality of requiredModalities)
    if (!matching.some((item) => item.modality === modality && item.result === "passed"))
      reasons.push(`Missing independent ${modality} evidence`);
  return { eligible: reasons.length === 0, reasons };
}
