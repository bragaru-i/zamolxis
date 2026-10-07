// Pure view-model helpers for the Run detail view: event grouping and formatting.

export interface RunEvent {
  _id: string;
  sequence: number;
  type: string;
  occurredAt: number;
  // biome-ignore lint/suspicious/noExplicitAny: payload is runtime-normalized JSON, validated here.
  payload: any;
}

export interface ToolItem {
  tool: string;
  summary: string;
  /** undefined while the tool is still running (or its result was never reported). */
  success?: boolean;
  /** Short failure reason reported with the result, such as "exit code 1". */
  result?: string;
  /** The summary is a command line (rendered monospace). */
  mono?: boolean;
  /** Files the call read, as reported by the runtime. */
  reads?: string[];
}

export type TimelineEntry =
  | { kind: "started"; key: string; at: number }
  | { kind: "activity"; key: string; at: number; label: string; detail?: string; count: number }
  | {
      kind: "tools";
      key: string;
      at: number;
      endAt: number;
      items: ToolItem[];
      failed: number;
      open: number;
    }
  | { kind: "files"; key: string; at: number; paths: string[] }
  // A progress note the agent wrote while working (`run.message`).
  | { kind: "note"; key: string; at: number; text: string }
  | { kind: "waiting"; key: string; at: number; reason: string }
  | { kind: "completed"; key: string; at: number; summary?: string }
  | { kind: "failed"; key: string; at: number; message: string; code?: string }
  | { kind: "stopped"; key: string; at: number; reason: string }
  | { kind: "other"; key: string; at: number; type: string };

export const ACTIVE_RUN = [
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
];
export const ROLE_LABEL: Record<string, string> = {
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
};
const RUNTIME_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  hermes: "Hermes",
  local: "Local model",
  "codex-local": "Codex + local model",
  fake: "Test runtime",
};
export const MODALITY_LABEL: Record<string, string> = {
  static: "Static checks",
  test: "Tests",
  behavioral: "Behavior",
  visual: "Visual",
  interaction: "Interaction",
  mutation: "Mutation",
  security: "Security",
};
const GENERIC_TOOL_SUMMARY = new Set(["tool started", "tool finished", "tool completed", ""]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolName(value: unknown): string {
  return text(value) || "tool";
}

/** Prefer an informative summary over runtime placeholders such as "Tool started". */
export function toolSummary(tool: string, started?: string, completed?: string): string {
  for (const candidate of [completed, started]) {
    const value = text(candidate);
    if (!GENERIC_TOOL_SUMMARY.has(value.toLowerCase())) return value;
  }
  return tool === "command" ? "Command" : tool === "mcp" ? "MCP tool" : tool;
}

// Runtimes append a short failure reason to a completed tool summary: "<summary> · exit code 1".
const RESULT_SUFFIX = /^([\s\S]*\S) · (exit code -?\d+|declined|failed(?:: [\s\S]*)?)$/;

/** Splits a completed summary into the tool summary and its failure reason. */
export function splitToolResult(summary: string): { summary: string; result?: string } {
  const match = RESULT_SUFFIX.exec(summary.trim());
  return match?.[1] && match[2] ? { summary: match[1], result: match[2] } : { summary };
}

function toolItem(tool: string, started?: string, completed?: string): ToolItem {
  const split = splitToolResult(text(completed));
  const summary = toolSummary(tool, started, split.summary);
  return {
    tool,
    summary,
    ...(split.result ? { result: split.result } : {}),
    ...(tool === "command" && summary !== "Command" ? { mono: true } : {}),
  };
}

/**
 * Turns chronological normalized events into a compact timeline: consecutive tool events
 * become one group (starts paired with completions), consecutive identical activity labels
 * collapse, consecutive file changes merge, and usage events are hidden.
 */
export function groupEvents(events: readonly RunEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let openStarts: { tool: string; summary: string; item: ToolItem }[] = [];
  const last = () => entries[entries.length - 1];
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const key = event._id;
    const at = event.occurredAt;
    if (event.type !== "tool.started" && event.type !== "tool.completed") openStarts = [];
    switch (event.type) {
      case "run.usage":
        break;
      case "run.started":
        entries.push({ kind: "started", key, at });
        if (text(payload.activity))
          entries.push({
            kind: "activity",
            key: `${key}:a`,
            at,
            label: payload.activity,
            count: 1,
          });
        break;
      case "run.activity": {
        const label = text(payload.label) || "Working";
        const detail = text(payload.detail) || undefined;
        const previous = last();
        if (previous?.kind === "activity" && previous.label === label && !detail) {
          previous.count++;
          break;
        }
        entries.push({ kind: "activity", key, at, label, count: 1, ...(detail ? { detail } : {}) });
        break;
      }
      case "tool.started":
      case "tool.completed": {
        let group = last();
        if (group?.kind !== "tools") {
          group = { kind: "tools", key, at, endAt: at, items: [], failed: 0, open: 0 };
          entries.push(group);
          openStarts = [];
        }
        group.endAt = at;
        const tool = toolName(payload.tool);
        if (event.type === "tool.started") {
          const reads = Array.isArray(payload.reads)
            ? payload.reads.filter(
                (path: unknown): path is string => typeof path === "string" && !!path,
              )
            : [];
          const item: ToolItem = {
            ...toolItem(tool, payload.summary),
            ...(reads.length ? { reads } : {}),
          };
          group.items.push(item);
          group.open++;
          openStarts.push({ tool, summary: text(payload.summary), item });
        } else {
          const success = payload.success !== false;
          // Pair with the start of the same tool call (same summary), else the oldest open one.
          const completed = splitToolResult(text(payload.summary)).summary;
          let index = openStarts.findIndex(
            (start) => start.tool === tool && !!completed && start.summary === completed,
          );
          if (index < 0) index = openStarts.findIndex((start) => start.tool === tool);
          if (index >= 0) {
            const [start] = openStarts.splice(index, 1);
            if (start) {
              Object.assign(start.item, toolItem(tool, start.summary, payload.summary), {
                success,
              });
            }
            group.open--;
          } else {
            group.items.push({ ...toolItem(tool, undefined, payload.summary), success });
          }
          if (!success) group.failed++;
        }
        break;
      }
      case "files.changed": {
        const paths = Array.isArray(payload.paths)
          ? payload.paths.filter(
              (path: unknown): path is string => typeof path === "string" && !!path,
            )
          : [];
        const previous = last();
        if (previous?.kind === "files") {
          for (const path of paths) if (!previous.paths.includes(path)) previous.paths.push(path);
          break;
        }
        entries.push({ kind: "files", key, at, paths: [...new Set<string>(paths)] });
        break;
      }
      case "run.message": {
        const note = text(payload.text);
        if (note) entries.push({ kind: "note", key, at, text: note });
        break;
      }
      case "run.waiting":
        entries.push({ kind: "waiting", key, at, reason: text(payload.reason) });
        break;
      case "run.completed":
        entries.push({
          kind: "completed",
          key,
          at,
          ...(text(payload.summary) ? { summary: payload.summary } : {}),
        });
        break;
      case "run.failed":
        entries.push({
          kind: "failed",
          key,
          at,
          message: text(payload.message) || "The agent failed",
          ...(text(payload.code) ? { code: payload.code } : {}),
        });
        break;
      case "run.stopped":
        entries.push({ kind: "stopped", key, at, reason: text(payload.reason) });
        break;
      default:
        entries.push({ kind: "other", key, at, type: event.type });
    }
  }
  return entries;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** "Ran 3 commands" / "Used 2 tools", based on the tools in the group. */
export function toolGroupTitle(items: readonly ToolItem[]): string {
  if (items.length > 0 && items.every((item) => item.tool === "command"))
    return `Ran ${plural(items.length, "command")}`;
  return `Used ${plural(items.length, "tool")}`;
}

export function toolGroupMeta(
  group: { failed: number; open: number },
  active: boolean,
): string | undefined {
  const parts: string[] = [];
  if (group.failed > 0) parts.push(`${group.failed} failed`);
  if (group.open > 0) parts.push(active ? `${group.open} running` : `${group.open} without result`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** Distinct paths from loaded files.changed events (used while a run is still active). */
export function pathsFromEvents(events: readonly RunEvent[]): string[] {
  const paths = new Set<string>();
  for (const event of events)
    if (event.type === "files.changed" && Array.isArray(event.payload?.paths))
      for (const path of event.payload.paths) if (typeof path === "string" && path) paths.add(path);
  return [...paths];
}

export function shortSha(sha?: string): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export interface RunTiming {
  _creationTime: number;
  status: string;
  startedAt?: number;
  completedAt?: number;
  lastActivityAt?: number;
}

export function runDuration(run: RunTiming, now: number): string | undefined {
  const start = run.startedAt ?? run._creationTime;
  const active = ACTIVE_RUN.includes(run.status);
  const end = run.completedAt ?? (active ? now : run.lastActivityAt);
  if (end === undefined) return undefined;
  return durationLabel(end - start);
}

export interface RunUsage {
  /** Every input token processed, cached ones included. */
  inputTokens?: number;
  /** The cache-read part of `inputTokens`. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  /** The reasoning part of `outputTokens`, when the provider reports it. */
  reasoningOutputTokens?: number;
  /** Input plus output: what subscription limits count ("processed"). */
  totalTokens?: number;
  /** Model responses, when the provider reports them. */
  modelCalls?: number;
  estimatedCostUsd?: number;
}

const count = (value: number) => value.toLocaleString("en-US");

/**
 * Where a run's processed tokens went: "41 calls · 85,660 fresh · 2,491,520 cached ·
 * 13,815 out, 1,676 reasoning". Fresh input is input minus cached (derived, never
 * estimated); a part is omitted when the provider did not report it.
 */
export function usageParts(run: RunUsage): string[] {
  const parts: string[] = [];
  if (run.modelCalls) parts.push(plural(run.modelCalls, "call"));
  if (run.inputTokens !== undefined)
    parts.push(
      run.cachedInputTokens === undefined
        ? `${count(run.inputTokens)} in`
        : `${count(Math.max(run.inputTokens - run.cachedInputTokens, 0))} fresh`,
    );
  if (run.cachedInputTokens) parts.push(`${count(run.cachedInputTokens)} cached`);
  if (run.outputTokens !== undefined)
    parts.push(
      `${count(run.outputTokens)} out${run.reasoningOutputTokens ? `, ${count(run.reasoningOutputTokens)} reasoning` : ""}`,
    );
  return parts;
}

/** Usage exactly as reported by the provider; nothing is estimated here. */
export function tokensLabel(run: RunUsage): string | undefined {
  if (run.totalTokens === undefined) return undefined;
  const parts = usageParts(run);
  const total = plural(run.totalTokens, "token");
  return parts.length ? `${total} (${parts.join(" · ")})` : total;
}

/** Provider-reported cost, else the subscription the runtime's login belongs to. */
export function costLabel(run: { estimatedCostUsd?: number }): string {
  if (run.estimatedCostUsd === undefined) return "Subscription";
  const usd = run.estimatedCostUsd;
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function runtimeLabel(run: {
  runtime: string;
  modelRequested?: string;
  modelActual?: string;
}): string {
  const runtime = RUNTIME_LABEL[run.runtime] ?? run.runtime;
  const model = run.modelActual ?? run.modelRequested;
  if (!model) return runtime;
  const requested =
    run.modelActual && run.modelRequested && run.modelRequested !== run.modelActual
      ? ` (requested ${run.modelRequested})`
      : "";
  return `${runtime} · ${model}${requested}`;
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export interface EvidenceRecord {
  modality: string;
  result: "passed" | "failed";
}

/** Required modalities without passing independent evidence. */
export function missingModalities(
  required: readonly string[],
  evidence: readonly EvidenceRecord[],
): string[] {
  const passed = new Set(
    evidence.filter((item) => item.result === "passed").map((item) => item.modality),
  );
  return required.filter((modality) => !passed.has(modality));
}

/** Plain text for failure messages; machine codes (FOO_BAR) become readable words. */
export function failureText(message: string): string {
  const trimmed = message.trim();
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return trimmed.replaceAll("_", " ").toLowerCase();
  return trimmed;
}

export function modalityLabel(modality: string): string {
  return MODALITY_LABEL[modality] ?? modality;
}

/** A stored trace step (TraceStepDto plus its Convex identity and order). */
export interface TraceStepRecord {
  _id: string;
  sequence: number;
  stepId: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  references?: { runId?: string; sha?: string; script?: string; exitCode?: number };
}

export type TraceTone = "info" | "success" | "danger" | "neutral";

export interface TraceRow {
  key: string;
  title: string;
  /** Kind of step, such as "Check" or "Runtime". */
  kind: string;
  status: string;
  tone: TraceTone;
  at: number;
  duration?: string;
  /** Short facts: exit code, snapshot. */
  facts: string[];
  detail?: string;
  /** The detail is command output (rendered monospace). */
  mono: boolean;
  /** The title is a command line (rendered monospace). */
  titleMono: boolean;
  /** The step's kind as recorded, for grouping. */
  stepKind: string;
}

const TRACE_KIND_LABEL: Record<string, string> = {
  discovery: "Discovery",
  supervisor: "Supervisor",
  workspace: "Workspace",
  runtime: "Runtime",
  "verification-check": "Check",
  trust: "Trust",
  integration: "Integration",
  // Supervisor log kinds.
  phase: "Phase",
  tool: "Tool",
  message: "Note",
  approval: "Approval",
};
const TRACE_STATUS: Record<string, { label: string; tone: TraceTone }> = {
  started: { label: "Running", tone: "info" },
  passed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** Sub-second durations in milliseconds, longer ones like durationLabel. */
export function stepDuration(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  return value < 1000 ? `${value} ms` : durationLabel(value);
}

/**
 * Trace steps in recorded order with display status, duration and facts. A step still
 * "started" shows how long it has run so far while the Run is active, otherwise no duration.
 */
export function traceRows(
  steps: readonly TraceStepRecord[],
  now: number,
  active: boolean,
): TraceRow[] {
  return [...steps]
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => {
      const status = TRACE_STATUS[step.status] ?? { label: step.status, tone: "neutral" as const };
      const end = step.finishedAt ?? (active && step.status === "started" ? now : undefined);
      const references = step.references ?? {};
      const facts: string[] = [];
      if (references.exitCode !== undefined) facts.push(`exit code ${references.exitCode}`);
      if (references.sha) facts.push(`at ${shortSha(references.sha)}`);
      const detail = text(step.detail) || undefined;
      return {
        key: step._id,
        title: text(step.label) || TRACE_KIND_LABEL[step.kind] || step.kind,
        kind: TRACE_KIND_LABEL[step.kind] ?? step.kind,
        status: status.label,
        tone: status.tone,
        at: step.startedAt,
        ...(end !== undefined ? { duration: stepDuration(end - step.startedAt) } : {}),
        facts,
        ...(detail ? { detail } : {}),
        mono: step.kind === "verification-check",
        titleMono: step.kind === "verification-check" || step.kind === "tool",
        stepKind: step.kind,
      };
    });
}

export type LogEntry =
  | { kind: "step"; key: string; row: TraceRow }
  | { kind: "tools"; key: string; at: number; rows: TraceRow[]; failed: number; open: number };

/**
 * Supervisor log rows for display: consecutive tool steps become one group (like the Run
 * activity timeline), everything else stays a single step.
 */
export function groupLogRows(rows: readonly TraceRow[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const row of rows) {
    const last = entries[entries.length - 1];
    if (row.stepKind !== "tool") {
      entries.push({ kind: "step", key: row.key, row });
      continue;
    }
    const group =
      last?.kind === "tools"
        ? last
        : { kind: "tools" as const, key: row.key, at: row.at, rows: [], failed: 0, open: 0 };
    if (group !== last) entries.push(group);
    group.rows.push(row);
    if (row.tone === "danger") group.failed++;
    if (row.status === "Running") group.open++;
  }
  return entries;
}

/** The session step's duration and facts: "Supervisor finished" with runtime and usage. */
export function logSummary(rows: readonly TraceRow[]): { duration?: string; steps: number } {
  const session = rows.find((row) => row.stepKind === "supervisor");
  return { ...(session?.duration ? { duration: session.duration } : {}), steps: rows.length };
}
