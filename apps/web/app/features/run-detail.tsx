"use client";
import {
  Button,
  Collapsible,
  Disclosure,
  Facts,
  Markdown,
  Notice,
  Sheet,
  StatusBadge,
  Thinking,
  Timeline,
  TimelineItem,
  type Tone,
} from "@zamolxis/ui";
import { usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { likelyLongSummary } from "./conversation";
import {
  ACTIVE_RUN,
  clockTime,
  failureText,
  groupEvents,
  missingModalities,
  modalityLabel,
  pathsFromEvents,
  ROLE_LABEL,
  type RunEvent,
  runDuration,
  runtimeLabel,
  shortSha,
  type TimelineEntry,
  type TraceStepRecord,
  tokensLabel,
  toolGroupMeta,
  toolGroupTitle,
  traceRows,
} from "./run-detail-model";

const PAGE = 40;
const TRACE_PAGE = 50;
const FILES_SHOWN = 12;
const TOOLS_SHOWN = 30;

interface Evidence {
  modality: string;
  result: "passed" | "failed";
  summary: string;
  subjectSha: string;
}
interface Verification {
  _id: string;
  subjectSha: string;
  candidateRunId: string;
  candidateRole: string;
  verifierRunId: string;
  verifierStatus: string;
  evidence: Evidence[];
}
interface TrustDecision {
  _id: string;
  subjectSha: string;
  eligible: boolean;
  reasons: string[];
  createdAt: number;
}
export interface RunDetailData {
  run: {
    _id: Id<"agentRuns">;
    _creationTime: number;
    role: string;
    status: string;
    runtime: string;
    runtimeVersion?: string;
    agentProfileRevision?: number;
    instructionsDigest?: string;
    modelRequested?: string;
    modelActual?: string;
    reasoningEffort?: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    attempt: number;
    activityLabel?: string;
    resultSummary?: string;
    exitReason?: string;
    startedAt?: number;
    completedAt?: number;
    lastActivityAt: number;
    initialHeadSha?: string;
    finalHeadSha?: string;
    finalDirty?: boolean;
    finalChangedFileCount?: number;
  };
  task: {
    title: string;
    phase?: string;
    status: string;
    repairAttempts: number;
    repairLimit: number;
    requiredModalities: string[];
  } | null;
  workspace: {
    kind: string;
    status: string;
    baseRef: string;
    baseSha?: string;
    branchName?: string;
    currentHeadSha?: string;
  } | null;
  verifications: Verification[];
  trustDecisions: TrustDecision[];
}

/** Ticks while the run is active so the duration stays live; idle otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function RunDetail({ runId, onClose }: { runId: Id<"agentRuns">; onClose: () => void }) {
  const detail = useQuery(api.runDetail.get, { runId }) as RunDetailData | undefined;
  const role = detail ? (ROLE_LABEL[detail.run.role] ?? "Agent") : "Agent";
  return (
    <Sheet open title={`${role} run`} onClose={onClose}>
      {detail === undefined ? (
        <p className="z-muted" role="status">
          Loading run…
        </p>
      ) : (
        <RunDetailBody runId={runId} detail={detail} />
      )}
    </Sheet>
  );
}

export function RunDetailBody({
  runId,
  detail,
}: {
  runId: Id<"agentRuns">;
  detail: RunDetailData;
}) {
  const { run } = detail;
  const active = ACTIVE_RUN.includes(run.status);
  const now = useNow(active);
  const events = usePaginatedQuery(api.events.listByRun, { runId }, { initialNumItems: PAGE });
  // Newest-first pages; the full changed-file list is read once the run has settled.
  const settledFiles = useQuery(api.runDetail.changedFiles, active ? "skip" : { runId }) as
    | { paths: string[]; truncated: boolean }
    | undefined;
  const chronological = [...(events.results as RunEvent[])].reverse();
  const paths = settledFiles?.paths ?? pathsFromEvents(chronological);
  return (
    <div className="z-stack">
      <section className="z-stack" aria-label="Summary">
        <div className="z-row">
          <StatusBadge status={run.status} />
          {detail.task && <span className="z-small z-break">{detail.task.title}</span>}
        </div>
        {active && run.activityLabel && <Thinking label={run.activityLabel} />}
        <Facts
          label="Run facts"
          items={[
            { label: "Runtime", value: runtimeLabel(run) },
            runDuration(run, now) !== undefined && {
              label: active ? "Running for" : "Duration",
              value: runDuration(run, now),
            },
            tokensLabel(run) !== undefined && { label: "Tokens", value: tokensLabel(run) },
            run.estimatedCostUsd !== undefined && {
              label: "Cost",
              value: `$${run.estimatedCostUsd.toFixed(2)}`,
            },
            { label: "Started", value: clockTime(run.startedAt ?? run._creationTime) },
          ]}
        />
      </section>

      {(run.resultSummary?.trim() || run.exitReason) && (
        <section className="z-stack" aria-label="Result">
          <h3 className="z-section-title">Result</h3>
          {run.resultSummary?.trim() ? (
            <div className="z-small">
              <Collapsible likelyLong={likelyLongSummary(run.resultSummary)}>
                <Markdown>{run.resultSummary}</Markdown>
              </Collapsible>
            </div>
          ) : (
            <p className="z-small z-muted">{failureText(run.exitReason ?? "")}</p>
          )}
        </section>
      )}

      <section className="z-stack" aria-label="Activity">
        <h3 className="z-section-title">Activity</h3>
        {events.status === "CanLoadMore" && (
          <Button variant="ghost" size="small" onClick={() => events.loadMore(PAGE)}>
            Load earlier
          </Button>
        )}
        {events.status === "LoadingMore" && (
          <p className="z-xsmall z-muted" role="status">
            Loading earlier activity…
          </p>
        )}
        {events.status === "LoadingFirstPage" ? (
          <p className="z-small z-muted" role="status">
            Loading activity…
          </p>
        ) : chronological.length === 0 ? (
          <p className="z-small z-muted">No activity reported yet.</p>
        ) : (
          <Timeline label="Run activity">
            {groupEvents(chronological).map((entry) => (
              <ActivityEntry key={entry.key} entry={entry} active={active} />
            ))}
          </Timeline>
        )}
      </section>

      <Changes detail={detail} paths={paths} truncated={settledFiles?.truncated ?? false} />
      <VerificationSection detail={detail} />
      <TraceSection runId={runId} active={active} now={now} />

      <Disclosure summary="Diagnostics">
        <Facts
          label="Diagnostics"
          items={[
            { label: "Run", value: <span className="z-mono z-break">{run._id}</span> },
            { label: "Attempt", value: run.attempt },
            run.runtimeVersion && { label: "Runtime version", value: run.runtimeVersion },
            run.reasoningEffort && { label: "Reasoning", value: run.reasoningEffort },
            run.agentProfileRevision !== undefined && {
              label: "Profile",
              value: `revision ${run.agentProfileRevision} · ${
                run.instructionsDigest
                  ? `owner instructions ${run.instructionsDigest.slice(0, 12)}`
                  : "no owner instructions"
              }`,
            },
            run.exitReason && { label: "Exit reason", value: run.exitReason },
            detail.workspace && {
              label: "Workspace",
              value: `${detail.workspace.kind} · ${detail.workspace.status.replaceAll("_", " ")}`,
            },
            run.completedAt !== undefined && {
              label: "Finished",
              value: clockTime(run.completedAt),
            },
          ]}
        />
      </Disclosure>
    </div>
  );
}

const ENTRY_TONE: Record<TimelineEntry["kind"], Tone> = {
  started: "info",
  activity: "neutral",
  tools: "neutral",
  files: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  stopped: "neutral",
  other: "neutral",
};

function ActivityEntry({ entry, active }: { entry: TimelineEntry; active: boolean }) {
  const time = clockTime(entry.at);
  switch (entry.kind) {
    case "started":
      return <TimelineItem tone="info" title="Started" meta={time} />;
    case "activity":
      return (
        <TimelineItem
          tone={ENTRY_TONE.activity}
          title={entry.count > 1 ? `${entry.label} ×${entry.count}` : entry.label}
          meta={time}
        >
          {entry.detail}
        </TimelineItem>
      );
    case "tools": {
      const meta = toolGroupMeta(entry, active);
      const shown = entry.items.slice(-TOOLS_SHOWN);
      return (
        <TimelineItem
          tone={entry.failed > 0 ? "danger" : entry.open > 0 && active ? "info" : "neutral"}
          title={toolGroupTitle(entry.items)}
          meta={time}
        >
          {meta && <span>{meta}</span>}
          <Disclosure summary="Show steps">
            {entry.items.length > shown.length && (
              <span className="z-xsmall">
                {entry.items.length - shown.length} earlier steps not shown
              </span>
            )}
            <ul className="z-plain-list z-xsmall">
              {shown.map((item, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity of their own.
                <li key={index}>
                  {item.success === false ? "✕ " : item.success ? "✓ " : "… "}
                  {item.mono ? (
                    <code className="z-mono z-break">{item.summary}</code>
                  ) : (
                    item.summary
                  )}
                  {item.result && <span className="z-muted"> · {item.result}</span>}
                </li>
              ))}
            </ul>
          </Disclosure>
        </TimelineItem>
      );
    }
    case "files":
      return (
        <TimelineItem
          tone="info"
          title={`Changed ${entry.paths.length} ${entry.paths.length === 1 ? "file" : "files"}`}
          meta={time}
        >
          <ul className="z-plain-list z-mono z-xsmall">
            {entry.paths.slice(0, 5).map((path) => (
              <li key={path}>{path}</li>
            ))}
            {entry.paths.length > 5 && <li>+{entry.paths.length - 5} more</li>}
          </ul>
        </TimelineItem>
      );
    case "waiting":
      return (
        <TimelineItem tone="warning" title="Waiting" meta={time}>
          {entry.reason}
        </TimelineItem>
      );
    case "completed":
      return <TimelineItem tone="success" title="Completed" meta={time} />;
    case "failed":
      return (
        <TimelineItem tone="danger" title="Failed" meta={time}>
          {failureText(entry.message)}
        </TimelineItem>
      );
    case "stopped":
      return (
        <TimelineItem tone="neutral" title="Stopped" meta={time}>
          {entry.reason}
        </TimelineItem>
      );
    default:
      return <TimelineItem tone="neutral" title={entry.type} meta={time} />;
  }
}

/** What the Node recorded for this run: discovery, workspace, runtime, checks, candidate. */
function TraceSection({
  runId,
  active,
  now,
}: {
  runId: Id<"agentRuns">;
  active: boolean;
  now: number;
}) {
  const trace = usePaginatedQuery(api.traces.listByRun, { runId }, { initialNumItems: TRACE_PAGE });
  const rows = traceRows(trace.results as TraceStepRecord[], now, active);
  return (
    <section className="z-stack" aria-label="Trace">
      <h3 className="z-section-title">Trace</h3>
      {trace.status === "LoadingFirstPage" ? (
        <p className="z-small z-muted" role="status">
          Loading trace…
        </p>
      ) : rows.length === 0 ? (
        <p className="z-small z-muted">No trace recorded for this run.</p>
      ) : (
        <Timeline label="Run trace">
          {rows.map((row) => (
            <TimelineItem
              key={row.key}
              tone={row.tone}
              title={row.mono ? <code className="z-mono z-break">{row.title}</code> : row.title}
              meta={clockTime(row.at)}
            >
              <span className="z-xsmall z-muted">
                {[row.kind, row.status, row.duration, ...row.facts].filter(Boolean).join(" · ")}
              </span>
              {row.detail &&
                (row.mono ? (
                  <Disclosure summary="Output">
                    <pre
                      className="z-mono z-xsmall"
                      style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                    >
                      {row.detail}
                    </pre>
                  </Disclosure>
                ) : (
                  <Disclosure summary="Details">
                    <p className="z-xsmall z-break" style={{ whiteSpace: "pre-wrap" }}>
                      {row.detail}
                    </p>
                  </Disclosure>
                ))}
            </TimelineItem>
          ))}
        </Timeline>
      )}
      {trace.status === "CanLoadMore" && (
        <Button variant="ghost" size="small" onClick={() => trace.loadMore(TRACE_PAGE)}>
          Load more steps
        </Button>
      )}
    </section>
  );
}

function Changes({
  detail,
  paths,
  truncated,
}: {
  detail: RunDetailData;
  paths: string[];
  truncated: boolean;
}) {
  const [all, setAll] = useState(false);
  const { run, workspace } = detail;
  const base = run.initialHeadSha ?? workspace?.baseSha;
  const head = run.finalHeadSha;
  const count = run.finalChangedFileCount;
  if (!base && !head && !workspace?.branchName && paths.length === 0 && count === undefined)
    return null;
  const shown = all ? paths : paths.slice(0, FILES_SHOWN);
  return (
    <section className="z-stack" aria-label="Changes">
      <h3 className="z-section-title">Changes</h3>
      <Facts
        items={[
          count !== undefined && {
            label: "Files",
            value: `${count} changed${run.finalDirty ? " · uncommitted changes left" : ""}`,
          },
          (base || head) && {
            label: "Commits",
            value: (
              <span className="z-mono">
                {shortSha(base) ?? "?"} → {shortSha(head) ?? "pending"}
              </span>
            ),
          },
          workspace?.branchName && {
            label: "Branch",
            value: <span className="z-mono z-break">{workspace.branchName}</span>,
          },
        ]}
      />
      {paths.length > 0 && (
        <>
          <ul className="z-plain-list z-mono z-xsmall" aria-label="Changed files">
            {shown.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {paths.length > FILES_SHOWN && (
            <Button variant="ghost" size="small" onClick={() => setAll((value) => !value)}>
              {all ? "Show fewer" : `Show all ${paths.length} files`}
            </Button>
          )}
          {truncated && (
            <p className="z-xsmall z-muted">Only part of the file list is shown for this run.</p>
          )}
        </>
      )}
    </section>
  );
}

function VerificationSection({ detail }: { detail: RunDetailData }) {
  const { run, task, verifications, trustDecisions } = detail;
  const verifier = run.role === "verifier";
  const latest = trustDecisions[0];
  const repairs = task && task.repairAttempts > 0;
  if (!verifier && verifications.length === 0 && !latest && !repairs) {
    if (run.status !== "completed") return null;
    return (
      <section className="z-stack" aria-label="Verification">
        <h3 className="z-section-title">Verification</h3>
        <p className="z-small z-muted">Not independently verified yet.</p>
      </section>
    );
  }
  const evidence = verifications.flatMap((verification) => verification.evidence);
  const missing = task ? missingModalities(task.requiredModalities, evidence) : [];
  return (
    <section className="z-stack" aria-label="Verification">
      <h3 className="z-section-title">Verification</h3>
      {verifier && verifications[0] && (
        <p className="z-small z-muted">
          Checks the {ROLE_LABEL[verifications[0].candidateRole]?.toLowerCase() ?? "candidate"}{" "}
          snapshot <span className="z-mono">{shortSha(verifications[0].subjectSha)}</span>.
        </p>
      )}
      {verifications.map((verification) => (
        <div className="z-stack" key={verification._id}>
          {!verifier && (
            <div className="z-row z-small">
              <span>
                Verifier on <span className="z-mono">{shortSha(verification.subjectSha)}</span>
              </span>
              <StatusBadge status={verification.verifierStatus} />
            </div>
          )}
          {verification.evidence.length === 0 ? (
            <p className="z-small z-muted">No evidence recorded.</p>
          ) : (
            <ul className="z-plain-list" aria-label="Evidence">
              {verification.evidence.map((item) => (
                <li className="z-stack" key={item.modality}>
                  <div className="z-row z-small">
                    <StatusBadge
                      status={item.result === "passed" ? "completed" : "failed"}
                      label={item.result === "passed" ? "Passed" : "Failed"}
                    />
                    <strong>{modalityLabel(item.modality)}</strong>
                  </div>
                  {item.summary.trim() && (
                    <div className="z-small z-muted z-break">
                      <Collapsible likelyLong={likelyLongSummary(item.summary)}>
                        {item.summary}
                      </Collapsible>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {missing.length > 0 && (verifications.length > 0 || latest) && (
        <p className="z-small z-muted">
          Missing required evidence: {missing.map(modalityLabel).join(", ")}
        </p>
      )}
      {latest && (
        <div className="z-stack">
          <div className="z-row z-small">
            <strong>Trust decision</strong>
            <StatusBadge status={latest.eligible ? "trusted" : "untrusted"} />
            <span className="z-mono z-xsmall z-muted">{shortSha(latest.subjectSha)}</span>
          </div>
          {latest.reasons.length > 0 && (
            <ul className="z-plain-list z-small z-muted">
              {latest.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {!verifier && run.finalHeadSha && latest.subjectSha !== run.finalHeadSha && (
            <Notice tone="warning">This decision is for an earlier snapshot.</Notice>
          )}
        </div>
      )}
      {task && (repairs || latest?.eligible === false) && (
        <p className="z-small z-muted">
          Repairs used {task.repairAttempts} of {task.repairLimit}
        </p>
      )}
    </section>
  );
}
