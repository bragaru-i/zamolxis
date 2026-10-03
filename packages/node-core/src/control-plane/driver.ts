import type { AgentRunId, NormalizedRunEventDto, WorkspaceId } from "@zamolxis/contracts";
import type { RuntimeRegistry } from "@zamolxis/runtime-core";
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
      };
    }
  | {
      readonly type: "runtime.start";
      readonly payload: {
        runId: string;
        workspaceId: string;
        runtime: string;
        instruction: string;
      };
    }
);
export type Delivery =
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
    }
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
      for (const command of await this.transport.listPending()) await this.execute(command);
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
    if (command.type === "workspace.provision") {
      const location = this.store.getRepositoryLocation(command.payload.repositoryLocationId);
      if (
        !location ||
        location.repositoryId !== command.payload.repositoryId ||
        location.workstationId !== this.workstationId
      )
        throw new Error("LOCATION_IDENTITY_MISMATCH");
      const workspace = this.workspaces.provision(command.payload);
      deliveries.push({
        kind: "workspace.ready",
        commandId: command.commandId,
        workspaceId: workspace.workspaceId,
        localPath: workspace.path,
        baseSha: workspace.baseSha,
        branchName: workspace.branch,
        headSha: workspace.headSha ?? workspace.baseSha,
      });
    } else {
      const input = {
        ...command.payload,
        runId: command.payload.runId as AgentRunId,
        workspaceId: command.payload.workspaceId as WorkspaceId,
      };
      const session = await this.manager.start(input);
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
        if (events.length > 100) throw new Error("EVENT_BATCH_LIMIT_EXCEEDED");
        if (["run.waiting", "run.completed", "run.failed", "run.stopped"].includes(event.type))
          break;
      }
      deliveries.push({ kind: "run.events", runId: input.runId, events });
      if (["completed", "failed", "stopped"].includes(session.state)) {
        const workspace = this.workspaces.inspect(input.workspaceId);
        deliveries.push({
          kind: "run.complete",
          runId: input.runId,
          headSha: workspace.headSha ?? workspace.baseSha,
          dirty: workspace.dirty,
          changedFileCount: workspace.statusPorcelain?.split("\0").filter(Boolean).length ?? 0,
        });
      }
    }
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
