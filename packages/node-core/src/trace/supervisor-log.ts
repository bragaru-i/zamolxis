// The Supervisor's activity log for one message: what it observably did (phases, tool
// calls, files read, progress notes, refused approvals), how long it took, what it used
// and what it decided. Recorded on the Node from normalized runtime events, which are
// already redacted by the adapter; every step is normalized again (redacted, bounded)
// and delivered through the durable outbox. Reasoning text is never part of an event.
import {
  type NormalizedRunEventDto,
  SUPERVISOR_LOG_STEPS_LIMIT,
  type SupervisorLogStepDto,
  type SupervisorLogStepKind,
  TRACE_BATCH_LIMIT,
} from "@zamolxis/contracts";
import type { LocalStateStore } from "../persistence/local-state";
import { type TraceStepInput, traceStep } from "./recorder";

/** A batch of Supervisor log steps for one text command, delivered through the outbox. */
export interface SupervisorLogBatch {
  readonly kind: "supervisor.log";
  readonly textCommandId: string;
  readonly steps: readonly SupervisorLogStepDto[];
}

export interface SupervisorLogUsage {
  readonly modelActual?: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

type LogStepInput = Omit<TraceStepInput, "kind"> & { readonly kind: SupervisorLogStepKind };

const RUNTIME_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  hermes: "Hermes",
  fake: "Test runtime",
};
// Runtimes append a failure reason to a completed tool summary: "<summary> · exit code 1".
const RESULT_SUFFIX = / · (exit code -?\d+|declined|failed(?:: .*)?)$/;

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[A-Z_]{1,64}$/.test(message) ? message : "LOCAL_OPERATION_FAILED";
}
function count(value: number, one: string, many = `${one}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}
function usageLine(usage: SupervisorLogUsage): string | undefined {
  if (usage.totalTokens === undefined) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined)
    parts.push(`${usage.inputTokens.toLocaleString("en-US")} in`);
  if (usage.cachedInputTokens)
    parts.push(`${usage.cachedInputTokens.toLocaleString("en-US")} cached`);
  if (usage.outputTokens !== undefined)
    parts.push(`${usage.outputTokens.toLocaleString("en-US")} out`);
  const total = count(usage.totalTokens, "token");
  return parts.length ? `${total} (${parts.join(" · ")})` : total;
}

/**
 * Collects the log of one Supervisor turn. Step ids are scoped by the plan command, so a
 * replayed outbox batch is a no-op on the backend. At most SUPERVISOR_LOG_STEPS_LIMIT
 * steps are kept; one slot is reserved for the decision, and
 * later activity is counted instead of recorded.
 */
export class SupervisorLog {
  readonly #steps: SupervisorLogStepDto[] = [];
  readonly #index = new Map<string, number>();
  readonly #openTools: { tool: string; summary: string; stepId?: string }[] = [];
  #openPhase: { stepId: string; label: string } | undefined;
  #sequence = 0;
  #omitted = 0;
  #session: { stepId: string; startedAt: number; label: string; detail: string } | undefined;
  #usage: SupervisorLogUsage = {};
  #ended = false;
  #batches = 0;
  #lastCreatedAt = 0;
  constructor(
    private readonly store: LocalStateStore,
    readonly textCommandId: string,
    // Unique per plan command: scopes step ids and outbox event ids.
    private readonly scope: string,
    private readonly now: () => number = Date.now,
  ) {}
  get steps(): readonly SupervisorLogStepDto[] {
    return this.#steps;
  }
  /** Records a step (or replaces the step with the same id). */
  record(input: LogStepInput, reserved = false): SupervisorLogStepDto | undefined {
    const step: SupervisorLogStepDto = {
      ...traceStep({ ...input, kind: "supervisor" }),
      kind: input.kind,
    };
    const existing = this.#index.get(step.stepId);
    if (existing !== undefined) {
      const earlier = this.#steps[existing];
      const startedAt = Math.min(earlier?.startedAt ?? step.startedAt, step.startedAt);
      const settled: SupervisorLogStepDto = {
        ...step,
        startedAt,
        ...(step.finishedAt !== undefined
          ? { finishedAt: Math.max(startedAt, step.finishedAt) }
          : {}),
      };
      this.#steps[existing] = settled;
      return settled;
    }
    // One slot stays free for the decision (the session step is recorded first).
    if (this.#steps.length >= SUPERVISOR_LOG_STEPS_LIMIT - (reserved ? 0 : 1)) {
      this.#omitted++;
      return undefined;
    }
    this.#index.set(step.stepId, this.#steps.length);
    this.#steps.push(step);
    return step;
  }
  #id(kind: string): string {
    return `${this.scope}:${kind}:${String(++this.#sequence).padStart(4, "0")}`;
  }
  // A phase lasts until the next step starts.
  #closePhase(at: number): void {
    const phase = this.#openPhase;
    this.#openPhase = undefined;
    if (!phase) return;
    const index = this.#index.get(phase.stepId);
    const step = index === undefined ? undefined : this.#steps[index];
    if (step) this.#steps[index as number] = { ...step, finishedAt: Math.max(step.startedAt, at) };
  }
  /** The repository context the Supervisor was given. */
  discovery(input: TraceStepInput): void {
    if (input.kind !== "discovery") return;
    this.record({ ...input, kind: "discovery", stepId: `${this.scope}:discovery` }, true);
  }
  /** The Supervisor session starts on a runtime. */
  started(runtime: string, model?: string, reasoningEffort?: string): void {
    const startedAt = this.now();
    const detail = [
      RUNTIME_LABEL[runtime] ?? runtime,
      model ? `model ${model}` : undefined,
      reasoningEffort ? `reasoning ${reasoningEffort}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    this.#session = { stepId: `${this.scope}:session`, startedAt, label: "Supervisor", detail };
    this.record(
      {
        stepId: this.#session.stepId,
        kind: "supervisor",
        label: "Supervisor working",
        status: "started",
        startedAt,
        detail,
      },
      true,
    );
  }
  /** Records what a normalized Supervisor event shows. */
  observe(event: NormalizedRunEventDto): void {
    if (this.#ended) return;
    const at = this.now();
    switch (event.type) {
      case "run.usage": {
        const { modelActual, inputTokens, cachedInputTokens, outputTokens, totalTokens } =
          event.payload;
        this.#usage = {
          ...this.#usage,
          ...(typeof modelActual === "string" && modelActual ? { modelActual } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
        };
        return;
      }
      case "run.activity": {
        const label = event.payload.label?.trim();
        if (!label || this.#openPhase?.label === label) return;
        this.#closePhase(at);
        const stepId = this.#id("phase");
        if (
          this.record({
            stepId,
            kind: "phase",
            label,
            status: "passed",
            startedAt: at,
            finishedAt: at,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          })
        )
          this.#openPhase = { stepId, label };
        return;
      }
      case "tool.started": {
        this.#closePhase(at);
        const { tool, summary } = event.payload;
        const reads = Array.isArray(event.payload.reads)
          ? event.payload.reads.filter((path) => typeof path === "string" && path)
          : [];
        const stepId = this.#id("tool");
        const recorded = this.record({
          stepId,
          kind: "tool",
          label: summary || tool,
          status: "started",
          startedAt: at,
          ...(reads.length ? { detail: `Read ${reads.join(", ")}` } : {}),
        });
        // An omitted call stays open too, so its completion is not counted twice.
        this.#openTools.push({ tool, summary: summary.trim(), ...(recorded ? { stepId } : {}) });
        return;
      }
      case "tool.completed": {
        this.#closePhase(at);
        const { tool, summary, success } = event.payload;
        const bare = summary.trim().replace(RESULT_SUFFIX, "");
        let index = this.#openTools.findIndex(
          (open) => open.tool === tool && !!bare && open.summary === bare,
        );
        if (index < 0) index = this.#openTools.findIndex((open) => open.tool === tool);
        const [open] = index >= 0 ? this.#openTools.splice(index, 1) : [];
        if (open && !open.stepId) return;
        const previous = open?.stepId ? this.#steps[this.#index.get(open.stepId) ?? -1] : undefined;
        this.record({
          stepId: open?.stepId ?? this.#id("tool"),
          kind: "tool",
          label: summary || tool,
          status: success ? "passed" : "failed",
          startedAt: previous?.startedAt ?? at,
          finishedAt: at,
          ...(previous?.detail ? { detail: previous.detail } : {}),
        });
        return;
      }
      case "run.message":
        this.#closePhase(at);
        this.record({
          stepId: this.#id("message"),
          kind: "message",
          label: "Note",
          status: "passed",
          startedAt: at,
          finishedAt: at,
          detail: event.payload.text,
        });
        return;
      case "approval.requested":
        this.#closePhase(at);
        this.record({
          stepId: this.#id("approval"),
          kind: "approval",
          label: "Approval request refused",
          status: "failed",
          startedAt: at,
          finishedAt: at,
          detail: `The Supervisor is read-only. ${event.payload.summary}`,
        });
        return;
      default:
        return;
    }
  }
  /** Settles the session with its outcome, duration and usage. */
  ended(state: string, usage?: SupervisorLogUsage, error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    const at = this.now();
    this.#closePhase(at);
    // Tool calls without a result: the turn ended before they reported one.
    for (const open of this.#openTools.splice(0)) {
      const index = open.stepId ? this.#index.get(open.stepId) : undefined;
      const step = index === undefined ? undefined : this.#steps[index];
      if (step) this.record({ ...step, status: "skipped", finishedAt: at });
    }
    if (usage) this.#usage = { ...this.#usage, ...usage };
    const session = this.#session;
    if (!session) return;
    const labels: Record<string, string> = {
      completed: "Supervisor finished",
      stopped: "Supervisor stopped",
      failed: "Supervisor failed",
    };
    const detail = [
      [session.detail, this.#usage.modelActual ? `reported model ${this.#usage.modelActual}` : ""]
        .filter(Boolean)
        .join(" · "),
      usageLine(this.#usage),
      error !== undefined ? `Failure: ${errorCode(error)}` : undefined,
      this.#omitted ? `${count(this.#omitted, "later step")} not recorded` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    this.record(
      {
        stepId: session.stepId,
        kind: "supervisor",
        label: labels[state] ?? "Supervisor did not finish",
        status: state === "completed" ? "passed" : "failed",
        startedAt: session.startedAt,
        finishedAt: at,
        ...(detail ? { detail } : {}),
      },
      true,
    );
  }
  /** What the Node did with the Supervisor's reply. */
  decided(
    decision: {
      readonly decision: "answer" | "propose" | "delegate" | "ask";
      readonly tasks: readonly { readonly title: string }[];
    },
    note?: string,
  ): void {
    const at = this.now();
    const label =
      decision.decision === "propose" || decision.decision === "delegate"
        ? `${decision.decision === "delegate" ? "Opened" : "Proposed"} ${count(decision.tasks.length, "task")}`
        : decision.decision === "ask"
          ? "Asked a clarifying question"
          : "Answered";
    const detail = [
      decision.tasks.map((task, index) => `${index + 1}. ${task.title}`).join("\n"),
      note,
    ]
      .filter(Boolean)
      .join("\n\n");
    this.record(
      {
        stepId: `${this.scope}:decision`,
        kind: "supervisor",
        label,
        status: "passed",
        startedAt: at,
        finishedAt: at,
        ...(detail ? { detail } : {}),
      },
      true,
    );
  }
  /** The message was not answered: why (a stable code, never free text). */
  failed(error: unknown): void {
    if (!this.#ended) this.ended("failed", undefined, error);
    const at = this.now();
    const code = errorCode(error);
    this.record(
      {
        stepId: `${this.scope}:decision`,
        kind: "supervisor",
        label: code === "SUPERVISOR_STOPPED" ? "Stopped before answering" : "No answer",
        status: "failed",
        startedAt: at,
        finishedAt: at,
        detail: `Failure: ${code}`,
      },
      true,
    );
  }
  /** Appends the log to the outbox (once); returns true when anything was written. */
  persist(): boolean {
    if (!this.#steps.length) return false;
    const steps = this.#steps.splice(0);
    this.#index.clear();
    for (let offset = 0; offset < steps.length; offset += TRACE_BATCH_LIMIT) {
      // Outbox order is (createdAt, eventId): keep this log's batches ordered.
      const createdAt = Math.max(Date.now(), this.#lastCreatedAt + 1);
      this.#lastCreatedAt = createdAt;
      const payload: SupervisorLogBatch = {
        kind: "supervisor.log",
        textCommandId: this.textCommandId,
        steps: steps.slice(offset, offset + TRACE_BATCH_LIMIT),
      };
      this.store.appendEvent({
        eventId: `supervisor-log:${this.scope}:${String(this.#batches++).padStart(4, "0")}`,
        type: "control-plane.delivery",
        payload,
        createdAt,
      });
    }
    return true;
  }
}
