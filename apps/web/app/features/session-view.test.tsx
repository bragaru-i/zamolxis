import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  assistantReply,
  elapsedLabel,
  likelyLongSummary,
  startsNewSession,
  thinkingDetail,
  usageLine,
} from "./conversation";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) =>
    state.data[getFunctionName(reference)],
}));

import { SessionView } from "./session-view";

const base = {
  productId: "p",
  repositoryId: "r",
  createdAt: 1,
  planned: false,
  planTaskCount: 0,
  planStatus: "completed",
};

function render(session: { status: string }, messages: object[], tasks = [], runs = []) {
  state.data = {
    "sessions:get": { _id: "s", title: "Session", ...session },
    "supervisor:messages": messages.map((message, index) => ({
      _id: `m${index}`,
      text: `question ${index}`,
      ...base,
      ...message,
    })),
    "tasks:listBySession": tasks,
    "runs:listBySession": runs,
  };
  return renderToStaticMarkup(
    createElement(SessionView, {
      sessionId: "s" as Id<"workSessions">,
      ready: true,
      indicator: null,
      notices: null,
      onBack: () => {},
      onOpen: () => {},
    }),
  );
}

beforeEach(() => {
  state.data = {};
});

describe("SessionView conversation", () => {
  it("shows a thinking status while the Supervisor works", () => {
    const html = render({ status: "planning" }, [{ planStatus: "claimed" }]);
    expect(html).toContain('role="status"');
    expect(html).toContain("Thinking…");
    expect(html).toContain("Reading the repository");
  });

  it("shows the Supervisor's activity, elapsed time, usage so far and a Stop button", () => {
    const html = render({ status: "planning" }, [
      {
        planStatus: "acknowledged",
        progress: { activity: "Reading convex/schema.ts", startedAt: Date.now() - 65_000 },
        supervisor: { totalTokens: 1500 },
      },
    ]);
    expect(html).toContain("Thinking…");
    expect(html).toContain("Reading convex/schema.ts · 1m 05s");
    expect(html).toContain("1,500 tokens");
    expect(html).toContain('aria-label="Stop the Supervisor"');
    expect(html).toMatch(/aria-label="Stop the Supervisor"[^>]*>Stop</);
  });

  it("shows a stop in progress and then the stopped state", () => {
    const stopping = render({ status: "planning" }, [
      { planStatus: "acknowledged", stopping: true, progress: { startedAt: Date.now() } },
    ]);
    expect(stopping).toContain("Stopping… · 0s");
    expect(stopping).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Stop the Supervisor">Stopping…</,
    );
    const stopped = render({ status: "waiting" }, [
      { planStatus: "failed", planError: "SUPERVISOR_STOPPED", stopped: true },
    ]);
    expect(stopped).toContain("Stopped before answering.");
    expect(stopped).not.toContain("Thinking…");
    expect(stopped).not.toContain("couldn&#x27;t plan");
    expect(stopped).not.toContain("Stop the Supervisor");
  });

  it("offers the Supervisor's log once it settled, never while it works", () => {
    const working = render({ status: "planning" }, [{ planStatus: "claimed" }]);
    expect(working).not.toContain("Show what I did");
    const answered = render({ status: "waiting" }, [
      { planned: true, decision: "answer", reply: "It is a control plane." },
      { planStatus: "failed", planError: "SUPERVISOR_STOPPED" },
      { planStatus: "expired" },
    ]);
    // The answered and the stopped message have a log; the withdrawn one never ran.
    expect(answered.match(/Show what I did/g)).toHaveLength(2);
    expect(answered).toContain('aria-haspopup="dialog"');
  });

  it("offers no Stop once the Supervisor decided", () => {
    const html = render({ status: "running" }, [
      { planStatus: "acknowledged", decision: "plan", reply: "Two parts." },
    ]);
    expect(html).toContain("Preparing tasks");
    expect(html).not.toContain("Stop the Supervisor");
  });

  it("renders an answer as safe Markdown with usage", () => {
    const html = render({ status: "waiting" }, [
      {
        decision: "answer",
        reply: "It uses **Convex**.\n<script>x</script>",
        supervisor: { totalTokens: 1234 },
      },
    ]);
    expect(html).toContain("<strong>Convex</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("1,234 tokens");
    expect(html).not.toContain("Planned");
    expect(html).toContain('placeholder="Add to this session…"');
  });

  it("marks a clarifying question and asks for a reply", () => {
    const html = render({ status: "waiting" }, [{ decision: "ask", reply: "Which branch?" }]);
    // Nothing is running: the session reads as idle and can be closed, not stopped.
    expect(html).toContain(">Idle<");
    expect(html).toContain("Close session");
    expect(html).not.toContain(">Waiting<");
    expect(html).toContain("Needs your answer");
    expect(html).toContain("Which branch?");
    expect(html).toContain('placeholder="Reply…"');
  });

  it("shows delegated work with its reply and run summaries", () => {
    const html = render(
      { status: "running" },
      [{ decision: "plan", planned: true, planTaskCount: 2, reply: "Two parts." }],
      [{ _id: "t1", _creationTime: 1, title: "API", status: "running" }] as never,
      [
        {
          _id: "r1",
          _creationTime: 1,
          taskId: "t1",
          role: "builder",
          status: "completed",
          resultSummary: `Changed **3 files**.\n${"More detail. ".repeat(40)}`,
        },
      ] as never,
    );
    expect(html).toContain("Two parts.");
    expect(html).toContain("z-chat-timeline");
    expect(html).toContain("Opened 2 tasks.");
    expect(html).toContain("<strong>3 files</strong>");
    expect(html).toContain("Show more");
    expect(html).toContain('aria-expanded="false"');
  });

  it("keeps a proposal conversational until the owner opens it", () => {
    const html = render({ status: "waiting" }, [
      {
        decision: "propose",
        planned: true,
        planTaskCount: 1,
        reply: "I suggest one focused change.",
        proposedTasks: [
          {
            key: "diagnostics",
            title: "Improve diagnostics",
            description: "Show the failing step.",
          },
        ],
      },
    ]);
    expect(html).toContain("Proposed 1 task. No work opened.");
    expect(html).toContain("Improve diagnostics");
    expect(html).toContain("Open this work");
    expect(html).not.toContain("Builders can now run");
  });

  it("keeps the plain-language failure", () => {
    const html = render({ status: "failed" }, [{ planStatus: "expired" }]);
    expect(html).toContain("Planning didn&#x27;t start in time.");
  });

  it("continues completed and failed sessions; only cancelled starts a new one", () => {
    for (const status of ["completed", "failed"]) {
      const html = render({ status }, [{ planned: true, planTaskCount: 1 }]);
      expect(html).not.toContain("Sending starts a new session");
      expect(html).toContain(">Send<");
    }
    const cancelled = render({ status: "cancelled" }, [{ planned: true, planTaskCount: 1 }]);
    expect(cancelled).toContain("This session has ended. Sending starts a new session.");
    expect(cancelled).toContain('placeholder="Start a new session…"');
  });
});

describe("conversation helpers", () => {
  it("derives the assistant state", () => {
    expect(assistantReply({ ...base, planStatus: "pending" }).kind).toBe("thinking");
    expect(assistantReply({ ...base, planned: true, planTaskCount: 1 })).toEqual({
      kind: "delegated",
      taskCount: 1,
    });
    expect(
      assistantReply({ ...base, planStatus: "acknowledged", decision: "plan", reply: "ok" }),
    ).toEqual({ kind: "thinking", reply: "ok" });
    expect(
      assistantReply({
        ...base,
        planned: true,
        planTaskCount: 2,
        decision: "propose",
      }),
    ).toEqual({ kind: "proposal", taskCount: 2 });
    expect(assistantReply({ ...base, planStatus: "failed", planError: "x" }).kind).toBe("error");
    expect(
      assistantReply({
        ...base,
        planStatus: "claimed",
        progress: { activity: "Running rg", startedAt: 5 },
      }),
    ).toEqual({ kind: "thinking", stoppable: true, activity: "Running rg", startedAt: 5 });
    expect(assistantReply({ ...base, planStatus: "expired", stopped: true })).toEqual({
      kind: "stopped",
    });
    expect(
      assistantReply({ ...base, planStatus: "failed", planError: "SUPERVISOR_STOPPED" }),
    ).toEqual({ kind: "stopped" });
    // An answer that finished before the stop wins.
    expect(
      assistantReply({ ...base, planned: true, decision: "answer", reply: "Hi", stopping: true }),
    ).toEqual({ kind: "answer", reply: "Hi" });
  });

  it("formats the elapsed time and the thinking line", () => {
    expect(elapsedLabel(-5)).toBe("0s");
    expect(elapsedLabel(12_400)).toBe("12s");
    expect(elapsedLabel(65_000)).toBe("1m 05s");
    expect(elapsedLabel(3_720_000)).toBe("1h 02m");
    expect(thinkingDetail({ kind: "thinking" }, "Reading the repository", 0)).toBe(
      "Reading the repository",
    );
    expect(
      thinkingDetail({ kind: "thinking", activity: "Reading a.ts", startedAt: 0 }, "x", 3000),
    ).toBe("Reading a.ts · 3s");
    expect(
      thinkingDetail({ kind: "thinking", activity: "a", stopping: true, startedAt: 0 }, "x", 0),
    ).toBe("Stopping… · 0s");
  });

  it("formats usage only when reported", () => {
    expect(usageLine(base)).toBeUndefined();
    expect(usageLine({ ...base, supervisor: { totalTokens: 1 } })).toBe("1 token");
    expect(usageLine({ ...base, supervisor: { modelActual: "m", totalTokens: 2000 } })).toBe(
      "m · 2,000 tokens",
    );
  });

  it("only refuses follow-ups for cancelled sessions", () => {
    expect(startsNewSession("cancelled")).toBe(true);
    expect(startsNewSession("completed")).toBe(false);
    expect(startsNewSession("failed")).toBe(false);
    expect(likelyLongSummary("short")).toBe(false);
  });
});
