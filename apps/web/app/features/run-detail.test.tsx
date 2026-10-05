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
  tokensLabel,
  toolGroupMeta,
  toolGroupTitle,
  toolSummary,
} from "./run-detail-model";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  events: [] as unknown[],
  status: "Exhausted" as string,
  args: {} as Record<string, unknown>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.args[getFunctionName(reference)] = args;
    return args === "skip" ? undefined : state.data[getFunctionName(reference)];
  },
  usePaginatedQuery: () => ({ results: state.events, status: state.status, loadMore: vi.fn() }),
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
      { tool: "command", summary: "pnpm test --filter web", success: false },
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
