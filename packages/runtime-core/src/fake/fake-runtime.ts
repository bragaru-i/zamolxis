import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRisk,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
} from "@zamolxis/contracts";
import {
  type AgentRuntime,
  RESTART_INTERRUPTED_CODE,
  type ResumeRunInput,
  type RuntimeSessionSnapshot,
  type StartRunInput,
} from "../agent-runtime";
import { approvalIdFor, approvalSummary } from "../approvals";

export type FakeStep =
  | { readonly type: "activity"; readonly label: string }
  // An intermediate agent message (`run.message`).
  | { readonly type: "message"; readonly text: string }
  // A tool call: `tool.started` then `tool.completed`.
  | {
      readonly type: "tool";
      readonly tool: string;
      readonly summary: string;
      readonly success?: boolean;
      readonly reads?: readonly string[];
    }
  | { readonly type: "waiting"; readonly reason: string }
  | { readonly type: "success"; readonly summary: string }
  | { readonly type: "failure"; readonly message: string }
  // Holds the scenario until resolveApproval; stop rejects it.
  | {
      readonly type: "approval";
      readonly kind: ApprovalKind;
      readonly summary: string;
      readonly risk: ApprovalRisk;
      readonly allowForSession?: boolean;
    };
// A scenario may depend on the run (for example its role), so one fake can play several agents.
export type FakeScenario = readonly FakeStep[] | ((input: StartRunInput) => readonly FakeStep[]);
interface FakeSession {
  input: StartRunInput;
  steps: readonly FakeStep[];
  snapshot: RuntimeSessionSnapshot;
  events: NormalizedRunEventDto[];
  nextStep: number;
  pendingApproval?: string | undefined;
  // Scenario step of the pending approval, so a resumed session can ask again.
  pendingStep?: number | undefined;
  // How many times the session was resumed in a new process (scopes approval ids).
  generation: number;
}
/** What a native runtime keeps on disk for a session (a Codex rollout, for example). */
export interface FakeNativeRecord {
  readonly input: StartRunInput;
  readonly steps: readonly FakeStep[];
  readonly nextStep: number;
  readonly state: RuntimeSessionSnapshot["state"];
  // A held approval: the turn was in flight when the process ended.
  readonly pendingStep?: number | undefined;
  readonly generation: number;
  readonly terminal?: { readonly type: string; readonly payload: Record<string, unknown> };
}
/**
 * Durable native session state shared by FakeRuntime instances, so a test can end one
 * "process" (drop its FakeRuntime) and resume its sessions in another.
 */
export class FakeNativeStore {
  readonly #records = new Map<string, FakeNativeRecord>();
  get(nativeSessionId: string): FakeNativeRecord | undefined {
    const record = this.#records.get(nativeSessionId);
    return record ? structuredClone(record) : undefined;
  }
  set(nativeSessionId: string, record: FakeNativeRecord): void {
    this.#records.set(nativeSessionId, structuredClone(record));
  }
}
const defaultScenario: readonly FakeStep[] = [
  { type: "activity", label: "Fake runtime executing" },
  { type: "success", summary: "Fake task completed" },
];

export class FakeRuntime implements AgentRuntime {
  readonly id = "fake";
  readonly #sessions = new Map<string, FakeSession>();
  readonly #runs = new Map<string, string>();
  constructor(
    private readonly scenario: FakeScenario = defaultScenario,
    private readonly now: () => number = () => 0,
    // Without a shared store, sessions die with this instance (like an in-memory runtime).
    private readonly native: FakeNativeStore = new FakeNativeStore(),
  ) {}

  capabilities(): RuntimeCapabilitiesDto {
    return {
      runtime: this.id,
      canStart: true,
      canResume: true,
      canMessage: true,
      canStop: true,
      canDiscoverSessions: false,
      supportsSubagents: false,
      canApprove: true,
    };
  }
  async start(input: StartRunInput): Promise<RuntimeSessionSnapshot> {
    if (!input.workspace.cwd || !input.workspace.branch || !input.workspace.headSha)
      throw new Error("WORKSPACE_ASSIGNMENT_REQUIRED");
    const existing = this.#runs.get(input.runId);
    if (existing) {
      const session = this.#get(existing);
      this.#assertAssignment(session, input);
      if (session.input.instruction !== input.instruction)
        throw new Error("RUNTIME_REQUEST_CONFLICT");
      return this.#snapshot(session);
    }
    const nativeSessionId = `fake:${input.runId}`;
    const copied = { ...input, workspace: { ...input.workspace } };
    const session: FakeSession = {
      input: copied,
      snapshot: {
        nativeSessionId,
        runId: input.runId,
        workspace: copied.workspace,
        state: "running",
        lastSequence: 0,
      },
      events: [],
      nextStep: 0,
      generation: 0,
      steps: typeof this.scenario === "function" ? this.scenario(copied) : this.scenario,
    };
    this.#sessions.set(nativeSessionId, session);
    this.#runs.set(input.runId, nativeSessionId);
    this.#emit(session, { type: "run.started", payload: { nativeSessionId } });
    this.#advance(session);
    this.#persist(session);
    return this.#snapshot(session);
  }
  /**
   * In this process: reattaches without side effects. After the process ended: rebuilds
   * the session from the native store, continuing event sequences after `afterSequence`.
   * A held approval means the turn was in flight: it is withdrawn and, depending on
   * `interrupted`, asked again ("continue"), failed or stopped. A waiting session stays
   * waiting; a terminal one reports its outcome again.
   */
  async resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    const live = this.#sessions.get(input.nativeSessionId);
    if (live) {
      this.#assertAssignment(live, input);
      return this.#snapshot(live);
    }
    const record = this.native.get(input.nativeSessionId);
    if (!record) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    const after = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("INVALID_EVENT_CURSOR");
    const session: FakeSession = {
      input: { ...record.input, workspace: { ...record.input.workspace } },
      steps: record.steps,
      snapshot: {
        nativeSessionId: input.nativeSessionId,
        runId: record.input.runId,
        workspace: { ...record.input.workspace },
        state: record.state,
        lastSequence: after,
      },
      events: [],
      nextStep: record.nextStep,
      generation: record.generation + 1,
    };
    this.#assertAssignment(session, input);
    this.#sessions.set(input.nativeSessionId, session);
    this.#runs.set(record.input.runId, input.nativeSessionId);
    if (input.announce)
      this.#emit(session, {
        type: "run.started",
        payload: { nativeSessionId: input.nativeSessionId },
      });
    for (const approvalId of input.pendingApprovalIds ?? [])
      this.#emit(session, {
        type: "approval.resolved",
        payload: { approvalId, decision: "rejected", reason: "withdrawn" },
      });
    if (record.terminal) {
      this.#emit(session, record.terminal as never);
    } else if (record.pendingStep !== undefined || record.state === "running") {
      const policy = input.interrupted ?? "fail";
      if (policy === "continue") {
        this.#emit(session, {
          type: "run.activity",
          payload: { label: "Continuing after a restart" },
        });
        session.nextStep = record.pendingStep ?? record.nextStep;
        this.#advance(session);
      } else if (policy === "stop") this.#end(session, "stopped", "Stopped during a restart");
      else this.#end(session, "failed", "Interrupted by a Node restart");
    }
    this.#persist(session);
    return this.#snapshot(session);
  }
  async send(input: { nativeSessionId: string; message: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (session.snapshot.state !== "waiting" && session.snapshot.state !== "running")
      throw new Error("RUNTIME_TERMINAL");
    this.#emit(session, { type: "run.activity", payload: { label: "Message received" } });
    // A message never settles a pending approval.
    if (!session.pendingApproval) this.#advance(session);
    this.#persist(session);
  }
  async resolveApproval(input: {
    nativeSessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (!session.pendingApproval || session.pendingApproval !== input.approvalId)
      throw new Error("APPROVAL_NOT_PENDING");
    const pendingStep =
      session.pendingStep === undefined ? undefined : session.steps[session.pendingStep];
    if (
      input.decision === "approve_session" &&
      (pendingStep?.type !== "approval" || pendingStep.allowForSession !== true)
    )
      throw new Error("APPROVAL_SCOPE_UNAVAILABLE");
    this.#settleApproval(session, input.decision === "reject" ? "rejected" : "approved", "user");
    this.#advance(session);
    this.#persist(session);
  }
  async stop(input: { nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (["completed", "failed", "stopped"].includes(session.snapshot.state)) return;
    this.#settleApproval(session, "rejected", "stopped");
    this.#emit(session, { type: "run.stopped", payload: { reason: "Stop requested" } });
    session.snapshot = { ...session.snapshot, state: "stopped" };
    this.#persist(session);
  }
  async inspect(nativeSessionId: string): Promise<RuntimeSessionSnapshot> {
    return this.#snapshot(this.#get(nativeSessionId));
  }
  async *subscribe(input: {
    nativeSessionId: string;
    afterSequence?: number;
  }): AsyncIterable<NormalizedRunEventDto> {
    const cursor = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("INVALID_EVENT_CURSOR");
    for (const event of this.#get(input.nativeSessionId).events.filter(
      (event) => event.sequence > cursor,
    )) {
      yield { ...event, payload: { ...event.payload } } as NormalizedRunEventDto;
    }
  }
  #settleApproval(
    session: FakeSession,
    decision: "approved" | "rejected",
    reason: "user" | "stopped",
  ): void {
    const approvalId = session.pendingApproval;
    if (!approvalId) return;
    session.pendingApproval = undefined;
    session.pendingStep = undefined;
    this.#emit(session, { type: "approval.resolved", payload: { approvalId, decision, reason } });
  }
  #advance(session: FakeSession): void {
    session.snapshot = { ...session.snapshot, state: "running" };
    while (session.nextStep < session.steps.length) {
      const index = session.nextStep;
      const step = session.steps[session.nextStep++];
      if (!step) break;
      if (step.type === "approval") {
        // A resumed session asks again under a new id: the old one was already reported.
        const approvalId = approvalIdFor(
          session.input.runId,
          session.generation ? `fake-${index}-r${session.generation}` : `fake-${index}`,
        );
        session.pendingApproval = approvalId;
        session.pendingStep = index;
        this.#emit(session, {
          type: "approval.requested",
          payload: {
            approvalId,
            kind: step.kind,
            summary: approvalSummary([step.summary]),
            risk: step.risk,
            ...(step.allowForSession ? { allowForSession: true } : {}),
          },
        });
        return;
      }
      if (step.type === "activity")
        this.#emit(session, { type: "run.activity", payload: { label: step.label } });
      else if (step.type === "message")
        this.#emit(session, { type: "run.message", payload: { text: step.text } });
      else if (step.type === "tool") {
        const { tool, summary } = step;
        this.#emit(session, {
          type: "tool.started",
          payload: { tool, summary, ...(step.reads ? { reads: [...step.reads] } : {}) },
        });
        this.#emit(session, {
          type: "tool.completed",
          payload: { tool, summary, success: step.success !== false },
        });
      } else if (step.type === "waiting") {
        this.#emit(session, { type: "run.waiting", payload: { reason: step.reason } });
        session.snapshot = { ...session.snapshot, state: "waiting" };
        return;
      } else if (step.type === "success") {
        this.#emit(session, { type: "run.completed", payload: { summary: step.summary } });
        session.snapshot = { ...session.snapshot, state: "completed" };
        return;
      } else {
        this.#emit(session, { type: "run.failed", payload: { message: step.message } });
        session.snapshot = { ...session.snapshot, state: "failed" };
        return;
      }
    }
    session.snapshot = { ...session.snapshot, state: "waiting" };
  }
  #end(session: FakeSession, state: "failed" | "stopped", message: string): void {
    if (state === "failed")
      this.#emit(session, {
        type: "run.failed",
        payload: { code: RESTART_INTERRUPTED_CODE, message },
      });
    else this.#emit(session, { type: "run.stopped", payload: { reason: message } });
    session.snapshot = { ...session.snapshot, state };
  }
  // Writes what a native runtime would keep on disk after every change.
  #persist(session: FakeSession): void {
    const terminal = ["completed", "failed", "stopped"].includes(session.snapshot.state)
      ? [...session.events]
          .reverse()
          .find((event) => ["run.completed", "run.failed", "run.stopped"].includes(event.type))
      : undefined;
    const previous = this.native.get(session.snapshot.nativeSessionId)?.terminal;
    this.native.set(session.snapshot.nativeSessionId, {
      input: session.input,
      steps: session.steps,
      nextStep: session.nextStep,
      state: session.snapshot.state,
      pendingStep: session.pendingStep,
      generation: session.generation,
      ...(terminal
        ? { terminal: { type: terminal.type, payload: { ...terminal.payload } } }
        : previous
          ? { terminal: previous }
          : {}),
    });
  }
  #emit(
    session: FakeSession,
    event: {
      [T in NormalizedRunEventDto["type"]]: {
        type: T;
        payload: Extract<NormalizedRunEventDto, { type: T }>["payload"];
      };
    }[NormalizedRunEventDto["type"]],
  ): void {
    const sequence = session.snapshot.lastSequence + 1;
    session.events.push({
      ...event,
      eventId: `${session.snapshot.nativeSessionId}:${sequence}`,
      sequence,
      runId: session.input.runId,
      workspaceId: session.input.workspace.workspaceId,
      workstationId: session.input.workstationId,
      occurredAt: this.now(),
    } as NormalizedRunEventDto);
    session.snapshot = { ...session.snapshot, lastSequence: sequence };
  }
  #get(id: string): FakeSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("RUNTIME_SESSION_NOT_FOUND");
    return session;
  }
  #snapshot(session: FakeSession): RuntimeSessionSnapshot {
    return { ...session.snapshot, workspace: { ...session.snapshot.workspace } };
  }
  #assertAssignment(session: FakeSession, input: StartRunInput): void {
    if (
      input.runId !== session.input.runId ||
      input.workstationId !== session.input.workstationId ||
      input.workspace.workspaceId !== session.input.workspace.workspaceId ||
      input.workspace.cwd !== session.input.workspace.cwd ||
      input.workspace.branch !== session.input.workspace.branch
    )
      throw new Error("RUNTIME_WORKSPACE_MISMATCH");
  }
}
