import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";
import { groupLogRows, logSummary, type TraceStepRecord, traceRows } from "./run-detail-model";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    state.args[getFunctionName(reference)] = args;
    return state.data[getFunctionName(reference)];
  },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));

import { SupervisorLog } from "./supervisor-log";

let sequence = 0;
function step(kind: string, label: string, extra: Partial<TraceStepRecord> = {}): TraceStepRecord {
  sequence++;
  return {
    _id: `s${sequence}`,
    sequence,
    stepId: `c:${kind}:${sequence}`,
    kind,
    label,
    status: "passed",
    startedAt: 1_000 * sequence,
    finishedAt: 1_000 * sequence + 250,
    ...extra,
  };
}
function render(steps: TraceStepRecord[] | undefined) {
  state.data = { "supervisor:log": steps };
  return renderToStaticMarkup(
    createElement(SupervisorLog, {
      textCommandId: "text1" as Id<"textCommands">,
      onClose: () => {},
    }),
  );
}

beforeEach(() => {
  sequence = 0;
  state.data = {};
  state.args = {};
});

const log = () => [
  step("discovery", "Repository discovered", { references: { sha: "a".repeat(40) } }),
  step("supervisor", "Supervisor finished", {
    startedAt: 1_000,
    finishedAt: 13_000,
    detail: "Codex · model gpt-5\n1,500 tokens (1,200 in · 300 out)",
  }),
  step("phase", "Thinking"),
  step("tool", "cat convex/schema.ts", { detail: "Read convex/schema.ts" }),
  step("tool", "pnpm missing · exit code 1", { status: "failed" }),
  step("message", "Note", { detail: "Schema read.\nChecking the API next." }),
  step("approval", "Approval request refused", { status: "failed", detail: "Run: curl x" }),
  step("supervisor", "Planned 2 tasks", { detail: "1. Add field\n2. Show field" }),
];

describe("Supervisor log model", () => {
  it("groups consecutive tool steps and summarizes the session", () => {
    const rows = traceRows(log(), 0, false);
    const entries = groupLogRows(rows);
    expect(
      entries.map((entry) =>
        entry.kind === "tools" ? `tools:${entry.rows.length}` : entry.row.title,
      ),
    ).toEqual([
      "Repository discovered",
      "Supervisor finished",
      "Thinking",
      "tools:2",
      "Note",
      "Approval request refused",
      "Planned 2 tasks",
    ]);
    const tools = entries[3];
    expect(tools?.kind === "tools" && tools.failed).toBe(1);
    expect(rows.find((row) => row.stepKind === "tool")?.titleMono).toBe(true);
    expect(logSummary(rows)).toEqual({ duration: "12 s", steps: 8 });
  });
});

describe("SupervisorLog", () => {
  it("shows the steps for the owner's message, notes and the decision as text", () => {
    const html = render(log());
    expect(state.args["supervisor:log"]).toEqual({ textCommandId: "text1" });
    expect(html).toContain("What Zamolxis did");
    expect(html).toContain("Repository discovered");
    expect(html).toContain("Supervisor finished");
    expect(html).toContain("1,500 tokens (1,200 in · 300 out)");
    expect(html).toContain("Used 2 tools");
    expect(html).toContain("1 failed");
    expect(html).toContain("cat convex/schema.ts");
    expect(html).toContain("Read convex/schema.ts");
    expect(html).toContain("Schema read.\nChecking the API next.");
    expect(html).toContain("Approval request refused");
    expect(html).toContain("1. Add field\n2. Show field");
    expect(html).toContain("Took");
    expect(html).toContain("12 s");
  });
  it("explains an empty log and shows loading", () => {
    expect(render([])).toContain("Nothing was recorded for this message");
    expect(render(undefined)).toContain("Loading steps");
  });
});
