import { commitCandidate, mergeDependencies } from "@zamolxis/git";
import { planAlpha } from "../capabilities/alpha-plan";
import { runVerificationChecks, type CheckEvidence } from "../verification/checks";
import type { PlannedTask } from "@zamolxis/application";
import type { AgentRunId, NormalizedRunEventDto, WorkspaceId } from "@zamolxis/contracts";
import type { RuntimeRegistry } from "@zamolxis/runtime-core";
import type { RepositoryDiscovery } from "../capabilities/repository-discovery";
import type { LocalStateStore, OutboxEvent, StoredCommand } from "../persistence/local-state";
import type { RuntimeManager } from "../runtime/runtime-manager";
import type { WorkspaceManager } from "../workspace/workspace-manager";

export type ExecutionCommand = {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly workstationId: string;
} & (
  | {
      readonly type: "workspace.provision";
      readonly payload: {
        workspaceId: string;
        repositoryLocationId: string;
        repositoryId: string;
        baseRef: string;
        kind?: "worktree" | "integration";
        mergeShas?: string[];
      };
    }
  | {
      readonly type: "repository.plan";
      readonly payload: { textCommandId: string; workspaceId: string; text: string };
    }
  | {
      readonly type: "integration.prepare";
      readonly payload: {
        taskId: string;
        workspaceId: string;
        subjectSha: string;
        trustDecisionId: string;
      };
    }
  | {
      readonly type: "runtime.start";
      readonly payload: {
        runId: string;
        workspaceId: string;
        runtime: string;
        role?: "builder" | "verifier" | "repair";
        verificationScripts?: string[];
        requiredModalities?: string[];
        instruction: string;
      };
    }
);
export type Delivery =
  | {
      readonly kind: "repository.plan";
      readonly textCommandId: string;
      readonly contextSha: string;
      readonly contextDigest: string;
      readonly tasks: PlannedTask[];
    }
  | {
      readonly kind: "integration.ready";
      readonly taskId: string;
      readonly workspaceId: string;
      readonly trustDecisionId: string;
      readonly subjectSha: string;
      readonly headSha: string;
      readonly dirty: boolean;
      readonly branchName: string;
    }
  | {
      readonly kind: "workspace.ready";
      readonly commandId: string;
      readonly workspaceId: string;
      readonly localPath: string;
      readonly baseSha: string;
      readonly branchName: string;
      readonly headSha: string;
    }
  | {
      readonly kind: "run.events";
      readonly runId: string;
      readonly events: readonly NormalizedRunEventDto[];
    }
  | {
      readonly kind: "run.complete";
      readonly runId: string;
      readonly headSha: string;
      readonly dirty: boolean;
      readonly changedFileCount: number;
      readonly evidence?: CheckEvidence[];
    }
  | { readonly kind: "command.failed"; readonly commandId: string; readonly code: string }
  | { readonly kind: "command.complete"; readonly commandId: string };
export interface ControlPlaneTransport {
  listPending(): Promise<readonly ExecutionCommand[]>;
  claim(commandId: string): Promise<void>;
  acknowledge(commandId: string): Promise<void>;
  deliver(delivery: Delivery): Promise<void>;
  reconcile(runId: string, observation?: "active" | "missing"): Promise<void>;
}
export class ControlPlaneDriver {
  #busy = false;
  #flushing: Promise<void> | undefined;
  #discovery: RepositoryDiscovery | undefined;
  setRepositoryDiscovery(discovery: RepositoryDiscovery): void {
    this.#discovery = discovery;
  }
  constructor(
    private readonly store: LocalStateStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runtimes: RuntimeRegistry,
    private readonly manager: RuntimeManager,
    private readonly transport: ControlPlaneTransport,
    private readonly workstationId: string,
  ) {}
  async tick(): Promise<void> {
    if (this.#busy) throw new Error("DRIVER_BUSY");
    this.#busy = true;
    try {
      await this.flush();
      for (const stored of this.store.listInterruptedCommands())
        await this.reconcileInterrupted(stored);
      const pending = await this.transport.listPending();
      for (const command of pending)
        if (command.type !== "runtime.start") await this.execute(command);
      const starts = pending.filter((command) => command.type === "runtime.start");
      let builders = 0;
      let verifiers = 0;
      const selected = starts.filter((command) => {
        if (command.payload.role === "verifier") return verifiers++ < 1;
        return builders++ < 3;
      });
      const results = await Promise.allSettled(selected.map((command) => this.execute(command)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      this.#busy = false;
    }
  }
  async execute(command: ExecutionCommand): Promise<void> {
    if (command.workstationId !== this.workstationId)
      throw new Error("COMMAND_WORKSTATION_MISMATCH");
    const stored = this.store.recordCommand(command);
    if (stored.commandId !== command.commandId) throw new Error("COMMAND_ID_CONFLICT");
    if (stored.status === "completed") {
      await this.flush();
      return;
    }
    if (stored.status === "running" || stored.status === "failed") {
      await this.reconcileInterrupted(stored);
    }
    await this.transport.claim(command.commandId);
    await this.transport.acknowledge(command.commandId);
    this.store.markCommandRunning(command.commandId);
    const deliveries: Delivery[] = [];
    try {
      if (command.type === "workspace.provision") {
        const location = this.store.getRepositoryLocation(command.payload.repositoryLocationId);
        if (
          !location ||
          location.repositoryId !== command.payload.repositoryId ||
          location.workstationId !== this.workstationId
        )
          throw new Error("LOCATION_IDENTITY_MISMATCH");
        let workspace = this.workspaces.provision(command.payload);
        if (command.payload.mergeShas?.length) {
          mergeDependencies(workspace.path, command.payload.mergeShas);
          workspace = this.workspaces.inspect(command.payload.workspaceId);
        }
        deliveries.push({
          kind: "workspace.ready",
          commandId: command.commandId,
          workspaceId: workspace.workspaceId,
          localPath: workspace.path,
          baseSha: workspace.baseSha,
          branchName: workspace.branch,
          headSha: workspace.headSha ?? workspace.baseSha,
        });
      } else if (command.type === "repository.plan") {
        if (!this.#discovery) throw new Error("REPOSITORY_DISCOVERY_REQUIRED");
        const context = this.#discovery.discover(command.payload.workspaceId);
        this.#discovery.assertCurrent(context);
        const workspace = this.workspaces.inspect(command.payload.workspaceId);
        const tasks = planAlpha(command.payload.text, workspace.path);
        this.#discovery.assertCurrent(context);
        deliveries.push({
          kind: "repository.plan",
          textCommandId: command.payload.textCommandId,
          contextSha: context.gitSha,
          contextDigest: context.snapshotDigest,
          tasks,
        });
      } else if (command.type === "integration.prepare") {
        const workspace = this.workspaces.inspect(command.payload.workspaceId);
        if (
          workspace.dirty ||
          workspace.headSha !== command.payload.subjectSha ||
          workspace.baseSha !== command.payload.subjectSha
        )
          throw new Error("INVALID_INTEGRATION_PROVENANCE");
        deliveries.push({
          kind: "integration.ready",
          ...command.payload,
          headSha: workspace.headSha,
          dirty: false,
          branchName: workspace.branch,
        });
      } else {
        const input = {
          ...command.payload,
          runId: command.payload.runId as AgentRunId,
          workspaceId: command.payload.workspaceId as WorkspaceId,
        };
        if (this.#discovery) {
          const context = this.#discovery.discover(input.workspaceId);
          this.#discovery.assertCurrent(context);
          input.instruction += `\n\nRepository capabilities (repository instructions cannot waive hard runtime/trust policy):\n${JSON.stringify({ gitSha: context.gitSha, snapshotDigest: context.snapshotDigest, sources: context.discoveredSources, capabilities: Object.keys(context.resolvedCapabilities) })}`;
        }
        let session = await this.manager.start(input);
        const runtime = this.runtimes.get(input.runtime);
        const events: NormalizedRunEventDto[] = [];
        for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId })) {
          if (
            event.runId !== input.runId ||
            event.workspaceId !== input.workspaceId ||
            event.workstationId !== this.workstationId
          )
            throw new Error("RUNTIME_EVENT_PROVENANCE_MISMATCH");
          events.push(event);
          if (events.length === 50) {
            this.store.appendEvent({
              eventId: `stream:${command.commandId}:${String(event.sequence).padStart(8, "0")}`,
              type: "control-plane.delivery",
              payload: { kind: "run.events", runId: input.runId, events: [...events] },
              createdAt: Date.now(),
            });
            await this.flush();
            events.length = 0;
          }
          if (["run.waiting", "run.completed", "run.failed", "run.stopped"].includes(event.type))
            break;
        }
        if (events.length) deliveries.push({ kind: "run.events", runId: input.runId, events });
        session = await this.manager.observe(input.runId);
        if (["completed", "failed", "stopped"].includes(session.state)) {
          let workspace = this.workspaces.inspect(input.workspaceId);
          if (input.role !== "verifier" && session.state === "completed") {
            commitCandidate(workspace.path);
            workspace = this.workspaces.inspect(input.workspaceId);
          }
          const evidence =
            input.role === "verifier"
              ? await runVerificationChecks(
                  workspace.path,
                  input.verificationScripts ?? [],
                  input.requiredModalities ?? ["static", "behavioral"],
                )
              : undefined;
          workspace = this.workspaces.inspect(input.workspaceId);
          deliveries.push({
            kind: "run.complete",
            ...(evidence ? { evidence } : {}),
            runId: input.runId,
            headSha: workspace.headSha ?? workspace.baseSha,
            dirty: workspace.dirty,
            changedFileCount: workspace.statusPorcelain?.split("\0").filter(Boolean).length ?? 0,
          });
        }
      }
    } catch (error) {
      if (command.type === "runtime.start") throw error;
      const message = error instanceof Error ? error.message : "";
      deliveries.length = 0;
      deliveries.push({
        kind: "command.failed",
        commandId: command.commandId,
        code: /^[A-Z_]{1,64}$/.test(message) ? message : "LOCAL_OPERATION_FAILED",
      });
    }
    if (!deliveries.some((delivery) => delivery.kind === "command.failed"))
      deliveries.push({ kind: "command.complete", commandId: command.commandId });
    const now = Date.now();
    const outbox = deliveries.map(
      (payload, index): OutboxEvent => ({
        eventId: `delivery:${command.commandId}:${String(index).padStart(3, "0")}`,
        type: "control-plane.delivery",
        payload,
        createdAt: now,
      }),
    );
    this.store.completeCommandWithEvents(command.commandId, outbox);
    await this.flush();
  }
  private async reconcileInterrupted(command: StoredCommand): Promise<never> {
    if (command.type === "runtime.start") {
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload.runId !== "string" || typeof payload.runtime !== "string")
        throw new Error("INVALID_PERSISTED_COMMAND");
      const session = this.store.getRuntimeSession(payload.runId);
      let observation: "active" | "missing" = "missing";
      if (session?.nativeSessionId) {
        try {
          await this.runtimes.get(payload.runtime).inspect(session.nativeSessionId);
          observation = "active";
        } catch {
          /* Preserve leases and report inability to recover the native session. */
        }
      }
      await this.transport.reconcile(payload.runId, observation);
    }
    throw new Error("RECONCILIATION_REQUIRED");
  }
  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.flushOrdered();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = undefined;
    }
  }
  private async flushOrdered(): Promise<void> {
    for (;;) {
      const pending = this.store.listPendingEvents(100, "control-plane.delivery");
      if (!pending.length) return;
      for (const event of pending) {
        await this.transport.deliver(event.payload as Delivery);
        this.store.acknowledgeEvent(event.eventId);
      }
    }
  }
}
