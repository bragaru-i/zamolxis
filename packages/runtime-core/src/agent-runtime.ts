import type {
  AgentRunId,
  ApprovalDecision,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import type { RuntimeModelDto } from "./models";

// "supervisor" is a Node-local, read-only planning run; it is never reported as a backend agent run.
export type AgentRole = "builder" | "verifier" | "repair" | "supervisor";
export interface RuntimeWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly cwd: string;
  readonly branch: string;
  readonly headSha: string;
  // Directories the Node prepared for this worktree (e.g. the repository's pinned pnpm),
  // put first on the agent's PATH so ordinary commands work without the network.
  readonly toolPaths?: readonly string[];
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
/**
 * Cumulative usage counters of a run, each reported by the provider and never decreasing.
 * `inputTokens` counts every input token the model processed, cached ones included;
 * `cachedInputTokens` is the cache-read part of it and `cacheWriteInputTokens` the part
 * written to the cache; `reasoningOutputTokens` is the reasoning part of `outputTokens`;
 * `totalTokens` is input plus output; `modelCalls` counts model responses (one per usage
 * report). Adapters emit the counters their provider reports; the rest stay absent.
 */
export const USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "modelCalls",
] as const;
/** Counters Codex reports with every usage update; the others are optional. */
export const REQUIRED_USAGE_COUNTERS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "totalTokens",
] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];
/**
 * What a resumed session does with a turn the restart interrupted: start a new turn on the
 * same native session that continues the original task, report it failed, or report it
 * stopped (a stop was requested before the restart).
 */
export type InterruptedTurnPolicy = "continue" | "fail" | "stop";
/**
 * Reattaches a run to its native session in a new Node process (for example after a
 * restart). The Node supplies what it durably recorded so the resumed event stream never
 * duplicates or contradicts what the control plane has already seen.
 */
export interface ResumeRunInput extends StartRunInput {
  readonly nativeSessionId: string;
  /** Last event sequence the Node recorded; resumed events continue after it. */
  readonly afterSequence?: number;
  /** Emit `run.started` first: the control plane never saw it or reported the run lost. */
  readonly announce?: boolean;
  /**
   * Approvals requested before the restart and not settled. Their native requests died
   * with the old process: each is reported `approval.resolved` rejected ("withdrawn")
   * before anything else; the agent must ask again.
   */
  readonly pendingApprovalIds?: readonly string[];
  /** Default "fail". */
  readonly interrupted?: InterruptedTurnPolicy;
  /** Usage already reported for the run, so resumed totals never go backwards. */
  readonly usage?: Partial<Record<UsageCounter, number>>;
}
/** The message a continuation turn sends after a restart interrupted the previous turn. */
export const RESTART_CONTINUATION =
  "Zamolxis restarted while you were working, so your previous turn was interrupted: any command that was still running was stopped and any approval you were waiting for was rejected. Check the current state of the workspace, then continue and finish the original task. Ask again for any approval you still need.";
export const RESTART_INTERRUPTED_CODE = "NODE_RESTART_INTERRUPTED";
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
  /**
   * Reattaches to a native session, in this process (a no-op returning its snapshot) or
   * after the process that ran it ended. Adapters that cannot resume advertise
   * `canResume: false` and throw. A session whose native state is uncertain (for example
   * still running elsewhere) throws RECONCILIATION_REQUIRED; it is never started again.
   */
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
  /**
   * The models this runtime offers, bounded by RUNTIME_MODEL_LIMITS. Adapters that cannot
   * enumerate models omit it. Throws on failure; callers keep their previous list.
   */
  listModels?(): Promise<RuntimeModelDto[]>;
  subscribe(input: {
    readonly nativeSessionId: string;
    readonly afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto>;
}
