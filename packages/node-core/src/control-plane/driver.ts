import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedTask } from "@zamolxis/application";
import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import { addedOrModifiedFiles, commitCandidate, mergeDependencies } from "@zamolxis/git";
import type { AgentRuntime, InterruptedTurnPolicy, RuntimeRegistry } from "@zamolxis/runtime-core";
import {
  type OrchestratorDecision,
  orchestratorInstruction,
  parseOrchestratorDecision,
} from "../capabilities/orchestrator";
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
import type { GitHubClient } from "../github/github-api";
import { PublishingCredentials } from "../github/publishing-credentials";
import { NO_REPOSITORY_TOKENS } from "../github/token-store";
import {
  type PublishRequest,
  type PublishResult,
  publishIntegration,
} from "../integration/publish";
import type {
  LocalStateStore,
  OutboxEvent,
  RecordedRunEvent,
  StoredCommand,
  StoredRuntimeSession,
} from "../persistence/local-state";
import type { RuntimeManager } from "../runtime/runtime-manager";
import { type TraceBatch, TraceRecorder } from "../trace/recorder";
import {
  candidateStep,
  checkStep,
  discoveryStep,
  recoveryStep,
  runtimeStep,
  workspaceStep,
} from "../trace/steps";
import { SupervisorLog, type SupervisorLogBatch } from "../trace/supervisor-log";
import { type CheckEvidence, runVerificationChecks } from "../verification/checks";
import type { WorkspaceManager } from "../workspace/workspace-manager";
import { PROOF_MAX_FILES, type ProofFile, takeChangedImages, takeProof } from "./proof";

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
  // Writes the reply of the top-level Orchestrator; it reads no repository.
  | {
      readonly type: "orchestrator.answer";
      readonly payload: {
        orchestratorMessageId: string;
        text: string;
        context: string;
        conversation: ConversationMessage[];
        orchestrator?: SupervisorSelection;
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
  // Pushes a trusted integration branch and opens a pull request; never merges.
  | { readonly type: "integration.publish"; readonly payload: PublishRequest }
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
  | {
      readonly type: "workspace.cleanup";
      // deleteBranchAt: the backend allows deleting the worktree's branch at this exact commit.
      readonly payload: { workspaceId: string; deleteBranchAt?: string };
    }
  // Stops the Supervisor planning a text command; a no-op once that planning finished.
  | { readonly type: "supervisor.stop"; readonly payload: { textCommandId: string } }
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
  readonly instructions?: string;
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
export function orchestratorRunId(orchestratorMessageId: string): string {
  return `orchestrator:${orchestratorMessageId}`;
}
// An Orchestrator reply that takes longer is stopped; the backend answers without it.
export const ORCHESTRATOR_TIMEOUT_MS = 5 * 60_000;
/** Bounded, owner-visible progress of a Supervisor that is still working. */
export interface SupervisorProgress {
  readonly textCommandId: string;
  // What the Supervisor is doing now, one line of at most ACTIVITY_LIMIT characters.
  readonly activity?: string;
  // Usage reported by the provider so far.
  readonly usage?: SupervisorUsage;
}
export const ACTIVITY_LIMIT = 200;
export const PROGRESS_INTERVAL_MS = 2000;
/** One line describing a Supervisor event, or undefined when the event is not an activity. */
export function supervisorActivity(event: NormalizedRunEventDto): string | undefined {
  let text: string | undefined;
  if (event.type === "run.activity") text = event.payload.label;
  else if (event.type === "tool.started") text = event.payload.summary || event.payload.tool;
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > ACTIVITY_LIMIT ? `${line.slice(0, ACTIVITY_LIMIT - 1)}…` : line;
}
// Reports progress when it changes, at most once per interval; the latest change in a
// throttled window is sent when the window ends. Failures never affect the Supervisor.
class ProgressReporter {
  #sentKey: string | undefined;
  #sentAt = Number.NEGATIVE_INFINITY;
  #pending: SupervisorProgress | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(
    private readonly send: (progress: SupervisorProgress) => Promise<void> | undefined,
    private readonly now: () => number,
    private readonly interval: number,
  ) {}
  update(progress: SupervisorProgress): void {
    if (this.#closed) return;
    const key = JSON.stringify(progress);
    if (key === this.#sentKey) {
      this.#pending = undefined;
      return;
    }
    const wait = this.#sentAt + this.interval - this.now();
    if (wait <= 0) {
      this.#emit(progress, key);
      return;
    }
    this.#pending = progress;
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#pending;
      if (pending && !this.#closed) this.#emit(pending, JSON.stringify(pending));
    }, wait);
  }
  #emit(progress: SupervisorProgress, key: string): void {
    this.#sentKey = key;
    this.#sentAt = this.now();
    this.#pending = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#chain = this.#chain
      .then(() => this.send(progress))
      .catch(() => undefined)
      .then(() => undefined);
  }
  // Drops anything not yet sent (the outcome supersedes it) and waits for sent reports.
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#chain;
  }
}
// A text command being planned in this process, so a stop can reach its Supervisor.
interface Planning {
  stop: boolean;
  active?: { readonly runtime: AgentRuntime; readonly nativeSessionId: string } | undefined;
}
export interface ControlPlaneDriverOptions {
  readonly now?: () => number;
  readonly progressIntervalMs?: number;
  // Per-repository GitHub publishing credentials for integration.publish (its own token,
  // else its chosen gh account; none: GitHub publishing fails with
  // PUBLISH_GITHUB_NOT_CONNECTED) and the GitHub API client (default: REST over fetch).
  readonly githubCredentials?: PublishingCredentials;
  readonly github?: GitHubClient;
  readonly githubHosts?: readonly string[];
  // Node-owned folder for proof images until they are uploaded; without it no proof is taken.
  readonly proofRoot?: string;
}
export type Delivery =
  | {
      readonly kind: "run.proof";
      readonly runId: string;
      readonly files: readonly ProofFile[];
    }
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
  | ({
      readonly kind: "integration.published";
      readonly commandId: string;
      readonly taskId: string;
      readonly subjectSha: string;
    } & PublishResult)
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
  | TraceBatch
  | SupervisorLogBatch
  | ({
      readonly kind: "orchestrator.answer";
      readonly orchestratorMessageId: string;
      readonly usage?: SupervisorUsage;
    } & OrchestratorDecision)
  | { readonly kind: "command.failed"; readonly commandId: string; readonly code: string }
  | { readonly kind: "command.complete"; readonly commandId: string };
/** The control plane's view of a run, returned by reconcile when it is known. */
export interface RunReconciliation {
  readonly status?: string;
}
// An interrupted turn is continued at most this many times per run; then it fails.
export const MAX_RESTART_CONTINUATIONS = 2;
interface RunHistory {
  readonly lastSequence: number;
  readonly pendingApprovals: string[];
  readonly usage: Partial<Record<(typeof USAGE_COUNTERS)[number], number>>;
  readonly terminal?: { readonly state: "completed" | "failed" | "stopped"; summary?: string };
}
// What the control plane has seen of a run, from the events this Node recorded.
function runHistory(events: readonly RecordedRunEvent[]): RunHistory {
  let lastSequence = 0;
  const approvals = new Set<string>();
  const usage: RunHistory["usage"] = {};
  let terminal: RunHistory["terminal"];
  for (const event of events) {
    lastSequence = Math.max(lastSequence, event.sequence);
    const approvalId = event.payload.approvalId;
    if (event.type === "approval.requested" && typeof approvalId === "string")
      approvals.add(approvalId);
    if (event.type === "approval.resolved" && typeof approvalId === "string")
      approvals.delete(approvalId);
    if (event.type === "run.usage")
      for (const counter of USAGE_COUNTERS) {
        const value = event.payload[counter];
        if (typeof value === "number" && Number.isSafeInteger(value))
          usage[counter] = Math.max(usage[counter] ?? 0, value);
      }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.stopped"
    ) {
      const summary =
        event.type === "run.completed" ? boundedSummary(event.payload.summary) : undefined;
      terminal = {
        state:
          event.type === "run.completed"
            ? "completed"
            : event.type === "run.failed"
              ? "failed"
              : "stopped",
        ...(summary ? { summary } : {}),
      };
    }
  }
  return {
    lastSequence,
    pendingApprovals: [...approvals],
    usage,
    ...(terminal ? { terminal } : {}),
  };
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z_]{1,64}$/.test(message) ? message : "LOCAL_OPERATION_FAILED";
}
export interface ControlPlaneTransport {
  listPending(): Promise<readonly ExecutionCommand[]>;
  claim(commandId: string): Promise<void>;
  acknowledge(commandId: string): Promise<void>;
  deliver(delivery: Delivery): Promise<void>;
  /**
   * Reports what the Node observes about a run and returns the control plane's view of it.
   * "missing": the native session cannot be recovered (the run becomes lost and keeps its
   * capacity); "resuming": the Node is reattaching it (no change).
   */
  reconcile(
    runId: string,
    observation?: "active" | "missing" | "resuming",
    reason?: string,
    // biome-ignore lint/suspicious/noConfusingVoidType: transports may report nothing back.
  ): Promise<RunReconciliation | undefined | void>;
  // Best effort and not persisted: progress is superseded by the plan outcome.
  reportProgress?(progress: SupervisorProgress): Promise<void>;
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
  readonly #answers = new Set<Promise<void>>();
  // Text commands whose repository.plan executes in this process.
  readonly #planning = new Map<string, Planning>();
  // Runs this driver started or tried to recover, so a run is recovered at most once per
  // process; and runs being reattached, so their commands wait for the native session.
  readonly #known = new Set<string>();
  readonly #attaching = new Map<string, Promise<void>>();
  // Runs followed by their recovery, and those a message or approval reached meanwhile.
  readonly #recovering = new Set<string>();
  readonly #nudged = new Set<string>();
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
    private readonly options: ControlPlaneDriverOptions = {},
  ) {}
  async tick(): Promise<void> {
    if (this.#busy) throw new Error("DRIVER_BUSY");
    this.#busy = true;
    try {
      await this.flush();
      const listed = await this.transport.listPending();
      // Runs a previous Node process left unfinished are reattached in the background.
      await this.#recoverRuns(listed);
      for (const stored of this.store.listInterruptedCommands())
        if (!this.#executing.has(stored.commandId)) await this.reconcileInterrupted(stored);
      const pending = listed.filter((command) => !this.#executing.has(command.commandId));
      for (const command of pending) {
        if (continuesRun(command)) continue;
        // A model reply can take minutes; it never holds up provisioning or planning.
        if (command.type === "orchestrator.answer") this.#answerInBackground(command);
        else await this.execute(command);
      }
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
        // A stop for a Supervisor that already finished is left to tick() as a no-op.
        else if (
          command.type === "supervisor.stop" &&
          this.#planning.has(command.payload.textCommandId)
        )
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
  /** Resolves once every run stream and Orchestrator reply owned by this driver has finished. */
  async idle(): Promise<void> {
    while (this.#streaming.size || this.#answers.size)
      await Promise.all([...this.#streaming.values(), ...this.#answers]);
  }
  // Failures are retried by a later tick: the command stays pending until claimed.
  #answerInBackground(command: ExecutionCommand): void {
    if (this.#executing.has(command.commandId)) return;
    const answer: Promise<void> = this.execute(command)
      .catch(() => undefined)
      .finally(() => this.#answers.delete(answer));
    this.#answers.add(answer);
  }
  async execute(command: ExecutionCommand): Promise<void> {
    if (this.#executing.has(command.commandId)) return;
    this.#executing.add(command.commandId);
    // Registered before claiming, so a stop sent once the plan is claimed always finds it.
    const planning =
      command.type === "repository.plan" && !this.#planning.has(command.payload.textCommandId)
        ? command.payload.textCommandId
        : undefined;
    if (planning) this.#planning.set(planning, { stop: false });
    try {
      if (!continuesRun(command)) return await this.#execute(command, false);
      const { runId } = command.payload;
      // Already followed (by its recovery after a restart): never started or owned twice.
      if (command.type === "runtime.start" && this.#streaming.has(runId)) return;
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
      if (planning) this.#planning.delete(planning);
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
        const discoveredAt = Date.now();
        const context = this.#discovery.discover(command.payload.workspaceId);
        this.#discovery.assertCurrent(context);
        const workspace = this.workspaces.inspect(command.payload.workspaceId);
        const legacy = explicitPlan(command.payload.text);
        let result: SupervisorDecision;
        let usage: SupervisorUsage = {};
        if (legacy) {
          result = {
            decision: "delegate",
            reply: `Planned ${legacy.length} task${legacy.length === 1 ? "" : "s"} from the provided plan.`,
            tasks: legacy,
          };
        } else {
          const checks = repositoryChecks(workspace.path);
          // The owner can see what the Supervisor did for this message ("Show what I did").
          const log = new SupervisorLog(
            this.store,
            command.payload.textCommandId,
            command.commandId,
            this.options.now ?? Date.now,
          );
          log.discovery(discoveryStep(command.commandId, discoveredAt, context));
          try {
            const outcome = await this.#supervise(
              command.payload,
              supervisorInstruction({
                text: command.payload.text,
                conversation: command.payload.conversation ?? [],
                context,
                checks,
                ...(command.payload.supervisor?.instructions
                  ? { instructions: command.payload.supervisor.instructions }
                  : {}),
              }),
              log,
            );
            usage = outcome.usage;
            result = parseSupervisorDecision(outcome.summary, checks);
            log.decided(result);
          } catch (error) {
            log.failed(error);
            throw error;
          } finally {
            // Written before the plan outcome, so the log is there when the reply appears.
            log.persist();
          }
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
      } else if (command.type === "orchestrator.answer") {
        const outcome = await this.#orchestrate(command.payload);
        deliveries.push({
          kind: "orchestrator.answer",
          orchestratorMessageId: command.payload.orchestratorMessageId,
          ...parseOrchestratorDecision(outcome.summary),
          ...(Object.keys(outcome.usage).length ? { usage: outcome.usage } : {}),
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
      } else if (command.type === "integration.publish") {
        const workspace = this.workspaces.inspect(command.payload.workspaceId);
        const result = await publishIntegration(workspace, command.payload, {
          credentials:
            this.options.githubCredentials ??
            new PublishingCredentials({ tokens: NO_REPOSITORY_TOKENS }),
          ...(this.options.github ? { github: this.options.github } : {}),
          ...(this.options.githubHosts ? { githubHosts: this.options.githubHosts } : {}),
        });
        deliveries.push({
          kind: "integration.published",
          commandId: command.commandId,
          taskId: command.payload.taskId,
          subjectSha: command.payload.subjectSha,
          ...result,
        });
      } else if (command.type === "runtime.stop") {
        const { runId } = command.payload;
        // A run being reattached after a restart is stopped once its session is back.
        await this.#attaching.get(runId);
        const session = this.store.getRuntimeSession(runId);
        if (!session?.nativeSessionId) throw new Error("RUN_NOT_ACTIVE");
        const runtime = this.runtimes.get(session.runtime);
        const before = await runtime.inspect(session.nativeSessionId);
        // Already ended (for example settled by its recovery): wait until that outcome is
        // recorded, so the stop is acknowledged after the run's completion.
        if (TERMINAL.includes(before.state)) await this.#streaming.get(runId);
        if (!TERMINAL.includes(before.state)) {
          await runtime.stop({ nativeSessionId: session.nativeSessionId });
          // A streaming runtime.start reports the outcome; a waiting run has no owner.
          const owner = this.#streaming.get(runId);
          if (owner) {
            // A recovery that already stopped following the run looks again.
            if (this.#recovering.has(runId)) this.#nudged.add(runId);
            await owner;
          }
          const recorded = this.store.getRuntimeSession(runId)?.status;
          // Nobody reported the stopped run (no owner, or one that ended before the stop).
          if (!owner || !recorded || !TERMINAL.includes(recorded)) {
            const events: NormalizedRunEventDto[] = [];
            const ends = TERMINAL.map((state) => `run.${state}`);
            for await (const event of this.#follow(
              runtime,
              session.nativeSessionId,
              runId,
              undefined,
              ends,
            ))
              events.push(event);
            if (events.length) deliveries.push({ kind: "run.events", runId, events });
            const after = await this.manager.observe(runId);
            if (!TERMINAL.includes(after.state)) throw new Error("RUNTIME_STOP_UNCONFIRMED");
            const trace = new TraceRecorder(this.store, runId, command.commandId);
            trace.record(
              runtimeStep(runId, session.runtime, Date.now(), after.state as "stopped" | "failed"),
            );
            trace.persist();
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
        await this.#attaching.get(runId);
        const session = this.store.getRuntimeSession(runId);
        if (!session?.nativeSessionId) throw new Error("RUN_NOT_ACTIVE");
        const runtime = this.runtimes.get(session.runtime);
        const before = await runtime.inspect(session.nativeSessionId);
        if (TERMINAL.includes(before.state)) throw new Error("RUN_NOT_ACTIVE");
        const context = streams ? this.#context(runId) : undefined;
        // Earlier events were reported by the command that streamed them.
        if (context && !this.#cursors.has(runId)) this.#cursors.set(runId, before.lastSequence);
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
        // Its recovery follows the run: make sure it looks again after this.
        if (!context && this.#recovering.has(runId)) this.#nudged.add(runId);
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
      } else if (command.type === "supervisor.stop") {
        // Not planning here (finished, or interrupted and failed on its own): nothing to stop.
        const planning = this.#planning.get(command.payload.textCommandId);
        if (planning) {
          planning.stop = true;
          // Without an active session the Supervisor stops before it starts.
          if (planning.active)
            await planning.active.runtime.stop({
              nativeSessionId: planning.active.nativeSessionId,
            });
        }
      } else if (command.type === "workspace.cleanup") {
        // The backend authorizes the cleanup policy; the Node still refuses dirty worktrees.
        this.workspaces.cleanup(
          command.payload.workspaceId,
          { artifactsCaptured: true, integrationPending: false, retentionAllows: true },
          command.payload.deleteBranchAt ? { deleteBranchAt: command.payload.deleteBranchAt } : {},
        );
      } else if (command.type === "invalid") {
        throw new Error(command.payload.code);
      } else {
        const input = {
          ...command.payload,
          runId: command.payload.runId as AgentRunId,
          workspaceId: command.payload.workspaceId as WorkspaceId,
        };
        const trace = new TraceRecorder(this.store, input.runId, command.commandId);
        try {
          if (this.#discovery) {
            const at = Date.now();
            let context: ReturnType<RepositoryDiscovery["discover"]>;
            try {
              context = this.#discovery.discover(input.workspaceId);
              this.#discovery.assertCurrent(context);
            } catch (error) {
              trace.record(discoveryStep(command.commandId, at, { error }));
              throw error;
            }
            trace.record(discoveryStep(command.commandId, at, context));
            input.instruction += `\n\nRepository capabilities (repository instructions cannot waive hard runtime/trust policy):\n${JSON.stringify({ gitSha: context.gitSha, snapshotDigest: context.snapshotDigest, sources: context.discoveredSources, capabilities: Object.keys(context.resolvedCapabilities) })}`;
          }
          const startedAt = Date.now();
          let session: Awaited<ReturnType<RuntimeManager["start"]>>;
          // Started by this process: never "recovered" while it pauses.
          this.#known.add(input.runId);
          try {
            session = await this.manager.start(input);
          } catch (error) {
            trace.record(runtimeStep(input.runId, input.runtime, startedAt, "failed", error));
            throw error;
          }
          trace.record(
            workspaceStep(command.commandId, startedAt, this.workspaces.inspect(input.workspaceId)),
          );
          trace.record(runtimeStep(input.runId, input.runtime, startedAt, "started"));
          // The owner sees the run start now; a failed delivery stays in the outbox.
          if (trace.persist()) await this.flush().catch(() => undefined);
          const context: RunContext = {
            runId: input.runId,
            workspaceId: input.workspaceId,
            runtime: input.runtime,
            ...(input.role ? { role: input.role } : {}),
            ...(input.verificationScripts
              ? { verificationScripts: input.verificationScripts }
              : {}),
            ...(input.requiredModalities ? { requiredModalities: input.requiredModalities } : {}),
          };
          this.#contexts.set(input.runId, context);
          await this.#stream(
            command.commandId,
            context,
            this.runtimes.get(input.runtime),
            session.nativeSessionId,
            deliveries,
            trace,
          );
        } finally {
          trace.persist();
        }
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
    pauses: readonly string[] = PAUSE,
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
        if (pauses.includes(event.type)) return;
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
    trace = new TraceRecorder(this.store, context.runId, commandId),
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
    await this.#settle(
      commandId,
      context,
      session.state as "completed" | "failed" | "stopped",
      summary,
      deliveries,
      trace,
    );
  }
  // Completes a terminal run: candidate commit (builder/repair), deterministic checks
  // (verifier) and the final snapshot with the agent's last reply.
  async #settle(
    commandId: string,
    context: RunContext,
    state: "completed" | "failed" | "stopped",
    summary: string | undefined,
    deliveries: Delivery[],
    trace: TraceRecorder,
  ): Promise<void> {
    const { runId, workspaceId } = context;
    this.#contexts.delete(runId);
    trace.record(runtimeStep(runId, context.runtime, Date.now(), state));
    let workspace = this.workspaces.inspect(workspaceId);
    let evidence: CheckEvidence[] | undefined;
    // Taken before the commit and the checks so the proof folder is in neither.
    const proofRoot = this.options.proofRoot;
    const proof: ProofFile[] = [];
    if (proofRoot) {
      try {
        proof.push(...takeProof(workspace.path, proofRoot, runId));
      } catch {
        // Proof is best effort: it never blocks the candidate or the checks.
      }
    }
    try {
      if (context.role !== "verifier" && state === "completed") {
        const at = Date.now();
        const before = workspace.headSha ?? workspace.baseSha;
        try {
          commitCandidate(workspace.path);
        } catch (error) {
          trace.record(candidateStep(commandId, at, { error }));
          throw error;
        }
        workspace = this.workspaces.inspect(workspaceId);
        const after = workspace.headSha ?? workspace.baseSha;
        trace.record(candidateStep(commandId, at, { before, after }));
        if (proofRoot && before && after) {
          try {
            proof.push(
              ...takeChangedImages(
                workspace.path,
                proofRoot,
                runId,
                addedOrModifiedFiles(workspace.path, before, after),
                PROOF_MAX_FILES - proof.length,
              ),
            );
          } catch {
            // Best effort, as above.
          }
        }
      }
      let checks = 0;
      const subject = workspace.headSha;
      evidence =
        context.role === "verifier"
          ? await runVerificationChecks(
              workspace.path,
              context.verificationScripts ?? [],
              context.requiredModalities ?? ["static", "behavioral"],
              (check) => trace.record(checkStep(commandId, checks++, check, subject)),
            )
          : undefined;
    } finally {
      trace.persist();
    }
    workspace = this.workspaces.inspect(workspaceId);
    // Before run.complete, so the images are there when the run shows as finished.
    if (proof.length) deliveries.push({ kind: "run.proof", runId, files: proof });
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
  // events are not delivered as run events: they are summarized into its log, and its
  // final reply and reported usage are returned.
  async #supervise(
    payload: { textCommandId: string; workspaceId: string; supervisor?: SupervisorSelection },
    instruction: string,
    log: SupervisorLog,
  ): Promise<{ summary?: string; usage: SupervisorUsage }> {
    const runId = supervisorRunId(payload.textCommandId) as AgentRunId;
    const workspaceId = payload.workspaceId as WorkspaceId;
    const runtimeId = this.#supervisorRuntime(payload.supervisor?.runtime);
    const runtime = this.runtimes.get(runtimeId);
    let nativeSessionId: string | undefined;
    let settled = false;
    const planning = this.#planning.get(payload.textCommandId) ?? { stop: false };
    if (planning.stop) throw new Error("SUPERVISOR_STOPPED");
    const progress = new ProgressReporter(
      (report) => this.transport.reportProgress?.(report),
      this.options.now ?? Date.now,
      this.options.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
    );
    log.started(runtimeId, payload.supervisor?.model, payload.supervisor?.reasoningEffort);
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
      planning.active = { runtime, nativeSessionId };
      // A stop that arrived while the session was starting.
      if (planning.stop) await runtime.stop({ nativeSessionId });
      let summary: string | undefined;
      let activity: string | undefined;
      const usage: SupervisorUsage = {};
      const report = () =>
        progress.update({
          textCommandId: payload.textCommandId,
          ...(activity ? { activity } : {}),
          ...(Object.keys(usage).length ? { usage: { ...usage } } : {}),
        });
      // Marks the start, so the owner sees how long the Supervisor has been working.
      report();
      for await (const event of this.#follow(runtime, nativeSessionId, runId, workspaceId)) {
        log.observe(event);
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
        const next = supervisorActivity(event);
        if (next) activity = next;
        if (next || event.type === "run.usage") report();
      }
      const final = await this.manager.observe(runId);
      settled = TERMINAL.includes(final.state);
      log.ended(final.state, usage);
      // A Supervisor that finished before the stop reached it keeps its answer.
      if (final.state === "completed") return { ...(summary ? { summary } : {}), usage };
      throw new Error(
        planning.stop || final.state === "stopped"
          ? "SUPERVISOR_STOPPED"
          : final.state === "failed"
            ? "SUPERVISOR_FAILED"
            : "SUPERVISOR_INCOMPLETE",
      );
    } finally {
      planning.active = undefined;
      await progress.close();
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
  // Runs the top-level Orchestrator as a Node-local, read-only turn in an empty scratch
  // directory: it has no repository, workspace lease or run record, and is never resumed.
  // Approval requests are rejected and a slow reply is stopped after a bounded time.
  async #orchestrate(payload: {
    orchestratorMessageId: string;
    text: string;
    context: string;
    conversation: ConversationMessage[];
    orchestrator?: SupervisorSelection;
  }): Promise<{ summary?: string; usage: SupervisorUsage }> {
    const runId = orchestratorRunId(payload.orchestratorMessageId);
    const runtime = this.runtimes.get(this.#supervisorRuntime(payload.orchestrator?.runtime));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "zamolxis-orchestrator-")));
    let nativeSessionId: string | undefined;
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await runtime.start({
        runId: runId as AgentRunId,
        workstationId: this.workstationId as WorkstationId,
        instruction: orchestratorInstruction({
          text: payload.text,
          context: payload.context,
          conversation: payload.conversation,
          ...(payload.orchestrator?.instructions
            ? { instructions: payload.orchestrator.instructions }
            : {}),
        }),
        // Read-only, reply-only handling in the runtime adapters.
        role: "supervisor",
        ...(payload.orchestrator?.model ? { model: payload.orchestrator.model } : {}),
        ...(payload.orchestrator?.reasoningEffort
          ? { reasoningEffort: payload.orchestrator.reasoningEffort }
          : {}),
        workspace: {
          workspaceId: runId as WorkspaceId,
          cwd,
          branch: "orchestrator",
          headSha: "orchestrator",
        },
      });
      const id = session.nativeSessionId;
      nativeSessionId = id;
      timer = setTimeout(() => {
        timedOut = true;
        void runtime.stop({ nativeSessionId: id }).catch(() => undefined);
      }, ORCHESTRATOR_TIMEOUT_MS);
      let summary: string | undefined;
      const usage: SupervisorUsage = {};
      for await (const event of this.#follow(runtime, id, runId, runId)) {
        if (event.type === "approval.requested")
          await runtime.resolveApproval?.({
            nativeSessionId: id,
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
      const final = await runtime.inspect(id);
      settled = TERMINAL.includes(final.state);
      if (final.state === "completed" && !timedOut)
        return { ...(summary ? { summary } : {}), usage };
      throw new Error(
        timedOut
          ? "ORCHESTRATOR_TIMEOUT"
          : final.state === "failed"
            ? "ORCHESTRATOR_FAILED"
            : "ORCHESTRATOR_INCOMPLETE",
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.#cursors.delete(runId);
      if (!settled && nativeSessionId) {
        try {
          await runtime.stop({ nativeSessionId });
        } catch {
          /* The command fails either way. */
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  /**
   * Finds runs a previous Node process left unfinished (a run it was following, paused or
   * whose start command was interrupted) and reattaches each once, in the background. The
   * run's commands (stop, message, approval) wait until its session is back.
   */
  async #recoverRuns(pending: readonly ExecutionCommand[]): Promise<void> {
    const candidates = new Map<string, StoredRuntimeSession | undefined>();
    for (const session of this.store.listUnfinishedRuntimeSessions())
      candidates.set(session.runId, session);
    for (const command of this.store.listInterruptedCommands()) {
      const runId = (command.payload as { runId?: unknown } | undefined)?.runId;
      if (command.type === "runtime.start" && typeof runId === "string" && !candidates.has(runId))
        candidates.set(runId, this.store.getRuntimeSession(runId));
    }
    for (const [runId, session] of candidates) {
      if (this.#known.has(runId) || this.#streaming.has(runId)) continue;
      this.#known.add(runId);
      if (session?.nativeSessionId) {
        try {
          // Attached in this process (another driver instance started it): not a restart.
          await this.runtimes.get(session.runtime).inspect(session.nativeSessionId);
          continue;
        } catch {
          /* Unknown to this process: recover it. */
        }
      }
      const stop = this.store.findCommandByIdempotencyKey(`stop:${runId}`);
      const stopRequested =
        pending.some(
          (command) => command.type === "runtime.stop" && command.payload.runId === runId,
        ) ||
        stop?.status === "received" ||
        stop?.status === "running";
      let attached: () => void = () => undefined;
      this.#attaching.set(
        runId,
        new Promise<void>((resolve) => {
          attached = resolve;
        }),
      );
      // The interrupted start command (if any) belongs to the recovery from now on.
      const start = this.store.findCommandByIdempotencyKey(`start:${runId}`);
      const command =
        start?.type === "runtime.start" && start.status === "running" ? start : undefined;
      if (command) this.#executing.add(command.commandId);
      this.#recovering.add(runId);
      const owner = this.#recover(runId, session, command, stopRequested, () => attached())
        .catch(() => undefined)
        .finally(() => {
          attached();
          this.#attaching.delete(runId);
          this.#recovering.delete(runId);
          this.#nudged.delete(runId);
          if (command) this.#executing.delete(command.commandId);
        });
      this.#streaming.set(runId, owner);
      void owner.then(() => {
        if (this.#streaming.get(runId) === owner) this.#streaming.delete(runId);
      });
    }
  }
  /**
   * Reattaches one run after a restart. If the runtime already reported its outcome, the
   * run is completed from what this Node recorded. Otherwise its native session is resumed
   * after the recorded event cursor: approvals pending at the restart are rejected, an
   * interrupted turn is continued (at most MAX_RESTART_CONTINUATIONS times), or failed or
   * stopped, and the run is followed and completed like a start (summary, candidate commit,
   * checks). A run that cannot be resumed is reported lost and keeps its workspace and
   * capacity until reconciled; nothing is ever started again.
   */
  async #recover(
    runId: string,
    stored: StoredRuntimeSession | undefined,
    command: StoredCommand | undefined,
    stopRequested: boolean,
    attached: () => void,
  ): Promise<void> {
    let status: string | undefined;
    try {
      status = (await this.transport.reconcile(runId, "resuming"))?.status;
    } catch {
      // The control plane is unreachable: try again on a later tick.
      this.#known.delete(runId);
      return;
    }
    const start = this.store.findCommandByIdempotencyKey(`start:${runId}`);
    const deliveries: Delivery[] = [];
    let trace: TraceRecorder | undefined;
    let attempt = 0;
    try {
      if (!stored?.nativeSessionId) throw new Error("RUNTIME_SESSION_UNKNOWN");
      const context = this.#context(runId);
      const history = runHistory(this.store.listRecordedRunEvents(runId));
      attempt = this.store.recordRecovery(runId);
      trace = new TraceRecorder(this.store, runId, `recovery:${runId}:${attempt}`);
      // Outbox identities of this recovery: the interrupted start command's when it exists.
      const scope = command?.commandId ?? `recovery:${runId}:${attempt}`;
      this.#cursors.set(runId, history.lastSequence);
      if (history.terminal) {
        // The outcome was recorded before the restart; only its completion was lost.
        this.manager.settle(runId, history.terminal.state);
        attached();
        trace.record(recoveryStep(runId, attempt, Date.now(), { settled: history.terminal.state }));
        await this.#settle(
          scope,
          context,
          history.terminal.state,
          history.terminal.summary,
          deliveries,
          trace,
        );
      } else {
        if (status && TERMINAL.includes(status)) throw new Error("RUN_SETTLED_ELSEWHERE");
        const payload = (start?.payload ?? {}) as Record<string, unknown>;
        if (typeof payload.instruction !== "string") throw new Error("RECONCILIATION_REQUIRED");
        const policy: InterruptedTurnPolicy =
          stopRequested || status === "stopping"
            ? "stop"
            : attempt <= MAX_RESTART_CONTINUATIONS
              ? "continue"
              : "fail";
        const snapshot = await this.manager.resume(runId, {
          instruction: payload.instruction,
          ...(context.role ? { role: context.role } : {}),
          ...(typeof payload.model === "string" ? { model: payload.model } : {}),
          ...(typeof payload.reasoningEffort === "string"
            ? { reasoningEffort: payload.reasoningEffort }
            : {}),
          afterSequence: history.lastSequence,
          // The control plane must see the run start (again) before anything else.
          announce: history.lastSequence === 0 || status === "lost" || status === "starting",
          pendingApprovalIds: history.pendingApprovals,
          interrupted: policy,
          usage: history.usage,
        });
        attached();
        trace.record(recoveryStep(runId, attempt, Date.now(), { policy, state: snapshot.state }));
        if (trace.persist()) await this.flush().catch(() => undefined);
        const runtime = this.runtimes.get(stored.runtime);
        await this.#stream(scope, context, runtime, stored.nativeSessionId, deliveries, trace);
        // A message or approval delivered while this recovery followed the run may have
        // continued it after the stream paused: keep following until nothing new arrived.
        while (this.#nudged.delete(runId)) {
          const state = this.store.getRuntimeSession(runId)?.status;
          if (state === undefined || TERMINAL.includes(state)) break;
          await this.#stream(scope, context, runtime, stored.nativeSessionId, deliveries, trace);
        }
      }
      trace.persist();
      if (command) {
        deliveries.push({ kind: "command.complete", commandId: command.commandId });
        this.store.completeCommandWithEvents(
          command.commandId,
          this.#outbox(`delivery:${command.commandId}`, deliveries),
        );
      } else for (const event of this.#outbox(scope, deliveries)) this.store.appendEvent(event);
      await this.flush();
    } catch (error) {
      attached();
      // Events observed before the failure are still reported, then the run is lost.
      const observed = deliveries.filter((delivery) => delivery.kind === "run.events");
      for (const event of this.#outbox(`recovery:${runId}:${attempt}:failed`, observed))
        this.store.appendEvent(event);
      trace?.record(recoveryStep(runId, attempt, Date.now(), { error }));
      trace?.persist();
      await this.flush().catch(() => undefined);
      await this.transport.reconcile(runId, "missing", errorCode(error)).catch(() => undefined);
    }
  }
  #outbox(scope: string, deliveries: readonly Delivery[]): OutboxEvent[] {
    const now = Date.now();
    return deliveries.map((payload, index) => ({
      eventId: `${scope}:${String(index).padStart(3, "0")}`,
      type: "control-plane.delivery",
      payload,
      createdAt: now,
    }));
  }
  // Releases a run's workspace lease, also when a previous Node instance took it.
  #releaseLease(workspaceId: string, runId: string): void {
    const lease = this.store.getWorkspaceLease(workspaceId);
    if (lease?.runId !== runId) return;
    try {
      this.workspaces.releaseStaleLease(workspaceId, (owner) => owner === runId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LEASE_NOT_RECONCILED") throw error;
      this.workspaces.release(workspaceId, runId);
    }
  }
  private async reconcileInterrupted(command: StoredCommand): Promise<void> {
    if (command.type === "repository.plan" && command.status === "running") {
      // An interrupted Supervisor only read the planning workspace: release it (the lease
      // belongs to the previous Node instance after a restart) and fail the plan visibly
      // so the owner can send the message again. Its thread is not resumed: a new plan
      // must be bound to the repository context current when it is accepted.
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload.textCommandId === "string" && typeof payload.workspaceId === "string") {
        const runId = supervisorRunId(payload.textCommandId);
        this.#releaseLease(payload.workspaceId, runId);
        const session = this.store.getRuntimeSession(runId);
        if (session && !TERMINAL.includes(session.status))
          this.store.upsertRuntimeSession({ ...session, status: "failed" });
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
    if (command.type === "orchestrator.answer" && command.status === "running") {
      // Nothing local to release: the backend answers without the model.
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: {
            kind: "command.failed",
            commandId: command.commandId,
            code: "ORCHESTRATOR_INTERRUPTED",
          } satisfies Delivery,
          createdAt: Date.now(),
        },
      ]);
      await this.flush();
      return;
    }
    if (command.type === "integration.publish" && command.status === "running") {
      // The push may or may not have happened. Publishing again is safe (same exact commit,
      // never forced), so fail visibly and let the owner retry.
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: {
            kind: "command.failed",
            commandId: command.commandId,
            code: "PUBLISH_INTERRUPTED",
          } satisfies Delivery,
          createdAt: Date.now(),
        },
      ]);
      await this.flush();
      return;
    }
    if (command.type === "supervisor.stop" && command.status === "running") {
      // The plan it targeted was interrupted too and fails on its own: nothing to stop.
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: { kind: "command.complete", commandId: command.commandId } satisfies Delivery,
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
    if (command.type === "runtime.stop" && command.status === "running") {
      // The run's recovery settles it (stopping an interrupted turn); acknowledge the stop
      // once that outcome is recorded, otherwise fail it visibly so it can be sent again.
      const runId = (command.payload as { runId?: unknown }).runId;
      if (typeof runId !== "string") throw new Error("INVALID_PERSISTED_COMMAND");
      await this.#streaming.get(runId);
      const status = this.store.getRuntimeSession(runId)?.status;
      const settled = status !== undefined && TERMINAL.includes(status);
      this.store.completeCommandWithEvents(command.commandId, [
        {
          eventId: `delivery:${command.commandId}:000`,
          type: "control-plane.delivery",
          payload: (settled
            ? { kind: "command.complete", commandId: command.commandId }
            : {
                kind: "command.failed",
                commandId: command.commandId,
                code: "RUNTIME_COMMAND_INTERRUPTED",
              }) satisfies Delivery,
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
      // Recovered after a restart, or reported lost by its recovery: the command completes
      // with the run or waits for the next Node start; it never blocks the queue.
      if (this.#known.has(payload.runId)) return;
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
