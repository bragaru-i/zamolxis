import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRisk,
  NormalizedRunEventDto,
  RuntimeCapabilitiesDto,
} from "@zamolxis/contracts";
import type {
  AgentRuntime,
  ResumeRunInput,
  RuntimeSessionSnapshot,
  StartRunInput,
} from "../agent-runtime";
import { approvalIdFor, approvalSummary } from "../approvals";

export type FakeStep =
  | { readonly type: "activity"; readonly label: string }
  | { readonly type: "waiting"; readonly reason: string }
  | { readonly type: "success"; readonly summary: string }
  | { readonly type: "failure"; readonly message: string }
  // Holds the scenario until resolveApproval; stop rejects it.
  | {
      readonly type: "approval";
      readonly kind: ApprovalKind;
      readonly summary: string;
      readonly risk: ApprovalRisk;
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
      steps: typeof this.scenario === "function" ? this.scenario(copied) : this.scenario,
    };
    this.#sessions.set(nativeSessionId, session);
    this.#runs.set(input.runId, nativeSessionId);
    this.#emit(session, { type: "run.started", payload: { nativeSessionId } });
    this.#advance(session);
    return this.#snapshot(session);
  }
  async resume(input: ResumeRunInput): Promise<RuntimeSessionSnapshot> {
    const session = this.#get(input.nativeSessionId);
    this.#assertAssignment(session, input);
    if (session.snapshot.state === "waiting") this.#advance(session);
    return this.#snapshot(session);
  }
  async send(input: { nativeSessionId: string; message: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (session.snapshot.state !== "waiting" && session.snapshot.state !== "running")
      throw new Error("RUNTIME_TERMINAL");
    this.#emit(session, { type: "run.activity", payload: { label: "Message received" } });
    // A message never settles a pending approval.
    if (!session.pendingApproval) this.#advance(session);
  }
  async resolveApproval(input: {
    nativeSessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (!session.pendingApproval || session.pendingApproval !== input.approvalId)
      throw new Error("APPROVAL_NOT_PENDING");
    this.#settleApproval(session, input.decision === "approve" ? "approved" : "rejected", "user");
    this.#advance(session);
  }
  async stop(input: { nativeSessionId: string }): Promise<void> {
    const session = this.#get(input.nativeSessionId);
    if (["completed", "failed", "stopped"].includes(session.snapshot.state)) return;
    this.#settleApproval(session, "rejected", "stopped");
    this.#emit(session, { type: "run.stopped", payload: { reason: "Stop requested" } });
    session.snapshot = { ...session.snapshot, state: "stopped" };
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
    this.#emit(session, { type: "approval.resolved", payload: { approvalId, decision, reason } });
  }
  #advance(session: FakeSession): void {
    session.snapshot = { ...session.snapshot, state: "running" };
    while (session.nextStep < session.steps.length) {
      const index = session.nextStep;
      const step = session.steps[session.nextStep++];
      if (!step) break;
      if (step.type === "approval") {
        const approvalId = approvalIdFor(session.input.runId, `fake-${index}`);
        session.pendingApproval = approvalId;
        this.#emit(session, {
          type: "approval.requested",
          payload: {
            approvalId,
            kind: step.kind,
            summary: approvalSummary([step.summary]),
            risk: step.risk,
          },
        });
        return;
      }
      if (step.type === "activity")
        this.#emit(session, { type: "run.activity", payload: { label: step.label } });
      else if (step.type === "waiting") {
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
