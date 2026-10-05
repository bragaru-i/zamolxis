import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.data[name];
  },
}));

import {
  coverageNote,
  formatCost,
  formatTokens,
  SessionUsage,
  UsageSettings,
  type UsageTotals,
} from "./usage";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    items: 1,
    reported: 1,
    ...overrides,
  };
}

const sessionId = "s1" as Id<"workSessions">;

beforeEach(() => {
  state.data = {};
  state.calls = [];
});

describe("formatting", () => {
  it("formats tokens, cost and coverage", () => {
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(12345)).toBe("12,345 tokens");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(coverageNote(totals())).toBeUndefined();
    expect(coverageNote(totals({ items: 3, reported: 2 }))).toContain("2 of 3");
  });
});

describe("SessionUsage", () => {
  it("renders nothing until there is agent work", () => {
    expect(renderToStaticMarkup(createElement(SessionUsage, { sessionId, ready: false }))).toBe("");
    expect(state.calls[0]?.args).toBe("skip");
    state.data = { "usage:session": { total: totals({ items: 0, reported: 0 }), byRole: [] } };
    expect(renderToStaticMarkup(createElement(SessionUsage, { sessionId, ready: true }))).toBe("");
  });

  it("shows the session total and a breakdown by role and model, without cost", () => {
    state.data = {
      "usage:session": {
        total: totals({ totalTokens: 1500, items: 3, reported: 2 }),
        byRole: [
          { role: "supervisor", ...totals({ totalTokens: 500 }) },
          { role: "builder", ...totals({ totalTokens: 1000, items: 2 }) },
        ],
        byModel: [
          { model: "gpt-5", ...totals({ totalTokens: 1000 }) },
          { ...totals({ totalTokens: 500 }) },
        ],
        truncated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(SessionUsage, { sessionId, ready: true }));
    expect(html).toContain("<details");
    expect(html).toContain("1,500 tokens");
    expect(html).toContain("Supervisor");
    expect(html).toContain("Builder");
    expect(html).toContain("gpt-5");
    expect(html).toContain("Model not reported");
    expect(html).toContain("2 of 3 agent turns reported usage");
    expect(html).not.toContain("$");
  });

  it("says usage was not reported instead of showing zero", () => {
    state.data = {
      "usage:session": {
        total: totals({ reported: 0 }),
        byRole: [{ role: "builder", ...totals({ reported: 0 }) }],
        byModel: [],
        truncated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(SessionUsage, { sessionId, ready: true }));
    expect(html).toContain("Not reported");
    expect(html).not.toContain("0 tokens");
  });

  it("shows cost only when reported", () => {
    state.data = {
      "usage:session": {
        total: totals({ totalTokens: 10, costUsd: 0.25 }),
        byRole: [{ role: "builder", ...totals({ totalTokens: 10, costUsd: 0.25 }) }],
        byModel: [],
        truncated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(SessionUsage, { sessionId, ready: true }));
    expect(html).toContain("10 tokens · $0.25");
  });
});

describe("UsageSettings", () => {
  it("skips the query while closed", () => {
    const html = renderToStaticMarkup(createElement(UsageSettings, { active: false }));
    expect(html).toContain("Loading usage…");
    expect(state.calls[0]).toEqual({ name: "usage:summary", args: "skip" });
  });

  it("shows period totals and top sessions, with no cost when none was reported", () => {
    state.data = {
      "usage:summary": {
        period: "7d",
        sessionCount: 2,
        total: totals({ totalTokens: 98765, items: 4, reported: 4 }),
        byRole: [{ role: "builder", ...totals({ totalTokens: 98765 }) }],
        byModel: [],
        topSessions: [
          {
            _id: "s1",
            title: "Build dashboard",
            status: "completed",
            ...totals({ totalTokens: 90000 }),
          },
          { _id: "s2", title: "Fix login", status: "failed", ...totals({ totalTokens: 8765 }) },
        ],
        truncated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(UsageSettings, { active: true }));
    expect(state.calls[0]).toEqual({ name: "usage:summary", args: { period: "7d" } });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("98,765");
    expect(html).toContain("Build dashboard");
    expect(html).toContain("90,000 tokens");
    expect(html).not.toContain(">Cost<");
    expect(html).toContain("never estimates it");
  });

  it("shows an empty period plainly", () => {
    state.data = {
      "usage:summary": {
        period: "7d",
        sessionCount: 0,
        total: totals({ items: 0, reported: 0 }),
        byRole: [],
        byModel: [],
        topSessions: [],
        truncated: false,
      },
    };
    const html = renderToStaticMarkup(createElement(UsageSettings, { active: true }));
    expect(html).toContain("No agent work in this period.");
  });
});
