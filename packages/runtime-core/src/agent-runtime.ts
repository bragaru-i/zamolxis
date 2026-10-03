import type {
  AgentRunId,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";

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
  inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot>;
  subscribe(input: {
    readonly nativeSessionId: string;
    readonly afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto>;
}
