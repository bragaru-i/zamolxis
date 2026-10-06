import type { RuntimeId } from "../runtime/runtime";
import type { AgentRunId, CommandId, RepositoryId, TaskId, WorkspaceId } from "../shared/ids";

interface CommandBase<T extends string, P> {
  readonly commandId: CommandId;
  readonly idempotencyKey: string;
  readonly type: T;
  readonly payload: P;
  readonly createdAt: number;
}

export type ZamolxisCommandDto =
  | CommandBase<"repository.verify", { repositoryId: RepositoryId }>
  | CommandBase<"workspace.provision", { workspaceId: WorkspaceId; baseRef: string }>
  | CommandBase<"workspace.cleanup", { workspaceId: WorkspaceId }>
  | CommandBase<
      "runtime.start",
      {
        runId: AgentRunId;
        taskId: TaskId;
        workspaceId: WorkspaceId;
        runtime: RuntimeId;
        instruction: string;
      }
    >
  | CommandBase<
      "runtime.resume",
      { runId: AgentRunId; workspaceId: WorkspaceId; nativeSessionId: string }
    >
  | CommandBase<"runtime.send", { runId: AgentRunId; message: string }>
  | CommandBase<"runtime.stop", { runId: AgentRunId }>
  | CommandBase<
      "runtime.approval",
      {
        runId: AgentRunId;
        approvalId: string;
        decision: "approve" | "approve_session" | "reject";
      }
    >
  | CommandBase<"node.reconcile", { reason: "connect" | "requested" | "recovery" }>;
