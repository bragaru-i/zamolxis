import { createHash } from "node:crypto";
import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import type { AgentRole, RuntimeRegistry, RuntimeSessionSnapshot } from "@zamolxis/runtime-core";
import type { LocalStateStore } from "../persistence/local-state";
import type { WorkspaceManager } from "../workspace/workspace-manager";

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
