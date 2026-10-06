// One normalized, runtime-neutral step of a Run's execution trace. Steps describe what
// the Node observably did (discovery, workspace, runtime, checks, candidate commit); they
// never carry agent reasoning. Detail text is redacted and bounded before it leaves the Node.

export const TRACE_STEP_KINDS = [
  "discovery",
  "supervisor",
  "workspace",
  "runtime",
  "verification-check",
  "trust",
  "integration",
] as const;
export type TraceStepKind = (typeof TRACE_STEP_KINDS)[number];

export const TRACE_STEP_STATUSES = ["started", "passed", "failed", "skipped"] as const;
export type TraceStepStatus = (typeof TRACE_STEP_STATUSES)[number];

export const TRACE_STEP_ID_LIMIT = 256;
export const TRACE_LABEL_LIMIT = 200;
export const TRACE_DETAIL_LIMIT = 2000;
/** Command output kept for a verification check: the redacted tail. */
export const TRACE_OUTPUT_TAIL_LIMIT = 1000;
export const TRACE_SCRIPT_LIMIT = 64;
export const TRACE_RUN_ID_LIMIT = 128;
/** Steps per delivered batch. */
export const TRACE_BATCH_LIMIT = 100;
/** Steps stored per Run trace. */
export const TRACE_STEPS_PER_RUN_LIMIT = 500;

export interface TraceStepReferences {
  readonly runId?: string;
  readonly sha?: string;
  readonly script?: string;
  readonly exitCode?: number;
}

export interface TraceStepDto {
  /**
   * Stable identity chosen by the Node. Re-delivering a step is a no-op; a step first
   * delivered as "started" may be settled once by delivering it again with a final status.
   */
  readonly stepId: string;
  readonly kind: TraceStepKind;
  readonly label: string;
  readonly status: TraceStepStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly detail?: string;
  readonly references?: TraceStepReferences;
}

const SHA = /^[0-9a-f]{7,64}$/;
const SCRIPT = /^[a-zA-Z0-9:_-]{1,64}$/;

function boundedString(value: unknown, limit: number, required: boolean): boolean {
  if (value === undefined) return !required;
  return typeof value === "string" && value.length <= limit && (!required || value.length > 0);
}

/** Returns why a value is not a valid TraceStepDto, or undefined when it is. */
export function traceStepProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return "step";
  const step = value as Record<string, unknown>;
  if (!boundedString(step.stepId, TRACE_STEP_ID_LIMIT, true)) return "stepId";
  if (!TRACE_STEP_KINDS.includes(step.kind as TraceStepKind)) return "kind";
  if (!boundedString(step.label, TRACE_LABEL_LIMIT, true)) return "label";
  if (!TRACE_STEP_STATUSES.includes(step.status as TraceStepStatus)) return "status";
  if (typeof step.startedAt !== "number" || !Number.isFinite(step.startedAt) || step.startedAt <= 0)
    return "startedAt";
  if (
    step.finishedAt !== undefined &&
    (typeof step.finishedAt !== "number" ||
      !Number.isFinite(step.finishedAt) ||
      step.finishedAt < step.startedAt)
  )
    return "finishedAt";
  if (!boundedString(step.detail, TRACE_DETAIL_LIMIT, false)) return "detail";
  if (step.references !== undefined) {
    if (step.references === null || typeof step.references !== "object") return "references";
    const references = step.references as Record<string, unknown>;
    if (!boundedString(references.runId, TRACE_RUN_ID_LIMIT, false)) return "references.runId";
    if (
      references.sha !== undefined &&
      (typeof references.sha !== "string" || !SHA.test(references.sha))
    )
      return "references.sha";
    if (
      references.script !== undefined &&
      (typeof references.script !== "string" || !SCRIPT.test(references.script))
    )
      return "references.script";
    if (
      references.exitCode !== undefined &&
      (typeof references.exitCode !== "number" || !Number.isSafeInteger(references.exitCode))
    )
      return "references.exitCode";
  }
  return undefined;
}
