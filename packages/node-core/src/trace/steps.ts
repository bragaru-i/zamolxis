// Builders for the trace steps the control-plane driver records for a Run. Step ids are
// stable: scoped by the command that observed them, except the runtime step, which every
// command following the Run settles under one id.
import type { TraceStepStatus } from "@zamolxis/contracts";
import type { CheckObservation } from "../verification/checks";
import type { TraceStepInput } from "./recorder";

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z_]{1,64}$/.test(message) ? message : "LOCAL_OPERATION_FAILED";
}
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function discoveryStep(
  scope: string,
  startedAt: number,
  outcome:
    | {
        readonly gitSha: string;
        readonly discoveredSources: readonly string[];
        readonly resolvedCapabilities: Readonly<Record<string, unknown>>;
      }
    | { readonly error: unknown },
): TraceStepInput {
  const base = {
    stepId: `${scope}:discovery`,
    kind: "discovery",
    startedAt,
    finishedAt: Date.now(),
  } as const;
  if ("error" in outcome)
    return {
      ...base,
      label: "Repository discovery failed",
      status: "failed",
      detail: errorCode(outcome.error),
    };
  const capabilities = Object.keys(outcome.resolvedCapabilities);
  return {
    ...base,
    label: "Repository discovered",
    status: "passed",
    detail: `${plural(outcome.discoveredSources.length, "source", "sources")}, ${plural(capabilities.length, "capability", "capabilities")}${capabilities.length ? `: ${capabilities.join(", ")}` : ""}`,
    references: { sha: outcome.gitSha },
  };
}

export function workspaceStep(
  scope: string,
  at: number,
  workspace: {
    readonly branch: string;
    readonly baseSha: string;
    readonly headSha?: string;
    readonly dirty: boolean;
  },
): TraceStepInput {
  const head = workspace.headSha ?? workspace.baseSha;
  return {
    stepId: `${scope}:workspace`,
    kind: "workspace",
    label: "Workspace ready",
    status: "passed",
    startedAt: at,
    finishedAt: at,
    detail: `Branch ${workspace.branch} at ${head.slice(0, 12)}${head !== workspace.baseSha ? ` (base ${workspace.baseSha.slice(0, 12)})` : ""}${workspace.dirty ? ", with uncommitted changes" : ""}`,
    references: { sha: head },
  };
}

const RUNTIME_STATUS: Record<string, TraceStepStatus> = {
  completed: "passed",
  failed: "failed",
  stopped: "failed",
};

/** The Run's runtime session: "started" while it works, settled once it is terminal. */
export function runtimeStep(
  runId: string,
  runtime: string,
  at: number,
  state: "started" | "completed" | "failed" | "stopped",
  error?: unknown,
): TraceStepInput {
  return {
    stepId: `run:${runId}:runtime`,
    kind: "runtime",
    label: `Runtime ${runtime} ${state === "started" ? "running" : state}`,
    status: state === "started" ? "started" : (RUNTIME_STATUS[state] ?? "failed"),
    startedAt: at,
    ...(state === "started" ? {} : { finishedAt: Math.max(at, Date.now()) }),
    ...(error !== undefined ? { detail: errorCode(error) } : {}),
    references: { runId },
  };
}

export function candidateStep(
  scope: string,
  startedAt: number,
  outcome: { readonly before: string; readonly after: string } | { readonly error: unknown },
): TraceStepInput {
  const base = {
    stepId: `${scope}:candidate`,
    kind: "workspace",
    startedAt,
    finishedAt: Date.now(),
  } as const;
  if ("error" in outcome)
    return {
      ...base,
      label: "Candidate commit failed",
      status: "failed",
      detail: errorCode(outcome.error),
    };
  const changed = outcome.after !== outcome.before;
  return {
    ...base,
    label: changed ? "Candidate committed" : "Candidate unchanged",
    status: "passed",
    detail: changed
      ? `Committed ${outcome.after.slice(0, 12)} on ${outcome.before.slice(0, 12)}`
      : `No changes to commit; the candidate is ${outcome.after.slice(0, 12)}`,
    references: { sha: outcome.after },
  };
}

export function checkStep(
  scope: string,
  index: number,
  check: CheckObservation,
  sha?: string,
): TraceStepInput {
  return {
    stepId: `${scope}:check:${String(index).padStart(3, "0")}`,
    kind: "verification-check",
    label: check.command,
    status: check.result,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    output: check.output,
    references: {
      ...(check.script ? { script: check.script } : {}),
      ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
      ...(sha ? { sha } : {}),
    },
  };
}

/** A resume of the Run's native session after a Node restart (one step per attempt). */
export function recoveryStep(
  runId: string,
  attempt: number,
  at: number,
  outcome:
    | { readonly policy: "continue" | "fail" | "stop"; readonly state: string }
    | { readonly settled: string }
    | { readonly error: unknown },
): TraceStepInput {
  const base = {
    stepId: `run:${runId}:recovery:${attempt}`,
    kind: "runtime",
    startedAt: at,
    finishedAt: Math.max(at, Date.now()),
    references: { runId },
  } as const;
  if ("error" in outcome)
    return {
      ...base,
      label: "Could not resume after a Node restart",
      status: "failed",
      detail: `${errorCode(outcome.error)}; the run keeps its workspace until it is reconciled`,
    };
  if ("settled" in outcome)
    return {
      ...base,
      label: "Recorded the outcome after a Node restart",
      status: "passed",
      detail: `The runtime had already reported ${outcome.settled}`,
    };
  const detail =
    outcome.policy === "continue"
      ? "An interrupted turn continues on the same native session"
      : outcome.policy === "stop"
        ? "A stop was requested: an interrupted turn is reported stopped"
        : "An interrupted turn is reported failed (continuation limit reached)";
  return {
    ...base,
    label: "Resumed after a Node restart",
    status: "passed",
    detail: `${detail}; runtime state ${outcome.state}`,
  };
}
