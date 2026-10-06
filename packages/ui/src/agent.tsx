import type { ReactNode } from "react";
import { statusLabel } from "./index";

/** "48.2k", "1.2M", "900": token counts at a glance (full count in the title). */
export function compactCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000)
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "12s", "7m 05s", "1h 02m": how long an agent has been working. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Provider-reported cost, never estimated by the app. */
export function costLabel(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

const LIVE = new Set(["starting", "running", "verifying", "repairing", "stopping"]);

/**
 * One agent at a glance, the way a terminal agent shows itself: who it is (role, runtime,
 * model), what it is doing now, for how long, and what it has used so far.
 */
export function AgentRow({
  role,
  runtime,
  model,
  status,
  activity,
  elapsedMs,
  tokens,
  costUsd,
  context,
  actions,
  onOpen,
  openLabel = "Open details",
}: {
  role: string;
  runtime?: string | undefined;
  model?: string | undefined;
  status: string;
  /** What the agent is doing now (only meaningful while it works). */
  activity?: string | undefined;
  elapsedMs?: number | undefined;
  tokens?: number | undefined;
  costUsd?: number | undefined;
  /** Where this agent works, e.g. the Session or Task title. */
  context?: ReactNode | undefined;
  /** Buttons at the trailing edge (Stop, Dismiss). */
  actions?: ReactNode | undefined;
  onOpen?: (() => void) | undefined;
  openLabel?: string;
}) {
  const resolved = statusLabel(status);
  const live = LIVE.has(status) || status === "queued" || status === "waiting";
  const facts = [
    elapsedMs !== undefined ? elapsed(elapsedMs) : undefined,
    tokens !== undefined ? `${compactCount(tokens)} tokens` : undefined,
    costUsd !== undefined ? costLabel(costUsd) : undefined,
  ].filter(Boolean);
  const body = (
    <>
      <span className="z-agent__head">
        <span
          className={`z-agent__pulse z-tone-${resolved.tone}`}
          data-live={live || undefined}
          aria-hidden="true"
        />
        <strong className="z-agent__role">{role}</strong>
        <span className={`z-badge z-tone-${resolved.tone}`}>{resolved.label}</span>
      </span>
      {(runtime || model) && (
        <span className="z-agent__model">
          {runtime}
          {runtime && model ? " · " : ""}
          {model && <code className="z-agent__code">{model}</code>}
        </span>
      )}
      {context && <span className="z-agent__context">{context}</span>}
      {live && activity && <span className="z-agent__activity">{activity}</span>}
      {facts.length > 0 && (
        <span
          className="z-agent__facts"
          title={tokens !== undefined ? `${tokens.toLocaleString("en-US")} tokens` : undefined}
        >
          {facts.join(" · ")}
        </span>
      )}
    </>
  );
  return (
    <div className="z-agent" data-status={status}>
      {onOpen ? (
        <button
          type="button"
          className="z-agent__main z-agent__main--button"
          aria-haspopup="dialog"
          aria-label={openLabel}
          onClick={onOpen}
        >
          {body}
          <span className="z-agent__chevron" aria-hidden="true">
            ›
          </span>
        </button>
      ) : (
        <div className="z-agent__main">{body}</div>
      )}
      {actions && <div className="z-agent__actions">{actions}</div>}
    </div>
  );
}
