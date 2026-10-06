import {
  TRACE_BATCH_LIMIT,
  TRACE_DETAIL_LIMIT,
  TRACE_LABEL_LIMIT,
  TRACE_OUTPUT_TAIL_LIMIT,
  TRACE_RUN_ID_LIMIT,
  TRACE_STEP_ID_LIMIT,
  type TraceStepDto,
  type TraceStepKind,
  type TraceStepReferences,
  type TraceStepStatus,
} from "@zamolxis/contracts";
import { boundText, redactSecrets } from "@zamolxis/runtime-core";
import type { LocalStateStore } from "../persistence/local-state";

/** A batch of trace steps for one Run, delivered through the control-plane outbox. */
export interface TraceBatch {
  readonly kind: "run.trace";
  readonly runId: string;
  readonly steps: readonly TraceStepDto[];
}

export interface TraceStepInput {
  /** Stable step identity (see TraceStepDto.stepId). */
  readonly stepId: string;
  readonly kind: TraceStepKind;
  readonly label: string;
  readonly status: TraceStepStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly detail?: string;
  /** Command output: only its redacted tail is kept, as the step detail. */
  readonly output?: string;
  readonly references?: TraceStepReferences;
}

const SHA = /^[0-9a-f]{7,64}$/;
const SCRIPT = /^[a-zA-Z0-9:_-]{1,64}$/;

/** Redacted, bounded detail text (the head is kept). */
export function traceDetail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const bounded = boundText(redactSecrets(text), TRACE_DETAIL_LIMIT);
  return bounded || undefined;
}

/** Redacted command output, keeping its last TRACE_OUTPUT_TAIL_LIMIT characters. */
export function outputTail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Redact the whole capture first, so a cut never splits a secret into an unmatched part.
  const redacted = redactSecrets(text).trimEnd();
  if (!redacted.trim()) return undefined;
  return redacted.length > TRACE_OUTPUT_TAIL_LIMIT
    ? `…${redacted.slice(redacted.length - (TRACE_OUTPUT_TAIL_LIMIT - 1))}`
    : redacted;
}

function references(value: TraceStepReferences | undefined): TraceStepReferences | undefined {
  if (!value) return undefined;
  const result: { -readonly [K in keyof TraceStepReferences]: TraceStepReferences[K] } = {};
  if (value.runId && value.runId.length <= TRACE_RUN_ID_LIMIT) result.runId = value.runId;
  if (value.sha && SHA.test(value.sha)) result.sha = value.sha;
  if (value.script && SCRIPT.test(value.script)) result.script = value.script;
  if (value.exitCode !== undefined && Number.isSafeInteger(value.exitCode))
    result.exitCode = value.exitCode;
  return Object.keys(result).length ? result : undefined;
}

/** Normalizes a step so it always satisfies the TraceStepDto bounds. */
export function traceStep(input: TraceStepInput): TraceStepDto {
  if (!input.stepId || input.stepId.length > TRACE_STEP_ID_LIMIT)
    throw new Error("INVALID_TRACE_STEP_ID");
  const label =
    boundText(redactSecrets(input.label).replace(/\s+/g, " "), TRACE_LABEL_LIMIT) || input.kind;
  const startedAt = Math.max(1, Math.floor(input.startedAt));
  const detail = input.output !== undefined ? outputTail(input.output) : traceDetail(input.detail);
  const refs = references(input.references);
  return {
    stepId: input.stepId,
    kind: input.kind,
    label,
    status: input.status,
    startedAt,
    ...(input.finishedAt !== undefined
      ? { finishedAt: Math.max(startedAt, Math.floor(input.finishedAt)) }
      : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { references: refs } : {}),
  };
}

/**
 * Collects the trace steps of one Run observed by one command and writes them to the
 * durable outbox in order. Steps keep the identity the caller gives them, so a replayed
 * outbox event is idempotent; a step recorded twice before persisting keeps its latest form.
 */
export class TraceRecorder {
  readonly #pending: TraceStepDto[] = [];
  // When each step recorded here started, so settling a step keeps its start time.
  readonly #startedAt = new Map<string, number>();
  #batches = 0;
  #lastCreatedAt = 0;
  constructor(
    private readonly store: LocalStateStore,
    readonly runId: string,
    // Unique per recorder (the command id): names the outbox events.
    private readonly scope: string,
  ) {}
  record(input: TraceStepInput): TraceStepDto {
    let step = traceStep(input);
    const earlier = this.#startedAt.get(step.stepId);
    if (earlier !== undefined && earlier < step.startedAt) step = { ...step, startedAt: earlier };
    this.#startedAt.set(step.stepId, step.startedAt);
    const index = this.#pending.findIndex((pending) => pending.stepId === step.stepId);
    if (index >= 0) this.#pending[index] = step;
    else this.#pending.push(step);
    return step;
  }
  get pending(): readonly TraceStepDto[] {
    return this.#pending;
  }
  /** Appends the pending steps to the outbox; returns true when anything was written. */
  persist(): boolean {
    if (!this.#pending.length) return false;
    const steps = this.#pending.splice(0);
    for (let offset = 0; offset < steps.length; offset += TRACE_BATCH_LIMIT) {
      // Outbox order is (createdAt, eventId): keep batches of this recorder ordered.
      const createdAt = Math.max(Date.now(), this.#lastCreatedAt + 1);
      this.#lastCreatedAt = createdAt;
      const payload: TraceBatch = {
        kind: "run.trace",
        runId: this.runId,
        steps: steps.slice(offset, offset + TRACE_BATCH_LIMIT),
      };
      this.store.appendEvent({
        eventId: `trace:${this.scope}:${String(this.#batches++).padStart(4, "0")}`,
        type: "control-plane.delivery",
        payload,
        createdAt,
      });
    }
    return true;
  }
}
