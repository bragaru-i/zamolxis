import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig, serviceManager } from "./setup";

/** A run whose processed tokens pass this is flagged once in the log. */
export const HEAVY_RUN_TOKENS = 500_000;
const HISTORY_LINES = 15;
const POLL_MS = 1000;

export type Tone = "info" | "ok" | "fail" | "warn" | "dim";
export interface WatchLine {
  readonly at: number;
  readonly who: string;
  readonly text: string;
  readonly tone: Tone;
}
/** One stored outbox delivery: its row id, creation time and JSON payload. */
export interface OutboxRow {
  readonly id: number;
  readonly createdAt: number;
  readonly payload: string;
}
export interface RunRole {
  readonly role: string;
  readonly model?: string;
}
interface RunState {
  who: string;
  state: "running" | "completed" | "failed" | "stopped";
  tokens: number;
  activity?: string | undefined;
  waiting: number;
  warned: boolean;
  model?: string | undefined;
}
/** A command this Node ran, for failures reported without details (older Nodes). */
export interface CommandInfo {
  readonly type: string;
  readonly runtime?: string;
  readonly model?: string;
}
const AGENTS: Record<string, string> = {
  supervisor: "Supervisor",
  orchestrator: "Assistant",
  "repository.plan": "Supervisor",
  "orchestrator.answer": "Assistant",
};
// "Codex turn failed: <reason>" repeats what the line already says.
const reasonText = (value: unknown) =>
  text(value, 300).replace(/^(Codex|Claude) turn failed:?\s*/i, "");

const LABELS: Record<string, string> = {
  builder: "Builder",
  verifier: "Verifier",
  repair: "Repair",
};
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" ? (value as Json) : {};
const text = (value: unknown, limit = 160): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

// Codex reports shell commands wrapped as `/bin/zsh -lc '<command>'`; show the command.
const LOGIN_SHELL = /^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(["'])([\s\S]*)\1\s*$/;
export function commandText(value: string): string {
  return value.match(LOGIN_SHELL)?.[2] ?? value;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

/**
 * What this computer's Node did, rebuilt from its local outbox (every event it reported
 * to the control plane). Read-only: watching never changes the Node.
 */
// "Run: /bin/zsh -lc '<command>' | Reason: …" becomes the command alone.
function approvalText(summary: unknown): string {
  const first = text(summary, 400).split(" Reason:")[0] ?? "";
  return commandText(first.replace(/^Run: /, "")).slice(0, 140);
}

export class WatchState {
  readonly runs = new Map<string, RunState>();
  supervisorTokens = 0;
  supervisorCalls = 0;

  constructor(
    private readonly roleOf: (runId: string) => RunRole | undefined,
    private readonly commandOf: (commandId: string) => CommandInfo | undefined = () => undefined,
  ) {}

  get agentTokens(): number {
    let total = 0;
    for (const run of this.runs.values()) total += run.tokens;
    return total;
  }
  get waiting(): number {
    let total = 0;
    for (const run of this.runs.values()) total += run.waiting;
    return total;
  }
  get active(): RunState[] {
    return [...this.runs.values()].filter((run) => run.state === "running");
  }

  #run(runId: string): RunState {
    let run = this.runs.get(runId);
    if (!run) {
      const role = this.roleOf(runId);
      const label = LABELS[role?.role ?? ""] ?? "Agent";
      run = {
        who: `${label} ${runId.slice(-4)}`,
        state: "running",
        tokens: 0,
        waiting: 0,
        warned: false,
      };
      this.runs.set(runId, run);
    }
    return run;
  }

  ingest(row: OutboxRow): WatchLine[] {
    let payload: Json;
    try {
      payload = object(JSON.parse(row.payload));
    } catch {
      return [];
    }
    const at = row.createdAt;
    const lines: WatchLine[] = [];
    let when = at;
    const add = (who: string, value: string, tone: Tone = "info") => {
      if (value) lines.push({ at: when, who, text: value, tone });
    };
    const usage = object(payload.usage);
    const spent = number(usage.totalTokens);
    const tokens = spent !== undefined ? ` · ${formatTokens(spent)} tokens` : "";
    switch (payload.kind) {
      case "orchestrator.answer":
      case "repository.plan": {
        if (spent !== undefined) {
          this.supervisorTokens += spent;
          this.supervisorCalls += 1;
        }
        const tasks = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
        add(
          "Supervisor",
          payload.kind === "repository.plan"
            ? `planned ${tasks} task${tasks === 1 ? "" : "s"}${tokens}`
            : `answered (${text(payload.decision, 20) || "reply"})${tokens}`,
          "ok",
        );
        break;
      }
      case "supervisor.log": {
        const steps = Array.isArray(payload.steps) ? payload.steps.map(object) : [];
        const failed = steps.find((step) => step.kind === "supervisor" && step.status === "failed");
        const note = steps.find((step) => step.kind === "message");
        if (failed)
          add("Supervisor", `failed: ${text(note?.detail) || text(failed.label)}`, "fail");
        break;
      }
      case "command.failed": {
        // Who failed, on which model, and why: from the Node's report, else from the command.
        const failure = object(payload.failure);
        const command = this.commandOf(text(payload.commandId, 200));
        const who = AGENTS[text(failure.agent, 40)] ?? AGENTS[command?.type ?? ""] ?? "Node";
        const runtime = text(failure.runtime, 40) || command?.runtime;
        const model = text(failure.modelActual, 80) || text(failure.model, 80) || command?.model;
        const reason = reasonText(failure.reason);
        const engine = [runtime, model].filter(Boolean).join(" ");
        if (typeof failure.at === "number") when = failure.at;
        add(
          who,
          `failed${engine ? ` · ${engine}` : ""} · ${reason || text(payload.code, 64).replaceAll("_", " ").toLowerCase()}`,
          "fail",
        );
        break;
      }
      case "workspace.ready":
        add("Node", "worktree ready", "dim");
        break;
      case "run.complete": {
        const evidence = Array.isArray(payload.evidence) ? payload.evidence.map(object) : [];
        if (evidence.length) {
          const failed = evidence.filter((item) => item.result !== "passed").length;
          add(
            "Checks",
            failed ? `${failed} of ${evidence.length} failed` : `all ${evidence.length} passed`,
            failed ? "fail" : "ok",
          );
        }
        break;
      }
      case "integration.published":
        add("Node", `pull request opened ${text(payload.prUrl, 200)}`, "ok");
        break;
      case "run.events": {
        const runId = text(payload.runId, 200);
        if (!runId) break;
        const run = this.#run(runId);
        const events = Array.isArray(payload.events) ? payload.events.map(object) : [];
        for (const event of events) {
          const data = object(event.payload);
          // Events are delivered in batches; each one carries the time it happened.
          when = number(event.occurredAt) ?? at;
          switch (event.type) {
            case "run.started":
              run.state = "running";
              add(run.who, "started", "info");
              break;
            case "run.activity":
              run.activity = text(data.label, 60) || run.activity;
              break;
            case "tool.completed":
              add(
                run.who,
                commandText(text(data.summary, 400)).slice(0, 160) || text(data.tool),
                data.success === false ? "fail" : "ok",
              );
              break;
            case "files.changed": {
              const paths = Array.isArray(data.paths)
                ? data.paths.map((path) => text(path, 120))
                : [];
              if (paths.length) add(run.who, `edited ${paths.join(", ")}`, "info");
              break;
            }
            case "approval.requested":
              run.waiting += 1;
              add(run.who, `waiting for your approval: ${approvalText(data.summary)}`, "warn");
              break;
            case "approval.resolved":
              run.waiting = Math.max(0, run.waiting - 1);
              add(run.who, `approval ${text(data.decision, 20)}`, "dim");
              break;
            case "run.message":
              add(run.who, `“${text(data.text, 140)}”`, "dim");
              break;
            case "run.usage": {
              if (typeof data.modelActual === "string") run.model = text(data.modelActual, 80);
              const total = number(data.totalTokens);
              if (total !== undefined) run.tokens = Math.max(run.tokens, total);
              if (!run.warned && run.tokens > HEAVY_RUN_TOKENS) {
                run.warned = true;
                add(run.who, `uses a lot of tokens: ${formatTokens(run.tokens)} so far`, "warn");
              }
              break;
            }
            case "run.completed":
            case "run.failed":
            case "run.stopped": {
              run.state =
                event.type === "run.completed"
                  ? "completed"
                  : event.type === "run.failed"
                    ? "failed"
                    : "stopped";
              run.waiting = 0;
              run.activity = undefined;
              const reason = run.state === "failed" ? reasonText(data.message) : "";
              add(
                run.who,
                [
                  run.state,
                  run.state === "failed" ? run.model : undefined,
                  `${formatTokens(run.tokens)} tokens`,
                  reason || undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
                run.state === "completed" ? "ok" : "fail",
              );
              break;
            }
          }
        }
        break;
      }
    }
    return lines;
  }
}

// ---------------------------------------------------------------- terminal rendering

const COLORS: Record<Tone | "bold" | "head", string> = {
  info: "\x1b[0m",
  ok: "\x1b[32m",
  fail: "\x1b[31m",
  warn: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  head: "\x1b[36m",
};
const ICONS: Record<Tone, string> = { info: "•", ok: "✓", fail: "✗", warn: "⚠", dim: "·" };

export interface Painter {
  readonly color: boolean;
  readonly width: number;
}
function paint(p: Painter, tone: keyof typeof COLORS, value: string): string {
  return p.color ? `${COLORS[tone]}${value}\x1b[0m` : value;
}
// Lines are cut to the terminal width so the status block can be redrawn in place.
function clip(p: Painter, value: string): string {
  return value.length > p.width ? `${value.slice(0, Math.max(1, p.width - 1))}…` : value;
}
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export function renderLine(p: Painter, line: WatchLine): string {
  const who = line.who.padEnd(14);
  const plain = clip(p, `${clock(line.at)}  ${who} ${ICONS[line.tone]} ${line.text}`);
  const prefix = `${clock(line.at)}  ${who} `;
  if (!p.color) return plain;
  return `${paint(p, "dim", prefix.slice(0, 10))}${paint(p, "bold", prefix.slice(10))}${paint(p, line.tone, plain.slice(prefix.length))}`;
}

export function renderStatus(
  p: Painter,
  state: WatchState,
  header: { name: string; service: string },
): string[] {
  const rule = paint(p, "dim", "─".repeat(Math.min(p.width, 72)));
  const lines = [rule];
  for (const run of state.active) {
    const activity = run.waiting ? "waiting for your approval" : (run.activity ?? "working");
    lines.push(
      clip(p, ` ● ${run.who.padEnd(14)} ${activity.padEnd(28)} ${formatTokens(run.tokens)} tokens`),
    );
  }
  if (!state.active.length)
    lines.push(paint(p, "dim", " No agent is running on this computer right now."));
  const total = state.supervisorTokens + state.agentTokens;
  const waiting = state.waiting
    ? paint(p, "warn", ` · ⚠ ${state.waiting} waiting for approval`)
    : "";
  lines.push(
    ` ${paint(p, "bold", `Today: ${formatTokens(total)} tokens`)} ${paint(
      p,
      "dim",
      clip(
        p,
        `(Supervisor ${formatTokens(state.supervisorTokens)} · agents ${formatTokens(state.agentTokens)} · ${state.runs.size} runs)`,
      ),
    )}${waiting}`,
  );
  lines.push(
    paint(
      p,
      "dim",
      clip(p, ` ${header.name} · ${header.service} · Ctrl+C to close (the Node keeps running)`),
    ),
  );
  return lines;
}

// ---------------------------------------------------------------- command

function startOfToday(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export async function watch(options: { once?: boolean } = {}): Promise<void> {
  const config = readConfig();
  const db = new DatabaseSync(join(config.managedRoot, "node-state.sqlite"), { readOnly: true });
  const roleQuery = db.prepare(
    "SELECT payload_json FROM command_executions WHERE type = 'runtime.start' AND json_extract(payload_json, '$.runId') = ?",
  );
  const roleOf = (runId: string): RunRole | undefined => {
    const row = roleQuery.get(runId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = object(JSON.parse(row.payload_json));
    return {
      role: text(payload.role, 20),
      ...(payload.model ? { model: text(payload.model, 60) } : {}),
    };
  };
  const rows = db.prepare(
    "SELECT rowid AS id, created_at AS createdAt, payload_json AS payload FROM event_outbox WHERE rowid > ? AND created_at >= ? ORDER BY rowid",
  );
  const commandQuery = db.prepare(
    "SELECT type, payload_json FROM command_executions WHERE command_id = ?",
  );
  const commandOf = (commandId: string): CommandInfo | undefined => {
    const row = commandQuery.get(commandId) as { type: string; payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = object(JSON.parse(row.payload_json));
    const agent = object(payload.supervisor ?? payload.orchestrator);
    return {
      type: row.type,
      ...(agent.runtime ? { runtime: text(agent.runtime, 40) } : {}),
      ...(agent.model ? { model: text(agent.model, 80) } : {}),
    };
  };
  const state = new WatchState(roleOf, commandOf);
  const painter = (): Painter => ({
    color: !!process.stdout.isTTY && !process.env.NO_COLOR,
    width: Math.max(40, process.stdout.columns ?? 100),
  });
  const service = (): string => {
    try {
      const pid = serviceManager().pid();
      return pid ? "Node service running" : "Node service NOT running (run pnpm zamolxis update)";
    } catch {
      return "Node service status unknown";
    }
  };
  let version = "";
  try {
    version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* outside a checkout */
  }
  const header = {
    name: `${config.name}${version ? ` · checkout ${version}` : ""}`,
    service: service(),
  };

  // Today's history: everything counts toward the totals; only the latest lines are shown.
  let last = 0;
  const history: WatchLine[] = [];
  for (const row of rows.all(0, startOfToday(Date.now())) as unknown as OutboxRow[]) {
    history.push(...state.ingest(row));
    last = row.id;
  }
  const p = painter();
  const out = process.stdout;
  out.write(`${paint(p, "head", paint(p, "bold", "Zamolxis Node — live activity"))}\n`);
  if (history.length > HISTORY_LINES)
    out.write(`${paint(p, "dim", `… ${history.length - HISTORY_LINES} earlier events today`)}\n`);
  for (const line of history.slice(-HISTORY_LINES)) out.write(`${renderLine(p, line)}\n`);
  let drawn = 0;
  const redraw = (lines: WatchLine[]) => {
    const now = painter();
    if (drawn) out.write(`\x1b[${drawn}F\x1b[J`);
    for (const line of lines) out.write(`${renderLine(now, line)}\n`);
    const status = renderStatus(now, state, header);
    out.write(`${status.join("\n")}\n`);
    drawn = status.length;
  };
  redraw([]);
  if (options.once || !out.isTTY) {
    db.close();
    return;
  }
  let ticks = 0;
  const timer = setInterval(() => {
    const fresh: WatchLine[] = [];
    for (const row of rows.all(last, 0) as unknown as OutboxRow[]) {
      fresh.push(...state.ingest(row));
      last = row.id;
    }
    if (++ticks % 15 === 0) header.service = service();
    redraw(fresh);
  }, POLL_MS);
  await new Promise<void>((resolve) =>
    process.once("SIGINT", () => {
      clearInterval(timer);
      db.close();
      out.write("\n");
      resolve();
    }),
  );
}
