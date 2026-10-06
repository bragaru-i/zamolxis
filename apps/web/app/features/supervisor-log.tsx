"use client";
// "Show what I did": the Supervisor's recorded steps for one message (#49, #27).
import { Disclosure, Facts, Sheet, Timeline, TimelineItem } from "@zamolxis/ui";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TraceStepItem } from "./run-detail";
import {
  clockTime,
  groupLogRows,
  type LogEntry,
  logSummary,
  type TraceStepRecord,
  toolGroupMeta,
  traceRows,
} from "./run-detail-model";

const TOOLS_SHOWN = 30;

export function SupervisorLog({
  textCommandId,
  onClose,
}: {
  textCommandId: Id<"textCommands">;
  onClose: () => void;
}) {
  const steps = useQuery(api.supervisor.log, { textCommandId }) as TraceStepRecord[] | undefined;
  return (
    <Sheet open title="What Zamolxis did" onClose={onClose}>
      {steps === undefined ? (
        <p className="z-muted" role="status">
          Loading steps…
        </p>
      ) : (
        <SupervisorLogBody steps={steps} />
      )}
    </Sheet>
  );
}

export function SupervisorLogBody({ steps }: { steps: readonly TraceStepRecord[] }) {
  // The log is delivered once the Supervisor settled: nothing in it is still running.
  const rows = traceRows(steps, 0, false);
  if (rows.length === 0)
    return (
      <p className="z-small z-muted">
        Nothing was recorded for this message. Messages sent before this was available, or
        interrupted by a restart, have no steps.
      </p>
    );
  const summary = logSummary(rows);
  return (
    <div className="z-stack">
      <Facts
        label="Supervisor facts"
        items={[
          { label: "Steps", value: summary.steps },
          summary.duration !== undefined && { label: "Took", value: summary.duration },
        ]}
      />
      <Timeline label="Supervisor steps">
        {groupLogRows(rows).map((entry) => (
          <LogItem key={entry.key} entry={entry} />
        ))}
      </Timeline>
    </div>
  );
}

function LogItem({ entry }: { entry: LogEntry }) {
  if (entry.kind === "step")
    // Notes and decisions are read as text; other details stay folded.
    return (
      <TraceStepItem
        row={entry.row}
        inline={entry.row.stepKind === "message" || entry.row.stepKind === "supervisor"}
      />
    );
  if (entry.rows.length === 1 && entry.rows[0]) return <TraceStepItem row={entry.rows[0]} />;
  const meta = toolGroupMeta(entry, false);
  const shown = entry.rows.slice(-TOOLS_SHOWN);
  return (
    <TimelineItem
      tone={entry.failed > 0 ? "danger" : "neutral"}
      title={`Used ${entry.rows.length} tools`}
      meta={clockTime(entry.at)}
    >
      {meta && <span className="z-xsmall z-muted">{meta}</span>}
      <Disclosure summary="Show steps">
        {entry.rows.length > shown.length && (
          <span className="z-xsmall">
            {entry.rows.length - shown.length} earlier steps not shown
          </span>
        )}
        <ul className="z-plain-list z-xsmall">
          {shown.map((row) => (
            <li key={row.key}>
              {row.tone === "danger" ? "✕ " : row.tone === "success" ? "✓ " : "… "}
              <code className="z-mono z-break">{row.title}</code>
              {row.duration && <span className="z-muted"> · {row.duration}</span>}
              {row.detail && <span className="z-muted z-break"> · {row.detail}</span>}
            </li>
          ))}
        </ul>
      </Disclosure>
    </TimelineItem>
  );
}
