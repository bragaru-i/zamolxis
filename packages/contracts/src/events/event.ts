import type { AgentRunId, WorkspaceId, WorkstationId } from "../shared/ids";

interface EventBase<T extends string, P> {
  readonly eventId: string;
  readonly type: T;
  readonly workstationId: WorkstationId;
  readonly runId?: AgentRunId;
  readonly workspaceId?: WorkspaceId;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly payload: P;
}

export type ApprovalKind = "command" | "fileChange" | "tool" | "other";
export type ApprovalRisk = "low" | "medium" | "high" | "critical";
export type ApprovalDecision = "approve" | "reject";
// Why a runtime approval was settled: by the user, or rejected by the Node on timeout,
// stop/terminal state, or because the runtime withdrew the request.
export type ApprovalResolutionReason = "user" | "timeout" | "stopped" | "withdrawn";
export const APPROVAL_SUMMARY_LIMIT = 2000;
export const APPROVAL_ID_LIMIT = 256;

export type NormalizedRunEventDto =
  | EventBase<"run.started", { nativeSessionId?: string; activity?: string }>
  | EventBase<
      "run.usage",
      {
        modelActual?: string;
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    >
  | EventBase<"run.activity", { label: string; detail?: string }>
  | EventBase<"tool.started", { tool: string; summary: string }>
  | EventBase<"tool.completed", { tool: string; summary: string; success: boolean }>
  | EventBase<"files.changed", { paths: readonly string[] }>
  | EventBase<"run.waiting", { reason: string }>
  | EventBase<"run.stopped", { reason: string }>
  | EventBase<"run.completed", { summary?: string }>
  | EventBase<"run.failed", { code?: string; message: string }>
  // The runtime holds an operation until a human approves or rejects it.
  | EventBase<
      "approval.requested",
      { approvalId: string; kind: ApprovalKind; summary: string; risk: ApprovalRisk }
    >
  | EventBase<
      "approval.resolved",
      {
        approvalId: string;
        decision: "approved" | "rejected";
        reason: ApprovalResolutionReason;
      }
    >;
