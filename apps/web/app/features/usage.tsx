"use client";
import { KeyValueList, SegmentedControl, Stat, StatGrid } from "@zamolxis/ui";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

/** Mirrors `UsageTotals` in convex/usage.ts. */
export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  items: number;
  reported: number;
  costUsd?: number;
}
export interface UsageBreakdown {
  total: UsageTotals;
  byRole: Array<UsageTotals & { role: string }>;
  byModel: Array<UsageTotals & { model?: string }>;
  truncated: boolean;
}
export interface UsageSummary extends UsageBreakdown {
  period: Period;
  sessionCount: number;
  topSessions: Array<UsageTotals & { _id: Id<"workSessions">; title: string; status: string }>;
}
export type Period = "24h" | "7d" | "30d";

const ROLE_LABEL: Record<string, string> = {
  supervisor: "Supervisor",
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
};
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export function formatTokens(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "token" : "tokens"}`;
}

/** Provider-reported cost; callers only pass values a provider reported. */
export function formatCost(usd: number): string {
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** "Not reported" when nothing reported tokens, so zero never looks like a measurement. */
export function tokensOrUnreported(totals: UsageTotals): string {
  return totals.reported ? formatTokens(totals.totalTokens) : "Not reported";
}

function withCost(totals: UsageTotals): string {
  const tokens = tokensOrUnreported(totals);
  return totals.costUsd !== undefined ? `${tokens} · ${formatCost(totals.costUsd)}` : tokens;
}

export function coverageNote(totals: UsageTotals): string | undefined {
  if (totals.reported === totals.items) return undefined;
  return `${totals.reported} of ${totals.items} agent turns reported usage; the rest are not counted.`;
}

function Breakdown({ usage }: { usage: UsageBreakdown }) {
  const note = coverageNote(usage.total);
  return (
    <>
      <KeyValueList
        label="Tokens by role"
        items={usage.byRole.map((row) => ({
          key: row.role,
          label: ROLE_LABEL[row.role] ?? row.role,
          value: withCost(row),
        }))}
      />
      {usage.byModel.length > 0 && (
        <KeyValueList
          label="Tokens by model"
          items={usage.byModel.map((row) => ({
            key: row.model ?? "",
            label: row.model ? <span className="z-mono">{row.model}</span> : "Model not reported",
            value: withCost(row),
          }))}
        />
      )}
      {note && <p className="z-xsmall z-muted">{note}</p>}
    </>
  );
}

/** Collapsed usage row for one Session: total in the summary, breakdown when opened. */
export function SessionUsage({
  sessionId,
  ready,
}: {
  sessionId: Id<"workSessions">;
  ready: boolean;
}) {
  const usage = useQuery(api.usage.session, ready ? { workSessionId: sessionId } : "skip") as
    | UsageBreakdown
    | undefined;
  if (!usage || usage.total.items === 0) return null;
  return (
    <details className="z-usage">
      <summary>
        <span>Usage</span>
        <span className="z-spacer" />
        <span>{withCost(usage.total)}</span>
      </summary>
      <div className="z-usage__body">
        <Breakdown usage={usage} />
      </div>
    </details>
  );
}

/** Settings section: owner totals for a period and the sessions that used the most. */
export function UsageSettings({
  active,
  onOpenSession,
  showTitle = true,
}: {
  active: boolean;
  onOpenSession?: (id: Id<"workSessions">) => void;
  /** Off when the surrounding page already names the section. */
  showTitle?: boolean;
}) {
  const [period, setPeriod] = useState<Period>("7d");
  const usage = useQuery(api.usage.summary, active ? { period } : "skip") as
    | UsageSummary
    | undefined;
  return (
    <section className="z-stack" aria-label="Usage">
      {showTitle && <h3 className="z-section-title">Usage</h3>}
      <SegmentedControl label="Period" options={PERIODS} value={period} onChange={setPeriod} />
      {usage === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading usage…
        </p>
      ) : usage.total.items === 0 ? (
        <p className="z-muted z-small">No agent work in this period.</p>
      ) : (
        <>
          <StatGrid>
            <Stat
              label="Tokens"
              value={usage.total.reported ? usage.total.totalTokens.toLocaleString("en-US") : "—"}
              detail={usage.total.reported ? undefined : "Not reported"}
            />
            <Stat label="Sessions" value={usage.sessionCount} />
            {usage.total.costUsd !== undefined && (
              <Stat
                label="Cost"
                value={formatCost(usage.total.costUsd)}
                detail="Reported by provider"
              />
            )}
          </StatGrid>
          <Breakdown usage={usage} />
          {usage.topSessions.length > 0 && (
            <div className="z-stack">
              <h4 className="z-section-title">Top sessions</h4>
              <div className="z-list">
                {usage.topSessions.map((row) => (
                  <button
                    type="button"
                    className="z-list-item"
                    key={row._id}
                    onClick={() => onOpenSession?.(row._id)}
                  >
                    <span className="z-list-item__title">{row.title}</span>
                    <span className="z-xsmall z-muted">{withCost(row)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {usage.truncated && (
            <p className="z-xsmall z-muted">Only the 50 most recently active sessions count.</p>
          )}
        </>
      )}
      <p className="z-xsmall z-muted">
        Tokens are shown as reported by each runtime. Cost appears only when a provider reports it;
        Zamolxis never estimates it.
      </p>
    </section>
  );
}
