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
  | EventBase<"run.failed", { code?: string; message: string }>;
