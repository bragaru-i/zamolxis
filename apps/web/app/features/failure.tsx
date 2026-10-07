import { runtimeLabel } from "./run-detail-model";

/** Who failed, on which runtime and model, when, and the provider's reason. */
export interface FailureInfo {
  who: string;
  runtime?: string;
  model?: string;
  modelActual?: string;
  reason?: string;
  at: number;
}

const ROLE_NAMES: Record<string, string> = {
  supervisor: "Supervisor",
  orchestrator: "Assistant",
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
};
export function agentName(role: string | undefined): string {
  return ROLE_NAMES[role ?? ""] ?? "Agent";
}

// "14:03" today, "Oct 6, 14:03" on another day.
export function failureTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** "Supervisor · Claude · claude-opus-5-5 · failed at 00:13". */
export function failureSummary(failure: FailureInfo, now = Date.now()): string {
  const engine = failure.runtime
    ? runtimeLabel({
        runtime: failure.runtime,
        ...(failure.model ? { modelRequested: failure.model } : {}),
        ...(failure.modelActual ? { modelActual: failure.modelActual } : {}),
      })
    : undefined;
  return [failure.who, engine, `failed at ${failureTime(failure.at, now)}`]
    .filter(Boolean)
    .join(" · ");
}

// Runtime prefixes ("Codex turn failed: ") repeat what the summary already says.
export function failureReason(reason: string | undefined): string | undefined {
  const text = reason?.replace(/^(Codex|Claude) turn failed:?\s*/i, "").trim();
  return text || undefined;
}

export function FailureDetails({ failure }: { failure: FailureInfo }) {
  const reason = failureReason(failure.reason);
  return (
    <div className="z-stack" role="note" aria-label="What failed">
      <span className="z-xsmall z-muted">{failureSummary(failure)}</span>
      {reason && <span className="z-small">Reason: {reason}</span>}
    </div>
  );
}

/** A failed agent run's details, when the runtime reported why. */
export function runFailure(run: {
  role?: string;
  runtime: string;
  modelRequested?: string;
  modelActual?: string;
  status: string;
  failure?: { code?: string; reason?: string; at: number };
}): FailureInfo | undefined {
  if (run.status !== "failed" || !run.failure) return undefined;
  const reason = run.failure.reason ?? run.failure.code;
  return {
    who: agentName(run.role ?? "builder"),
    runtime: run.runtime,
    ...(run.modelRequested ? { model: run.modelRequested } : {}),
    ...(run.modelActual ? { modelActual: run.modelActual } : {}),
    ...(reason ? { reason } : {}),
    at: run.failure.at,
  };
}

export function RunFailure({ run }: { run: Parameters<typeof runFailure>[0] }) {
  const failure = runFailure(run);
  return failure ? <FailureDetails failure={failure} /> : null;
}
