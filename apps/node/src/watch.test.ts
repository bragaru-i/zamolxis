import { describe, expect, it } from "vitest";
import {
  commandText,
  formatTokens,
  HEAVY_RUN_TOKENS,
  type OutboxRow,
  renderLine,
  renderStatus,
  WatchState,
} from "./watch";

let id = 0;
const row = (payload: unknown, createdAt = 1_000): OutboxRow => ({
  id: ++id,
  createdAt,
  payload: JSON.stringify(payload),
});
const events = (
  runId: string,
  list: Array<{ type: string; payload?: unknown; occurredAt?: number }>,
) => row({ kind: "run.events", runId, events: list.map((event) => ({ payload: {}, ...event })) });
const plain = { color: false, width: 120 };

describe("pnpm zamolxis watch", () => {
  it("follows a Builder run: commands, approvals, tokens and its end", () => {
    const state = new WatchState(() => ({ role: "builder" }));
    const lines = [
      events("run-abcd", [
        { type: "run.started", occurredAt: 10 },
        {
          type: "tool.completed",
          occurredAt: 20,
          payload: { tool: "command", summary: "/bin/zsh -lc 'pnpm test'", success: true },
        },
        {
          type: "approval.requested",
          payload: { summary: "Run: /bin/zsh -lc 'pnpm install'\nReason: registry" },
        },
        { type: "run.usage", payload: { totalTokens: 120_000 } },
        { type: "run.activity", payload: { label: "Running tests" } },
      ]),
    ].flatMap((value) => state.ingest(value));
    expect(lines.map((line) => [line.who, line.text, line.tone])).toEqual([
      ["Builder abcd", "started", "info"],
      ["Builder abcd", "pnpm test", "ok"],
      ["Builder abcd", "waiting for your approval: pnpm install", "warn"],
    ]);
    expect(lines[1]?.at).toBe(20);
    expect(state.waiting).toBe(1);
    expect(state.active[0]?.activity).toBe("Running tests");

    const end = state.ingest(
      events("run-abcd", [
        { type: "approval.resolved", payload: { decision: "approved" } },
        { type: "run.usage", payload: { totalTokens: HEAVY_RUN_TOKENS + 1 } },
        { type: "run.usage", payload: { totalTokens: HEAVY_RUN_TOKENS + 2 } },
        { type: "run.completed" },
      ]),
    );
    expect(end.map((line) => line.text)).toEqual([
      "approval approved",
      "uses a lot of tokens: 500k so far",
      "completed · 500k tokens",
    ]);
    expect(state.active).toEqual([]);
    expect(state.agentTokens).toBe(HEAVY_RUN_TOKENS + 2);
  });
  it("counts Supervisor answers and plans once each, and shows checks and pull requests", () => {
    const state = new WatchState(() => undefined);
    const lines = [
      row({ kind: "orchestrator.answer", decision: "propose", usage: { totalTokens: 9_500 } }),
      row({ kind: "repository.plan", tasks: [{}, {}], usage: { totalTokens: 17_700 } }),
      row({
        kind: "run.complete",
        evidence: [{ result: "passed" }, { result: "failed" }],
      }),
      row({ kind: "integration.published", prUrl: "https://github.com/o/r/pull/1" }),
      row({ kind: "command.complete" }),
      { id: ++id, createdAt: 1, payload: "not json" },
    ].flatMap((value) => state.ingest(value));
    expect(lines.map((line) => line.text)).toEqual([
      "answered (propose) · 9.5k tokens",
      "planned 2 tasks · 17.7k tokens",
      "1 of 2 failed",
      "pull request opened https://github.com/o/r/pull/1",
    ]);
    expect(state.supervisorTokens).toBe(27_200);
    expect(state.supervisorCalls).toBe(2);
  });
  it("says who failed, on which model and why", () => {
    const state = new WatchState(
      () => ({ role: "builder" }),
      (commandId) =>
        commandId === "old" ? { type: "orchestrator.answer", runtime: "codex" } : undefined,
    );
    const lines = [
      row({
        kind: "command.failed",
        commandId: "new",
        code: "SUPERVISOR_FAILED",
        failure: {
          agent: "supervisor",
          runtime: "claude",
          model: "claude-opus-5-5",
          reason: "Claude turn failed: You've hit your session limit",
          at: 42,
        },
      }),
      row({ kind: "command.failed", commandId: "old", code: "ORCHESTRATOR_FAILED" }),
      events("run-abcd", [
        { type: "run.usage", payload: { modelActual: "gpt-6.1-sol", totalTokens: 9_000 } },
        { type: "run.failed", payload: { message: "Codex turn failed: Quota exceeded" } },
      ]),
    ].flatMap((value) => state.ingest(value));
    expect(lines.map((line) => [line.who, line.text, line.tone])).toEqual([
      ["Supervisor", "failed · claude claude-opus-5-5 · You've hit your session limit", "fail"],
      ["Assistant", "failed · codex · orchestrator failed", "fail"],
      ["Builder abcd", "failed · gpt-6.1-sol · 9.0k tokens · Quota exceeded", "fail"],
    ]);
    expect(lines[0]?.at).toBe(42);
  });
  it("renders a status block with today's total that fits the terminal", () => {
    const state = new WatchState(() => ({ role: "verifier" }));
    state.ingest(events("run-wxyz", [{ type: "run.usage", payload: { totalTokens: 2_590_000 } }]));
    state.ingest(row({ kind: "orchestrator.answer", usage: { totalTokens: 10_000 } }));
    const status = renderStatus({ color: false, width: 60 }, state, {
      name: "MacBook",
      service: "Node service running",
    });
    expect(status[1]).toContain("Verifier wxyz");
    expect(status[1]).toContain("2.59M tokens");
    expect(status[2]).toContain("Today: 2.60M tokens");
    for (const line of status) expect(line.length).toBeLessThanOrEqual(80);
    const line = renderLine(plain, {
      at: 0,
      who: "Builder abcd",
      text: "x".repeat(300),
      tone: "ok",
    });
    expect(line.length).toBe(plain.width);
  });
  it("formats tokens and unwraps login-shell commands", () => {
    expect([999, 12_345, 250_000, 2_590_000, 12_500_000].map(formatTokens)).toEqual([
      "999",
      "12.3k",
      "250k",
      "2.59M",
      "12.5M",
    ]);
    expect(commandText(`/bin/zsh -lc "node -e 'x'"`)).toBe("node -e 'x'");
    expect(commandText("git status")).toBe("git status");
  });
});
