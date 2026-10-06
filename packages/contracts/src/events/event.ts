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
export type ApprovalDecision = "approve" | "approve_session" | "reject";
// Why a runtime approval was settled: by the user, or rejected by the Node on timeout,
// stop/terminal state, or because the runtime withdrew the request.
export type ApprovalResolutionReason = "user" | "timeout" | "stopped" | "withdrawn";
export const APPROVAL_SUMMARY_LIMIT = 2000;
export const APPROVAL_ID_LIMIT = 256;
/** Characters of one intermediate agent message (`run.message`). */
export const RUN_MESSAGE_LIMIT = 2000;
/** Files read listed on one tool event, and characters per listed path. */
export const TOOL_READS_LIMIT = 20;
export const TOOL_READ_PATH_LIMIT = 300;

interface ToolPayload {
  readonly tool: string;
  readonly summary: string;
  /**
   * Files the tool call read, as the runtime parsed them (workspace-relative when inside
   * the workspace), redacted and bounded. Absent when unknown.
   */
  readonly reads?: readonly string[];
}

export type NormalizedRunEventDto =
  | EventBase<"run.started", { nativeSessionId?: string; activity?: string }>
  | EventBase<
      "run.usage",
      {
        modelActual?: string;
        inputTokens?: number;
        cachedInputTokens?: number;
        cacheWriteInputTokens?: number;
        outputTokens?: number;
        reasoningOutputTokens?: number;
        totalTokens?: number;
        modelCalls?: number;
      }
    >
  | EventBase<"run.activity", { label: string; detail?: string }>
  | EventBase<"tool.started", ToolPayload>
  | EventBase<"tool.completed", ToolPayload & { success: boolean }>
  // A progress note the agent wrote during its turn (not its final reply, never its
  // reasoning). Redacted and bounded to RUN_MESSAGE_LIMIT characters by the adapter.
  | EventBase<"run.message", { text: string }>
  | EventBase<"files.changed", { paths: readonly string[] }>
  | EventBase<"run.waiting", { reason: string }>
  | EventBase<"run.stopped", { reason: string }>
  | EventBase<"run.completed", { summary?: string }>
  | EventBase<"run.failed", { code?: string; message: string }>
  // The runtime holds an operation until a human approves or rejects it.
  | EventBase<
      "approval.requested",
      {
        approvalId: string;
        kind: ApprovalKind;
        summary: string;
        risk: ApprovalRisk;
        /** The runtime can remember this low/medium approval for the current run. */
        allowForSession?: boolean;
      }
    >
  | EventBase<
      "approval.resolved",
      {
        approvalId: string;
        decision: "approved" | "rejected";
        reason: ApprovalResolutionReason;
      }
    >;
