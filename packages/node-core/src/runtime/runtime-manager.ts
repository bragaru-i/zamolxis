import { createHash } from "node:crypto";
import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import type {
  AgentRole,
  ResumeRunInput,
  RuntimeRegistry,
  RuntimeSessionSnapshot,
} from "@zamolxis/runtime-core";
import type { LocalStateStore } from "../persistence/local-state";
import type { WorkspaceManager } from "../workspace/workspace-manager";

const TERMINAL = ["completed", "failed", "stopped"];

export interface StartAssignedRun {
  readonly runId: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly runtime: string;
  readonly instruction: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly role?: AgentRole;
}
export class RuntimeManager {
  constructor(
    private readonly store: LocalStateStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runtimes: RuntimeRegistry,
    private readonly workstationId: WorkstationId,
    private readonly isAllowed: (runtime: string) => boolean,
  ) {}
  async observe(runId: string): Promise<RuntimeSessionSnapshot> {
    const stored = this.store.getRuntimeSession(runId);
    if (!stored?.nativeSessionId) throw new Error("RECONCILIATION_REQUIRED");
    const snapshot = await this.runtimes.get(stored.runtime).inspect(stored.nativeSessionId);
    this.store.upsertRuntimeSession({ ...stored, status: snapshot.state });
    if (["completed", "failed", "stopped"].includes(snapshot.state)) {
      const lease = this.store.getWorkspaceLease(stored.workspaceId);
      if (lease?.runId === runId) this.workspaces.release(stored.workspaceId, runId);
    }
    return snapshot;
  }

  /**
   * Reattaches a run to its native session after this Node restarted. The run keeps its
   * workspace: the lease a previous Node instance held for it is taken over, never one held
   * for another run. The runtime is never started again.
   */
  async resume(
    runId: string,
    options: Omit<
      ResumeRunInput,
      "runId" | "workstationId" | "workspace" | "nativeSessionId" | "instruction"
    > & { readonly instruction: string },
  ): Promise<RuntimeSessionSnapshot> {
    const stored = this.store.getRuntimeSession(runId);
    if (!stored?.nativeSessionId) throw new Error("RECONCILIATION_REQUIRED");
    const runtime = this.runtimes.resolve(
      { mode: "forced", runtime: stored.runtime },
      ["canResume"],
      this.isAllowed,
    );
    const workspace = this.#adopt(stored.workspaceId, runId);
    const snapshot = await runtime.resume({
      ...options,
      runId: runId as AgentRunId,
      workstationId: this.workstationId,
      nativeSessionId: stored.nativeSessionId,
      workspace: {
        workspaceId: stored.workspaceId as WorkspaceId,
        cwd: workspace.path,
        branch: workspace.branch,
        headSha: workspace.headSha ?? workspace.baseSha,
      },
    });
    if (snapshot.runId !== runId || snapshot.nativeSessionId !== stored.nativeSessionId)
      throw new Error("RUNTIME_REQUEST_CONFLICT");
    this.store.upsertRuntimeSession({ ...stored, status: snapshot.state });
    if (TERMINAL.includes(snapshot.state)) this.workspaces.release(stored.workspaceId, runId);
    return snapshot;
  }
  /**
   * Records an outcome the runtime already reported before a restart (no native session is
   * needed) and releases the run's workspace.
   */
  settle(runId: string, state: "completed" | "failed" | "stopped"): void {
    const stored = this.store.getRuntimeSession(runId);
    if (!stored) throw new Error("RECONCILIATION_REQUIRED");
    this.store.upsertRuntimeSession({ ...stored, status: state });
    if (this.store.getWorkspaceLease(stored.workspaceId)?.runId !== runId) return;
    this.#adopt(stored.workspaceId, runId);
    this.workspaces.release(stored.workspaceId, runId);
  }
  // Takes over the run's lease from a previous Node instance (or acquires it again).
  #adopt(workspaceId: string, runId: string) {
    const lease = this.store.getWorkspaceLease(workspaceId);
    if (lease && lease.runId !== runId) throw new Error("WORKSPACE_BUSY");
    if (lease) {
      try {
        this.workspaces.releaseStaleLease(workspaceId, (owner) => owner === runId);
      } catch (error) {
        // Already held by this instance.
        if (!(error instanceof Error) || error.message !== "LEASE_NOT_RECONCILED") throw error;
        return this.workspaces.inspect(workspaceId);
      }
    }
    const workspace = this.workspaces.inspect(workspaceId);
    return this.workspaces.acquire(workspaceId, runId, workspace.path, workspace.branch);
  }

  async start(input: StartAssignedRun): Promise<RuntimeSessionSnapshot> {
    const runtime = this.runtimes.resolve(
      { mode: "forced", runtime: input.runtime },
      ["canStart"],
      this.isAllowed,
    );
    const instructionDigest = createHash("sha256")
      .update(
        JSON.stringify([
          input.workspaceId,
          input.runtime,
          input.instruction,
          input.model,
          input.reasoningEffort,
          input.role,
        ]),
      )
      .digest("hex");
    const previous = this.store.getRuntimeSession(input.runId);
    if (previous) {
      if (previous.workspaceId !== input.workspaceId || previous.runtime !== input.runtime)
        throw new Error("RUNTIME_REQUEST_CONFLICT");
      if (!previous.instructionDigest) throw new Error("RECONCILIATION_REQUIRED");
      if (previous.instructionDigest !== instructionDigest)
        throw new Error("RUNTIME_REQUEST_CONFLICT");
      this.workspaces.inspect(input.workspaceId);
      if (!previous.nativeSessionId) throw new Error("RECONCILIATION_REQUIRED");
      // Never replay start when persisted session metadata exists but the native session cannot be inspected.
      return runtime.inspect(previous.nativeSessionId);
    }
    const workspace = this.workspaces.inspect(input.workspaceId);
    this.workspaces.acquire(input.workspaceId, input.runId, workspace.path, workspace.branch);
    if (
      !this.store.reserveRuntimeSession({
        runId: input.runId,
        workspaceId: input.workspaceId,
        runtime: input.runtime,
        status: "starting",
        instructionDigest,
      })
    ) {
      throw new Error("RECONCILIATION_REQUIRED");
    }
    const session = await runtime.start({
      runId: input.runId,
      workstationId: this.workstationId,
      instruction: input.instruction,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.role ? { role: input.role } : {}),
      workspace: {
        workspaceId: input.workspaceId,
        cwd: workspace.path,
        branch: workspace.branch,
        headSha: workspace.headSha ?? workspace.baseSha,
      },
    });
    this.store.upsertRuntimeSession({
      runId: input.runId,
      workspaceId: input.workspaceId,
      runtime: input.runtime,
      nativeSessionId: session.nativeSessionId,
      status: session.state,
      instructionDigest,
    });
    if (["completed", "failed", "stopped"].includes(session.state))
      this.workspaces.release(input.workspaceId, input.runId);
    return session;
  }
}
