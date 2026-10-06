import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  clockTime,
  durationLabel,
  failureText,
  groupEvents,
  missingModalities,
  pathsFromEvents,
  type RunEvent,
  runDuration,
  runtimeLabel,
  shortSha,
  splitToolResult,
  stepDuration,
  type TraceStepRecord,
  tokensLabel,
  toolGroupMeta,
  toolGroupTitle,
  toolSummary,
  traceRows,
} from "./run-detail-model";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  events: [] as unknown[],
  status: "Exhausted" as string,
  trace: [] as unknown[],
  traceStatus: "Exhausted" as string,
  args: {} as Record<string, unknown>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.args[getFunctionName(reference)] = args;
    return args === "skip" ? undefined : state.data[getFunctionName(reference)];
  },
  usePaginatedQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    state.args[name] = args;
    return name === "traces:listByRun"
      ? { results: state.trace, status: state.traceStatus, loadMore: vi.fn() }
      : { results: state.events, status: state.status, loadMore: vi.fn() };
  },
}));

import { RunDetail } from "./run-detail";

let sequence = 0;
function event(type: string, payload: unknown = {}, occurredAt = 1000 + sequence): RunEvent {
  sequence++;
  return { _id: `e${sequence}`, sequence, type, occurredAt, payload };
}

beforeEach(() => {
  sequence = 0;
  state.data = {};
  state.events = [];
  state.status = "Exhausted";
  state.trace = [];
  state.traceStatus = "Exhausted";
  state.args = {};
});

describe("groupEvents", () => {
  it("groups consecutive tools, pairs results and hides usage", () => {
    const entries = groupEvents([
      event("run.started", { nativeSessionId: "n" }),
      event("run.usage", { totalTokens: 5 }),
      event("tool.started", { tool: "command", summary: "Tool started" }),
      event("tool.completed", { tool: "command", summary: "Tool finished", success: true }),
      event("tool.started", { tool: "command", summary: "pnpm test --filter web" }),
      event("tool.completed", { tool: "command", summary: "Tool finished", success: false }),
      event("tool.started", { tool: "command", summary: "Tool started" }),
      event("files.changed", { paths: ["a.ts", "b.ts"] }),
      event("files.changed", { paths: ["b.ts", "c.ts", 3] }),
      event("run.activity", { label: "Agent responding" }),
      event("run.activity", { label: "Agent responding" }),
      event("run.completed", { summary: "done" }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "started",
      "tools",
      "files",
      "activity",
      "completed",
    ]);
    const tools = entries[1];
    if (tools?.kind !== "tools") throw new Error("expected tools");
    expect(tools.items).toEqual([
      { tool: "command", summary: "Command", success: true },
      { tool: "command", summary: "pnpm test --filter web", success: false, mono: true },
      { tool: "command", summary: "Command" },
    ]);
    expect(tools.failed).toBe(1);
    expect(tools.open).toBe(1);
    expect(toolGroupTitle(tools.items)).toBe("Ran 3 commands");
    expect(toolGroupMeta(tools, true)).toBe("1 failed · 1 running");
    expect(toolGroupMeta(tools, false)).toBe("1 failed · 1 without result");
    expect(entries[2]).toMatchObject({ paths: ["a.ts", "b.ts", "c.ts"] });
    expect(entries[3]).toMatchObject({ label: "Agent responding", count: 2 });
  });

  it("keeps a completion whose start is on an earlier page and splits groups", () => {
    const entries = groupEvents([
      event("tool.completed", { tool: "mcp", summary: "search docs", success: true }),
      event("run.waiting", { reason: "approval" }),
      event("tool.started", { tool: "mcp", summary: "x" }),
      event("run.failed", { code: "X", message: "CODEX_EVENT_LIMIT" }),
      event("custom.thing"),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "tools",
      "waiting",
      "tools",
      "failed",
      "other",
    ]);
    expect(entries[0]).toMatchObject({ items: [{ summary: "search docs", success: true }] });
    expect(toolGroupTitle([{ tool: "mcp", summary: "x" }])).toBe("Used 1 tool");
  });

  it("shows real tool summaries with their failure reason and pairs concurrent calls", () => {
    const entries = groupEvents([
      event("tool.started", { tool: "command", summary: "pnpm test" }),
      event("tool.started", { tool: "command", summary: "git status" }),
      event("tool.completed", { tool: "command", summary: "git status", success: true }),
      event("tool.completed", {
        tool: "command",
        summary: "pnpm test · exit code 1",
        success: false,
      }),
      event("tool.started", { tool: "mcp", summary: "github/search_issues" }),
      event("tool.completed", {
        tool: "mcp",
        summary: "github/search_issues · failed: rate limited",
        success: false,
      }),
      event("tool.completed", { tool: "web", summary: 'Search "vitest"', success: true }),
    ]);
    const tools = entries[0];
    if (tools?.kind !== "tools") throw new Error("expected tools");
    expect(tools.items).toEqual([
      { tool: "command", summary: "pnpm test", result: "exit code 1", mono: true, success: false },
      { tool: "command", summary: "git status", mono: true, success: true },
      {
        tool: "mcp",
        summary: "github/search_issues",
        result: "failed: rate limited",
        success: false,
      },
      { tool: "web", summary: 'Search "vitest"', success: true },
    ]);
    expect(tools.open).toBe(0);
    expect(tools.failed).toBe(2);
    expect(toolGroupTitle(tools.items)).toBe("Used 4 tools");
    expect(splitToolResult("echo a · b")).toEqual({ summary: "echo a · b" });
    expect(splitToolResult("make · declined")).toEqual({ summary: "make", result: "declined" });
  });

  it("tolerates malformed payloads", () => {
    expect(groupEvents([event("tool.started", null), event("files.changed", "x")])).toEqual([
      expect.objectContaining({ kind: "tools", items: [{ tool: "tool", summary: "tool" }] }),
      expect.objectContaining({ kind: "files", paths: [] }),
    ]);
  });
});

describe("formatting", () => {
  it("formats durations, SHAs, tokens and models", () => {
    expect(durationLabel(4_400)).toBe("4 s");
    expect(durationLabel(200_000)).toBe("3 min 20 s");
    expect(durationLabel(120_000)).toBe("2 min");
    expect(durationLabel(3_900_000)).toBe("1 h 5 min");
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(undefined)).toBeUndefined();
    expect(tokensLabel({})).toBeUndefined();
    expect(tokensLabel({ totalTokens: 1 })).toBe("1 token");
    expect(
      tokensLabel({
        totalTokens: 12_345,
        inputTokens: 12_000,
        cachedInputTokens: 0,
        outputTokens: 345,
      }),
    ).toBe("12,345 tokens (12,000 in · 345 out)");
    expect(runtimeLabel({ runtime: "codex" })).toBe("Codex");
    expect(runtimeLabel({ runtime: "codex", modelRequested: "gpt-5" })).toBe("Codex · gpt-5");
    expect(runtimeLabel({ runtime: "x", modelRequested: "a", modelActual: "b" })).toBe(
      "x · b (requested a)",
    );
    expect(clockTime(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe("09:05:07");
    expect(failureText("CODEX_EVENT_LIMIT")).toBe("codex event limit");
    expect(failureText("Codex turn failed")).toBe("Codex turn failed");
    expect(toolSummary("command", "Tool started", "Tool finished")).toBe("Command");
  });

  it("measures live and settled durations", () => {
    const run = { _creationTime: 0, startedAt: 1000, lastActivityAt: 6000 };
    expect(runDuration({ ...run, status: "running" }, 61_000)).toBe("1 min");
    expect(runDuration({ ...run, status: "failed" }, 61_000)).toBe("5 s");
    expect(runDuration({ ...run, status: "completed", completedAt: 3000 }, 0)).toBe("2 s");
  });

  it("lists missing required modalities and loaded paths", () => {
    expect(
      missingModalities(
        ["static", "behavioral"],
        [
          { modality: "static", result: "passed" },
          { modality: "behavioral", result: "failed" },
        ],
      ),
    ).toEqual(["behavioral"]);
    expect(pathsFromEvents([event("files.changed", { paths: ["a", "a", "b"] })])).toEqual([
      "a",
      "b",
    ]);
  });
});

const sha = (char: string) => char.repeat(40);
function detail(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      _id: "run1",
      _creationTime: 0,
      role: "builder",
      status: "completed",
      runtime: "codex",
      modelActual: "gpt-5-codex",
      totalTokens: 48_211,
      inputTokens: 45_000,
      outputTokens: 3_211,
      attempt: 1,
      resultSummary: "Added **pagination** to the events list.",
      startedAt: 1000,
      completedAt: 95_000,
      lastActivityAt: 95_000,
      initialHeadSha: sha("a"),
      finalHeadSha: sha("b"),
      finalChangedFileCount: 2,
    },
    task: {
      title: "Paginate events",
      status: "running",
      phase: "trust_failed",
      repairAttempts: 1,
      repairLimit: 2,
      requiredModalities: ["static", "behavioral"],
    },
    workspace: {
      kind: "worktree",
      status: "completed",
      baseRef: "main",
      baseSha: sha("a"),
      branchName: "zamolxis/task-paginate-events-with-a-very-long-branch-name",
    },
    verifications: [
      {
        _id: "v1",
        subjectSha: sha("b"),
        candidateRunId: "run1",
        candidateRole: "builder",
        verifierRunId: "run2",
        verifierStatus: "completed",
        evidence: [
          {
            modality: "static",
            result: "passed",
            summary: "tsc and biome clean",
            subjectSha: sha("b"),
          },
          {
            modality: "behavioral",
            result: "failed",
            summary: "Load earlier does nothing",
            subjectSha: sha("b"),
          },
        ],
      },
    ],
    trustDecisions: [
      {
        _id: "d1",
        subjectSha: sha("b"),
        eligible: false,
        reasons: ["Required modality behavioral failed"],
        createdAt: 1,
      },
    ],
    ...overrides,
  };
}

function render(data: object, files?: object) {
  state.data = { "runDetail:get": data, "runDetail:changedFiles": files };
  return renderToStaticMarkup(
    createElement(RunDetail, { runId: "run1" as Id<"agentRuns">, onClose: () => {} }),
  );
}

describe("RunDetail", () => {
  it("shows header facts, result, changes, evidence and the trust decision", () => {
    state.events = [
      event("run.completed", {}, 95_000),
      event("files.changed", { paths: ["apps/web/app/features/run-detail.tsx"] }),
      event("run.started", {}),
    ];
    const html = render(detail(), { paths: ["src/a.ts", "src/b.ts"], truncated: false });
    expect(html).toContain("Builder run");
    expect(html).toContain("Paginate events");
    expect(html).toContain("Codex · gpt-5-codex");
    expect(html).toContain("1 min 34 s");
    expect(html).toContain("48,211 tokens (45,000 in · 3,211 out)");
    expect(html).toContain("<strong>pagination</strong>");
    expect(html).toContain("aaaaaaa → bbbbbbb");
    expect(html).toContain("zamolxis/task-paginate-events-with-a-very-long-branch-name");
    expect(html).toContain("src/b.ts");
    expect(html).toContain("2 changed");
    expect(html).toContain("tsc and biome clean");
    expect(html).toContain("Load earlier does nothing");
    expect(html).toContain("Missing required evidence: Behavior");
    expect(html).toContain("Not trusted");
    expect(html).toContain("Required modality behavioral failed");
    expect(html).toContain("Repairs used 1 of 2");
    // Chronological order: started before completed.
    expect(html.indexOf("Started</span>")).toBeLessThan(html.indexOf("Completed</span>"));
    expect(html).not.toContain("Load earlier</button>");
    // Built-in default: no profile line.
    expect(html).not.toContain("owner instructions");
  });

  it("shows which profile revision and owner instructions applied", () => {
    state.events = [];
    const run = { ...detail().run, agentProfileRevision: 3 };
    expect(render(detail({ run }))).toContain("revision 3 · no owner instructions");
    expect(
      render(detail({ run: { ...run, instructionsDigest: `${"ab".repeat(6)}${"0".repeat(52)}` } })),
    ).toContain("revision 3 · owner instructions abababababab");
  });

  it("streams an active run from loaded events and offers older pages", () => {
    state.status = "CanLoadMore";
    state.events = [
      event("files.changed", { paths: ["live.ts"] }),
      event("tool.started", { tool: "command", summary: "Tool started" }),
    ];
    const run = { ...detail().run, status: "running", activityLabel: "Agent responding" };
    const html = render(
      detail({ run, verifications: [], trustDecisions: [], task: null, workspace: null }),
      { paths: ["never-read.ts"], truncated: false },
    );
    expect(state.args["runDetail:changedFiles"]).toBe("skip");
    expect(html).toContain("Load earlier");
    expect(html).toContain("Agent responding");
    expect(html).toContain("1 running");
    expect(html).toContain("live.ts");
    expect(html).not.toContain("never-read.ts");
    expect(html).not.toContain("Verification</h3>");
  });

  it("renders commands as monospace text with their failure reason", () => {
    state.events = [
      event("tool.completed", {
        tool: "command",
        summary: "pnpm test · exit code 1",
        success: false,
      }),
      event("tool.started", { tool: "command", summary: "pnpm test" }),
    ];
    const html = render(detail(), { paths: [], truncated: false });
    expect(html).toContain("Ran 1 command");
    expect(html).toContain('<code class="z-mono z-break">pnpm test</code>');
    expect(html).toContain("exit code 1");
  });

  it("explains a verifier run in terms of its candidate", () => {
    const run = { ...detail().run, role: "verifier", resultSummary: undefined };
    const html = render(detail({ run }), { paths: [], truncated: false });
    expect(html).toContain("Verifier run");
    expect(html).toContain("Checks the builder snapshot");
    expect(html).not.toContain("Verifier on");
  });

  it("says when a completed builder has no verification yet", () => {
    const html = render(
      detail({
        verifications: [],
        trustDecisions: [],
        task: { ...detail().task, repairAttempts: 0 },
      }),
      { paths: [], truncated: false },
    );
    expect(html).toContain("Not independently verified yet.");
  });

  it("shows the recorded trace in order with status, duration and expandable output", () => {
    state.trace = [
      traceStep(3, {
        kind: "verification-check",
        label: "pnpm run test",
        status: "failed",
        startedAt: 5000,
        finishedAt: 7500,
        detail: "FAIL src/a.test.ts\nexpected 1 to be 2",
        references: { script: "test", exitCode: 1, sha: sha("b") },
      }),
      traceStep(1, {
        kind: "discovery",
        label: "Repository discovered",
        detail: "4 sources, 2 capabilities",
        references: { sha: sha("a") },
      }),
      traceStep(2, {
        kind: "runtime",
        label: "Runtime codex running",
        status: "started",
        finishedAt: undefined,
      }),
    ];
    const html = render(detail(), { paths: [], truncated: false });
    expect(state.args["traces:listByRun"]).toEqual({ runId: "run1" });
    expect(html).toContain("Trace</h3>");
    expect(html).toContain('aria-label="Run trace"');
    // Recorded order, not arrival order of the array.
    expect(html.indexOf("Repository discovered")).toBeLessThan(html.indexOf("Runtime codex"));
    expect(html.indexOf("Runtime codex")).toBeLessThan(html.indexOf("pnpm run test"));
    expect(html).toContain("Discovery · Passed · 250 ms · at aaaaaaa");
    expect(html).toContain("Check · Failed · 3 s · exit code 1 · at bbbbbbb");
    // A step still running on a settled run has no duration.
    expect(html).toContain("Runtime · Running</span>");
    expect(html).toContain('<code class="z-mono z-break">pnpm run test</code>');
    expect(html).toContain('<summary class="z-disclosure__summary">Output</summary>');
    expect(html).toMatch(
      /<pre class="z-mono z-xsmall"[^>]*>FAIL src\/a.test.ts\nexpected 1 to be 2<\/pre>/,
    );
    expect(html).toContain('<summary class="z-disclosure__summary">Details</summary>');
    expect(html).toContain("4 sources, 2 capabilities");
  });

  it("says when no trace was recorded and offers more trace pages", () => {
    expect(render(detail(), { paths: [], truncated: false })).toContain(
      "No trace recorded for this run.",
    );
    state.trace = [traceStep(1, { kind: "workspace", label: "Workspace ready" })];
    state.traceStatus = "CanLoadMore";
    expect(render(detail(), { paths: [], truncated: false })).toContain("Load more steps");
  });
});

function traceStep(
  sequence: number,
  // `finishedAt: undefined` removes the default finish time.
  step: { [K in keyof TraceStepRecord]?: TraceStepRecord[K] | undefined },
): TraceStepRecord {
  return {
    _id: `t${sequence}`,
    sequence,
    stepId: `step-${sequence}`,
    kind: "workspace",
    label: "Step",
    status: "passed",
    startedAt: 1000,
    finishedAt: 1250,
    ...step,
  } as TraceStepRecord;
}

describe("traceRows", () => {
  it("formats status, duration and facts, and times running steps only while active", () => {
    const steps = [
      traceStep(2, { kind: "runtime", status: "started", startedAt: 1000, finishedAt: undefined }),
      traceStep(1, { kind: "trust", status: "skipped", label: " ", finishedAt: 62_000 }),
    ];
    const settled = traceRows(steps, 10_000, false);
    expect(settled.map((row) => [row.title, row.kind, row.status, row.tone, row.duration])).toEqual(
      [
        ["Trust", "Trust", "Skipped", "neutral", "1 min 1 s"],
        ["Step", "Runtime", "Running", "info", undefined],
      ],
    );
    expect(traceRows(steps, 10_000, true)[1]?.duration).toBe("9 s");
    expect(stepDuration(999)).toBe("999 ms");
    expect(stepDuration(-5)).toBe("0 ms");
    const [check] = traceRows(
      [
        traceStep(1, {
          kind: "verification-check",
          status: "weird",
          detail: "  out  ",
          references: { exitCode: 0 },
        }),
      ],
      0,
      false,
    );
    expect(check).toMatchObject({
      status: "weird",
      tone: "neutral",
      mono: true,
      detail: "out",
      facts: ["exit code 0"],
    });
  });
});

describe("SessionView run rows", () => {
  it("make each run row a button that opens its detail", async () => {
    const { SessionView } = await import("./session-view");
    state.data = {
      "sessions:get": { _id: "s", title: "Session", status: "running" },
      "supervisor:messages": [],
      "tasks:listBySession": [{ _id: "t1", _creationTime: 1, title: "API", status: "running" }],
      "runs:listBySession": [
        { _id: "r1", _creationTime: 1, taskId: "t1", role: "verifier", status: "running" },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(SessionView, {
        sessionId: "s" as Id<"workSessions">,
        ready: true,
        indicator: null,
        notices: null,
        onBack: () => {},
        onOpen: () => {},
      }),
    );
    expect(html).toContain(
      '<button type="button" class="z-pressable" aria-haspopup="dialog"><strong>Verifier</strong>',
    );
    // The detail sheet is mounted only after a row is opened.
    expect(html).not.toContain("Verifier run");
  });
});
