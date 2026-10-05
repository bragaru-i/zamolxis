import type {
  AgentRunId,
  ApprovalDecision,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";

// "supervisor" is a Node-local, read-only planning run; it is never reported as a backend agent run.
export type AgentRole = "builder" | "verifier" | "repair" | "supervisor";
export interface RuntimeWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly branch: string;
  readonly headSha: string;
}
export interface StartRunInput {
  readonly runId: AgentRunId;
  readonly workstationId: WorkstationId;
  readonly workspace: RuntimeWorkspace;
  readonly instruction: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly reasoningEffort?: string;
}
export interface ResumeRunInput extends StartRunInput {
  readonly nativeSessionId: string;
}
export type RuntimeState = "running" | "waiting" | "completed" | "failed" | "stopped";
export interface RuntimeSessionSnapshot {
  readonly nativeSessionId: string;
  readonly runId: AgentRunId;
  readonly workspace: RuntimeWorkspace;
  readonly state: RuntimeState;
  readonly lastSequence: number;
}

export interface AgentRuntime {
  readonly id: string;
  capabilities(): RuntimeCapabilitiesDto;
  start(input: StartRunInput): Promise<RuntimeSessionSnapshot>;
  resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot>;
  send(input: { readonly nativeSessionId: string; readonly message: string }): Promise<void>;
  stop(input: { readonly nativeSessionId: string }): Promise<void>;
  /**
   * Settles a pending `approval.requested`. Adapters that never hold operations omit it.
   * Throws APPROVAL_NOT_PENDING for unknown or already settled approvals. Stop and
   * terminal states reject every pending approval; nothing is ever auto-approved.
   */
  resolveApproval?(input: {
    readonly nativeSessionId: string;
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
  }): Promise<void>;
  inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot>;
  subscribe(input: {
    readonly nativeSessionId: string;
    readonly afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto>;
}
