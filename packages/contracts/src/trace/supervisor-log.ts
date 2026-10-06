// The Supervisor's activity log for one message (text command): what it observably did
// while deciding to answer, plan or ask. It reuses the TraceStepDto contract and bounds;
// only the step kinds differ. Steps never carry reasoning; text is redacted on the Node.
import { type TraceStepDto, traceStepProblem } from "./trace-step";

export const SUPERVISOR_LOG_STEP_KINDS = [
  // Repository context the Supervisor was given.
  "discovery",
  // The Supervisor session itself (runtime, model, duration, usage) and its decision.
  "supervisor",
  // A phase such as "Thinking" or "Writing reply".
  "phase",
  // A command, MCP tool, web search or sub-agent call.
  "tool",
  // A progress note the Supervisor wrote while working.
  "message",
  // An approval the Node refused (the Supervisor is read-only).
  "approval",
] as const;
export type SupervisorLogStepKind = (typeof SUPERVISOR_LOG_STEP_KINDS)[number];

/** Steps stored per message; later steps are dropped (the outcome step is always kept). */
export const SUPERVISOR_LOG_STEPS_LIMIT = 300;

export interface SupervisorLogStepDto extends Omit<TraceStepDto, "kind"> {
  readonly kind: SupervisorLogStepKind;
}

/** Returns why a value is not a valid SupervisorLogStepDto, or undefined when it is. */
export function supervisorLogStepProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return "step";
  const { kind } = value as { kind?: unknown };
  if (!SUPERVISOR_LOG_STEP_KINDS.includes(kind as SupervisorLogStepKind)) return "kind";
  // Every other field follows the trace step contract.
  return traceStepProblem({ ...value, kind: "supervisor" });
}
