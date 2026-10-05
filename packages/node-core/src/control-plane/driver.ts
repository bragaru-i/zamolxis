import type { PlannedTask } from "@zamolxis/application";
import type { AgentRunId, NormalizedRunEventDto, WorkspaceId } from "@zamolxis/contracts";
import { commitCandidate, mergeDependencies } from "@zamolxis/git";
import type { AgentRuntime, RuntimeRegistry } from "@zamolxis/runtime-core";
import type { RepositoryDiscovery } from "../capabilities/repository-discovery";
import {
  type ConversationMessage,
  explicitPlan,
  parseSupervisorDecision,
  REPLY_LIMIT,
  repositoryChecks,
  type SupervisorDecision,
  type SupervisorDecisionKind,
  supervisorInstruction,
} from "../capabilities/supervisor";
import type { LocalStateStore, OutboxEvent, StoredCommand } from "../persistence/local-state";
import type { RuntimeManager } from "../runtime/runtime-manager";
import { type CheckEvidence, runVerificationChecks } from "../verification/checks";
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
      readonly payload: {
        textCommandId: string;
        workspaceId: string;
        text: string;
        // Absent when an older backend sends the command.
        supervisor?: SupervisorSelection;
        conversation?: ConversationMessage[];
      };
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
  | { readonly type: "runtime.stop"; readonly payload: { runId: string } }
  | { readonly type: "runtime.send"; readonly payload: { runId: string; message: string } }
  | {
      readonly type: "runtime.approval";
      readonly payload: { runId: string; approvalId: string; decision: "approve" | "reject" };
    }
  | { readonly type: "workspace.cleanup"; readonly payload: { workspaceId: string } }
  // A command this Node cannot parse fails on its own instead of blocking the queue.
  | { readonly type: "invalid"; readonly payload: { code: string } }
);
const TERMINAL = ["completed", "failed", "stopped"];
// Events after which a run needs something from outside (a message or nothing at all).
const PAUSE = ["run.waiting", "run.completed", "run.failed", "run.stopped"];
// Commands that continue a run: they own its event stream unless another command does.
type RunCommand = Extract<
  ExecutionCommand,
  { type: "runtime.start" | "runtime.send" | "runtime.approval" }
>;
function continuesRun(command: ExecutionCommand): command is RunCommand {
  return (
    command.type === "runtime.start" ||
    command.type === "runtime.send" ||
    command.type === "runtime.approval"
  );
}
interface RunContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly runtime: string;
  readonly role?: "builder" | "verifier" | "repair";
  readonly verificationScripts?: string[];
  readonly requiredModalities?: string[];
}
export interface SupervisorSelection {
  readonly runtime: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}
export interface SupervisorUsage {
  modelActual?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
const USAGE_COUNTERS = ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"] as const;
function boundedSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, REPLY_LIMIT);
  return text || undefined;
}
export function supervisorRunId(textCommandId: string): string {
  return `supervisor:${textCommandId}`;
}
export type Delivery =
  | {
      readonly kind: "repository.plan";
      readonly textCommandId: string;
      readonly contextSha: string;
      readonly contextDigest: string;
      readonly tasks: PlannedTask[];
      readonly decision: SupervisorDecisionKind;
      readonly reply: string;
      readonly usage?: SupervisorUsage;
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
      // The agent's final message, bounded to REPLY_LIMIT characters.
      readonly summary?: string;
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
  #controlBusy = false;
  // Commands executing in this process, so tick() and control() never run one twice.
  readonly #executing = new Set<string>();
  // How each run was started, for completion handling after a message or approval.
  readonly #contexts = new Map<string, RunContext>();
  // In-flight runtime.start executions by run, and the last event sequence
  // delivered per run so later commands resume the stream.
  readonly #streaming = new Map<string, Promise<void>>();
  readonly #cursors = new Map<string, number>();
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
        if (!this.#executing.has(stored.commandId)) await this.reconcileInterrupted(stored);
      const pending = (await this.transport.listPending()).filter(
        (command) => !this.#executing.has(command.commandId),
      );
      for (const command of pending) if (!continuesRun(command)) await this.execute(command);
      const starts = pending.filter((command) => command.type === "runtime.start");
      let builders = 0;
      let verifiers = 0;
      const selected = starts.filter((command) => {
        if (command.payload.role === "verifier") return verifiers++ < 1;
        return builders++ < 3;
      });
      // Messages and approvals continue runs that already hold their capacity.
      const continued = pending.filter(
        (command) => continuesRun(command) && command.type !== "runtime.start",
      );
      const results = await Promise.allSettled(
        [...continued, ...selected].map((command) => this.execute(command)),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      this.#busy = false;
    }
  }
  /**
   * Stop, message and approval commands must reach runs while tick() is busy streaming.
   * A message or approval for a run nobody streams continues that run in the background;
   * its stream is registered so a later stop waits for it.
   */
  async control(): Promise<void> {
    if (this.#controlBusy) return;
    this.#controlBusy = true;
    try {
      const pending = await this.transport.listPending();
      for (const command of pending) {
        if (this.#executing.has(command.commandId)) continue;
        if (command.type === "runtime.stop" && this.#streaming.has(command.payload.runId))
          await this.execute(command);
        else if (command.type === "runtime.send" || command.type === "runtime.approval") {
          if (this.#streaming.has(command.payload.runId)) await this.execute(command);
          else if (this.store.getRuntimeSession(command.payload.runId)?.nativeSessionId)
            void this.execute(command).catch(() => undefined);
        }
      }
    } finally {
      this.#controlBusy = false;
    }
  }
  /** Resolves once every run stream owned by this driver has finished. */
  async idle(): Promise<void> {
    while (this.#streaming.size) await Promise.all([...this.#streaming.values()]);
  }
  async execute(command: ExecutionCommand): Promise<void> {
    if (this.#executing.has(command.commandId)) return;
    this.#executing.add(command.commandId);
    try {
      if (!continuesRun(command)) return await this.#execute(command, false);
      const { runId } = command.payload;
      // Another command already streams this run: just deliver to the runtime.
      if (command.type !== "runtime.start" && this.#streaming.has(runId))
        return await this.#execute(command, false);
      const execution = this.#execute(command, true);
      const owner = execution.catch(() => undefined);
      this.#streaming.set(runId, owner);
      try {
        await execution;
      } finally {
        if (this.#streaming.get(runId) === owner) this.#streaming.delete(runId);
      }
    } finally {
      this.#executing.delete(command.commandId);
    }
  }
  // `streams` is true when this command owns the run's event stream until it pauses.
  async #execute(command: ExecutionCommand, streams: boolean): Promise<void> {
    if (command.workstationId !== this.workstationId)
      throw new Error("COMMAND_WORKSTATION_MISMATCH");
    const stored = this.store.recordCommand(command);
    if (stored.commandId !== command.commandId) throw new Error("COMMAND_ID_CONFLICT");
    if (stored.status === "completed") {
      await this.flush();
      return;
    }
    if (stored.status === "running" || stored.status === "failed") {
      // Throws unless the interrupted command could be settled locally.
      await this.reconcileInterrupted(stored);
      return;
    }
    await this.transport.claim(command.commandId);
    await this.transport.acknowledge(command.commandId);
    this.store.markCommandRunning(command.commandId);
    const deliveries: Delivery[] = [];
    let streamFailure: unknown;
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
        const legacy = explicitPlan(command.payload.text);
        let result: SupervisorDecision;
        let usage: SupervisorUsage = {};
        if (legacy) {
          result = {
            decision: "plan",
            reply: `Planned ${legacy.length} task${legacy.length === 1 ? "" : "s"} from the provided plan.`,
            tasks: legacy,
          };
        } else {
          const checks = repositoryChecks(workspace.path);
          const outcome = await this.#supervise(
            command.payload,
            supervisorInstruction({
              text: command.payload.text,
              conversation: command.payload.conversation ?? [],
              context,
              checks,
            }),
          );
          usage = outcome.usage;
          result = parseSupervisorDecision(outcome.summary, checks);
        }
        // The Supervisor is read-only: the planned context must still be the current one.
        this.#discovery.assertCurrent(context);
        deliveries.push({
          kind: "repository.plan",
          textCommandId: command.payload.textCommandId,
          contextSha: context.gitSha,
          contextDigest: context.snapshotDigest,
          tasks: result.tasks,
          decision: result.decision,
          reply: result.reply,
          ...(Object.keys(usage).length ? { usage } : {}),
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
      } else if (command.type === "runtime.stop") {
        const { runId } = command.payload;
        const session = this.store.getRuntimeSession(runId);
        if (!session?.nativeSessionId) throw new Error("RUN_NOT_ACTIVE");
        const runtime = this.runtimes.get(session.runtime);
        const before = await runtime.inspect(session.nativeSessionId);
        if (!TERMINAL.includes(before.state)) {
          await runtime.stop({ nativeSessionId: session.nativeSessionId });
          // A streaming runtime.start reports the outcome; a waiting run has no owner.
          const owner = this.#streaming.get(runId);
          if (owner) await owner;
          else {
            const events: NormalizedRunEventDto[] = [];
            for await (const event of this.#follow(runtime, session.nativeSessionId, runId)) {
              events.push(event);
              if (TERMINAL.some((state) => event.type === `run.${state}`)) break;
            }
            if (events.length) deliveries.push({ kind: "run.events", runId, events });
            const after = await this.manager.observe(runId);
            if (!TERMINAL.includes(after.state)) throw new Error("RUNTIME_STOP_UNCONFIRMED");
            const workspace = this.workspaces.inspect(session.workspaceId);
            deliveries.push({
              kind: "run.complete",
              runId,
              headSha: workspace.headSha ?? workspace.baseSha,
              dirty: workspace.dirty,
              changedFileCount: workspace.statusPorcelain?.split("\0").filter(Boolean).length ?? 0,
            });
          }
        }
      } else if (command.type === "runtime.send" || command.type === "runtime.approval") {
        const { runId } = command.payload;
        const session = this.store.getRuntimeSession(runId);
        if (!session?.nativeSessionId) throw new Error("RUN_NOT_ACTIVE");
        const runtime = this.runtimes.get(session.runtime);
        if (TERMINAL.includes((await runtime.inspect(session.nativeSessionId)).state))
          throw new Error("RUN_NOT_ACTIVE");
        const context = streams ? this.#context(runId) : undefined;
        if (command.type === "runtime.approval") {
          if (!runtime.resolveApproval) throw new Error("RUNTIME_APPROVAL_UNSUPPORTED");
          await runtime.resolveApproval({
            nativeSessionId: session.nativeSessionId,
            approvalId: command.payload.approvalId,
            decision: command.payload.decision,
          });
        } else {
          if (!runtime.capabilities().canMessage) throw new Error("RUNTIME_SEND_UNSUPPORTED");
          await runtime.send({
            nativeSessionId: session.nativeSessionId,
            message: command.payload.message,
          });
        }
        // A run streamed by another command reports through that command; otherwise this
        // command follows the run until it pauses again and completes it like a start.
        if (context) {
          try {
            await this.#stream(
              command.commandId,
              context,
              runtime,
              session.nativeSessionId,
              deliveries,
            );
          } catch (error) {
            streamFailure = error;
            throw error;
          }
        }
      } else if (command.type === "workspace.cleanup") {
        // The backend authorizes the cleanup policy; the Node still refuses dirty worktrees.
        this.workspaces.cleanup(command.payload.workspaceId, {
          artifactsCaptured: true,
          integrationPending: false,
          retentionAllows: true,
        });
      } else if (command.type === "invalid") {
        throw new Error(command.payload.code);
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
        const session = await this.manager.start(input);
        const context: RunContext = {
          runId: input.runId,
          workspaceId: input.workspaceId,
          runtime: input.runtime,
          ...(input.role ? { role: input.role } : {}),
          ...(input.verificationScripts ? { verificationScripts: input.verificationScripts } : {}),
          ...(input.requiredModalities ? { requiredModalities: input.requiredModalities } : {}),
        };
        this.#contexts.set(input.runId, context);
        await this.#stream(
          command.commandId,
          context,
          this.runtimes.get(input.runtime),
          session.nativeSessionId,
          deliveries,
        );
      }
    } catch (error) {
      if (command.type === "runtime.start") throw error;
      const message = error instanceof Error ? error.message : "";
      // Events already observed while following a run are still reported.
      const observed = streamFailure
        ? deliveries.filter((delivery) => delivery.kind === "run.events")
        : [];
      deliveries.length = 0;
      deliveries.push(...observed);
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
  /**
   * Yields a run's new events from the delivered cursor until it pauses (waiting or
   * terminal). Runtimes whose subscription ends early (for example after an approval
   * request) are re-read until no new event appears.
   */
  async *#follow(
    runtime: AgentRuntime,
    nativeSessionId: string,
    runId: string,
    workspaceId?: string,
  ): AsyncGenerator<NormalizedRunEventDto> {
    let cursor = this.#cursors.get(runId) ?? 0;
    for (;;) {
      let progressed = false;
      for await (const event of runtime.subscribe({ nativeSessionId, afterSequence: cursor })) {
        if (
          event.runId !== runId ||
          (workspaceId !== undefined && event.workspaceId !== workspaceId) ||
          event.workstationId !== this.workstationId
        )
          throw new Error("RUNTIME_EVENT_PROVENANCE_MISMATCH");
        cursor = Math.max(cursor, event.sequence);
        this.#cursors.set(runId, cursor);
        progressed = true;
        yield event;
        if (PAUSE.includes(event.type)) return;
      }
      if (!progressed) return;
    }
  }
  // Follows a run until it pauses, reporting approvals immediately, and completes it
  // (candidate commit, verification checks, final summary) once it is terminal.
  async #stream(
    commandId: string,
    context: RunContext,
    runtime: AgentRuntime,
    nativeSessionId: string,
    deliveries: Delivery[],
  ): Promise<void> {
    const { runId, workspaceId } = context;
    const events: NormalizedRunEventDto[] = [];
    let summary: string | undefined;
    try {
      for await (const event of this.#follow(runtime, nativeSessionId, runId, workspaceId)) {
        if (event.type === "run.completed") summary = boundedSummary(event.payload.summary);
        events.push(event);
        // A pending approval must reach the user now, not when the run pauses.
        if (events.length === 50 || event.type.startsWith("approval.")) {
          this.store.appendEvent({
            eventId: `stream:${commandId}:${String(event.sequence).padStart(8, "0")}`,
            type: "control-plane.delivery",
            payload: { kind: "run.events", runId, events: [...events] },
            createdAt: Date.now(),
          });
          events.length = 0;
          await this.flush();
        }
      }
    } finally {
      if (events.length) deliveries.push({ kind: "run.events", runId, events });
    }
    const session = await this.manager.observe(runId);
    if (!TERMINAL.includes(session.state)) return;
    this.#contexts.delete(runId);
    let workspace = this.workspaces.inspect(workspaceId);
    if (context.role !== "verifier" && session.state === "completed") {
      commitCandidate(workspace.path);
      workspace = this.workspaces.inspect(workspaceId);
    }
    const evidence =
      context.role === "verifier"
        ? await runVerificationChecks(
            workspace.path,
            context.verificationScripts ?? [],
            context.requiredModalities ?? ["static", "behavioral"],
          )
        : undefined;
    workspace = this.workspaces.inspect(workspaceId);
    deliveries.push({
      kind: "run.complete",
      ...(evidence ? { evidence } : {}),
      ...(summary ? { summary } : {}),
      runId,
      headSha: workspace.headSha ?? workspace.baseSha,
      dirty: workspace.dirty,
      changedFileCount: workspace.statusPorcelain?.split("\0").filter(Boolean).length ?? 0,
    });
  }
  // How a run was started: kept in memory, recovered from the persisted start command.
  #context(runId: string): RunContext {
    const known = this.#contexts.get(runId);
    if (known) return known;
    const session = this.store.getRuntimeSession(runId);
    const start = this.store.findCommandByIdempotencyKey(`start:${runId}`);
    const payload = start?.type === "runtime.start" ? (start.payload as Partial<RunContext>) : {};
    if (!session || payload.runId !== runId || payload.workspaceId !== session.workspaceId)
      throw new Error("RECONCILIATION_REQUIRED");
    const context: RunContext = {
      runId,
      workspaceId: session.workspaceId,
      runtime: session.runtime,
      ...(payload.role ? { role: payload.role } : {}),
      ...(payload.verificationScripts ? { verificationScripts: payload.verificationScripts } : {}),
      ...(payload.requiredModalities ? { requiredModalities: payload.requiredModalities } : {}),
    };
    this.#contexts.set(runId, context);
    return context;
  }
  // The backend may name a Supervisor runtime this Node does not run (it falls back to
  // "codex" without knowing what is installed). Use the requested runtime when registered,
  // otherwise "codex" when registered, otherwise the first registered runtime.
  #supervisorRuntime(requested: string | undefined): string {
    const ids = this.runtimes.ids();
    if (requested && ids.includes(requested)) return requested;
    if (ids.includes("codex")) return "codex";
    const first = ids[0];
    if (!first) throw new Error("RUNTIME_UNAVAILABLE");
    return first;
  }
  // Runs the Supervisor as a Node-local, read-only run on the planning workspace. Its
  // events are not delivered; only its final reply and reported usage are returned.
  async #supervise(
    payload: { textCommandId: string; workspaceId: string; supervisor?: SupervisorSelection },
    instruction: string,
  ): Promise<{ summary?: string; usage: SupervisorUsage }> {
    const runId = supervisorRunId(payload.textCommandId) as AgentRunId;
    const workspaceId = payload.workspaceId as WorkspaceId;
    const runtimeId = this.#supervisorRuntime(payload.supervisor?.runtime);
    const runtime = this.runtimes.get(runtimeId);
    let nativeSessionId: string | undefined;
    let settled = false;
    try {
      const session = await this.manager.start({
        runId,
        workspaceId,
        runtime: runtimeId,
        role: "supervisor",
        instruction,
        ...(payload.supervisor?.model ? { model: payload.supervisor.model } : {}),
        ...(payload.supervisor?.reasoningEffort
          ? { reasoningEffort: payload.supervisor.reasoningEffort }
          : {}),
      });
      nativeSessionId = session.nativeSessionId;
      let summary: string | undefined;
      const usage: SupervisorUsage = {};
      for await (const event of this.#follow(runtime, nativeSessionId, runId, workspaceId)) {
        // The Supervisor is read-only and Node-local: nobody can approve its requests.
        if (event.type === "approval.requested")
          await runtime.resolveApproval?.({
            nativeSessionId,
            approvalId: event.payload.approvalId,
            decision: "reject",
          });
        if (event.type === "run.usage") {
          const reported = event.payload;
          if (
            typeof reported.modelActual === "string" &&
            reported.modelActual.length > 0 &&
            reported.modelActual.length <= 256
          )
            usage.modelActual = reported.modelActual;
          for (const counter of USAGE_COUNTERS) {
            const value = reported[counter];
            if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
              usage[counter] = value;
          }
        }
        if (event.type === "run.completed") summary = boundedSummary(event.payload.summary);
      }
      const final = await this.manager.observe(runId);
      settled = TERMINAL.includes(final.state);
      if (final.state === "completed") return { ...(summary ? { summary } : {}), usage };
      throw new Error(
        final.state === "stopped"
          ? "SUPERVISOR_STOPPED"
          : final.state === "failed"
            ? "SUPERVISOR_FAILED"
            : "SUPERVISOR_INCOMPLETE",
      );
    } finally {
      // The Supervisor never keeps the planning workspace: stop it if it is still
      // active (it cannot ask for input) and release its lease.
      if (!settled && nativeSessionId) {
        try {
          await runtime.stop({ nativeSessionId });
        } catch {
          /* The command fails either way; the read-only workspace is released below. */
        }
      }
      if (this.store.getWorkspaceLease(workspaceId)?.runId === runId)
        this.workspaces.release(workspaceId, runId);
    }
  }
  private async reconcileInterrupted(command: StoredCommand): Promise<void> {
    if (command.type === "repository.plan" && command.status === "running") {
      // An interrupted Supervisor only read the planning workspace: release it and
      // fail the plan visibly instead of blocking the queue on reconciliation.
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload.textCommandId === "string" && typeof payload.workspaceId === "string") {
        const runId = supervisorRunId(payload.textCommandId);
        if (this.store.getWorkspaceLease(payload.workspaceId)?.runId === runId)
          this.workspaces.release(payload.workspaceId, runId);
      }
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: {
            kind: "command.failed",
            commandId: command.commandId,
            code: "SUPERVISOR_INTERRUPTED",
          } satisfies Delivery,
          createdAt: Date.now(),
        },
      ]);
      await this.flush();
      return;
    }
    if (
      (command.type === "runtime.send" || command.type === "runtime.approval") &&
      command.status === "running"
    ) {
      // The runtime may or may not have received it; the run itself is reconciled through
      // its start command. Fail the message/approval visibly instead of blocking the queue.
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: {
            kind: "command.failed",
            commandId: command.commandId,
            code: "RUNTIME_COMMAND_INTERRUPTED",
          } satisfies Delivery,
          createdAt: Date.now(),
        },
      ]);
      await this.flush();
      return;
    }
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
