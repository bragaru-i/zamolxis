import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import type { StartRunInput } from "@zamolxis/runtime-core";
import {
  defineRuntimeAdapterContract,
  defineRuntimeApprovalContract,
} from "@zamolxis/test-kit/runtime-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerNotification,
  AppServerRequestHandler,
  AppServerRequestId,
} from "./app-server-client";
import { type CodexConnection, CodexRuntime } from "./codex-runtime";

const input = (): StartRunInput => ({
  runId: "run" as AgentRunId,
  workstationId: "node" as WorkstationId,
  instruction: "Do the task",
  workspace: {
    workspaceId: "workspace" as WorkspaceId,
    cwd: "/assigned/worktree",
    branch: "task",
    headSha: "abc",
  },
});
class ControlledConnection implements CodexConnection {
  listeners = new Set<(event: AppServerNotification) => void>();
  closers = new Set<() => void>();
  complete = false;
  interrupt = true;
  initialize = vi.fn(async () => {});
  request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "thread/start") return { thread: { id: "native", cwd: params.cwd } };
    if (method === "turn/start") {
      this.emit("turn/started", { turn: { id: "turn" } });
      if (this.complete) this.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
      return { turn: { id: "turn", status: "inProgress" } };
    }
    if (method === "turn/steer") return { turnId: "turn" };
    if (method === "turn/interrupt") {
      if (this.interrupt)
        this.emit("turn/completed", { turn: { id: "turn", status: "interrupted" } });
      return {};
    }
    throw new Error("unexpected method");
  });
  onNotification(listener: (event: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: () => void) {
    this.closers.add(listener);
    return () => this.closers.delete(listener);
  }
  close() {
    for (const listener of this.closers) listener();
  }
  emit(method: string, params: Record<string, unknown>) {
    for (const listener of this.listeners)
      listener({ method, params: { threadId: "native", turnId: "turn", ...params } });
  }
  handler: AppServerRequestHandler | undefined;
  responses: { id: AppServerRequestId; result: Record<string, unknown> }[] = [];
  onServerRequest(handler: AppServerRequestHandler) {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  respond(id: AppServerRequestId, result: Record<string, unknown>) {
    this.responses.push({ id, result });
  }
  // Returns whether the runtime held the request (the transport refuses it otherwise).
  ask(id: AppServerRequestId, method: string, params: Record<string, unknown>): boolean {
    return (
      this.handler?.({
        id,
        method,
        params: { threadId: "native", turnId: "turn", itemId: "item", ...params },
      }) ?? false
    );
  }
}
function harness(approvalTimeoutMs?: number) {
  const connection = new ControlledConnection();
  const connect = vi.fn(() => connection);
  const runtime = new CodexRuntime({
    connect,
    stopTimeoutMs: 5,
    now: () => 0,
    ...(approvalTimeoutMs ? { approvalTimeoutMs } : {}),
  });
  return { runtime, connection, connect };
}
async function events(runtime: CodexRuntime): Promise<NormalizedRunEventDto[]> {
  const result: NormalizedRunEventDto[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId: "native" })) result.push(event);
  return result;
}
defineRuntimeAdapterContract("CodexRuntime", {
  create: () => {
    const h = harness();
    h.connection.complete = true;
    return h.runtime;
  },
  input,
});
{
  let current: ControlledConnection | undefined;
  defineRuntimeApprovalContract("CodexRuntime", {
    create: () => {
      const h = harness();
      current = h.connection;
      return h.runtime;
    },
    input,
    requestApproval: async () => {
      expect(
        current?.ask(1, "item/commandExecution/requestApproval", { command: "pnpm test" }),
      ).toBe(true);
    },
  });
}
describe("Codex approval bridge", () => {
  // Reads events until the count-th event of a type (Codex subscriptions block until terminal).
  const until = async (runtime: CodexRuntime, type: string, count = 1) => {
    const seen: NormalizedRunEventDto[] = [];
    let matched = 0;
    for await (const event of runtime.subscribe({ nativeSessionId: "native" })) {
      seen.push(event);
      if (event.type === type && ++matched === count) break;
    }
    return seen;
  };
  it("holds a command approval and answers with the app-server accept/decline shape", async () => {
    const h = harness();
    await h.runtime.start(input());
    expect(
      h.connection.ask(7, "item/commandExecution/requestApproval", {
        command: "curl https://example.com",
        cwd: "/assigned/worktree",
        reason: "Fetch docs",
      }),
    ).toBe(true);
    expect(h.connection.responses).toEqual([]);
    const requested = (await until(h.runtime, "approval.requested")).at(-1);
    expect(requested?.payload).toEqual({
      approvalId: "run:7",
      kind: "command",
      summary: "Run: curl https://example.com\nReason: Fetch docs",
      risk: "high",
    });
    expect((await h.runtime.inspect("native")).state).toBe("running");
    await h.runtime.resolveApproval({
      nativeSessionId: "native",
      approvalId: "run:7",
      decision: "approve",
    });
    expect(h.connection.responses).toEqual([{ id: 7, result: { decision: "accept" } }]);
    expect(
      h.connection.ask(8, "item/commandExecution/requestApproval", { command: "rm -rf x" }),
    ).toBe(true);
    await h.runtime.resolveApproval({
      nativeSessionId: "native",
      approvalId: "run:8",
      decision: "reject",
    });
    expect(h.connection.responses[1]).toEqual({ id: 8, result: { decision: "decline" } });
    const resolved = (await until(h.runtime, "approval.resolved", 2)).filter(
      (event) => event.type === "approval.resolved",
    );
    expect(resolved.map((event) => event.payload)).toEqual([
      { approvalId: "run:7", decision: "approved", reason: "user" },
      { approvalId: "run:8", decision: "rejected", reason: "user" },
    ]);
    await expect(
      h.runtime.resolveApproval({
        nativeSessionId: "native",
        approvalId: "run:8",
        decision: "approve",
      }),
    ).rejects.toThrow("APPROVAL_NOT_PENDING");
  });
  it("describes file changes from the proposed item and flags deletion and outside writes", async () => {
    const h = harness();
    await h.runtime.start(input());
    h.connection.emit("item/started", {
      item: {
        id: "item",
        type: "fileChange",
        status: "inProgress",
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "" },
          { path: "old.ts", kind: { type: "delete" }, diff: "" },
        ],
      },
    });
    expect(h.connection.ask("f1", "item/fileChange/requestApproval", {})).toBe(true);
    expect(
      h.connection.ask("f2", "item/fileChange/requestApproval", { grantRoot: "/Users/me" }),
    ).toBe(true);
    const all = await until(h.runtime, "approval.requested", 2);
    const requests = all.filter((event) => event.type === "approval.requested");
    expect(requests.map((event) => event.payload)).toEqual([
      {
        approvalId: "run:f1",
        kind: "fileChange",
        summary: "Change files: src/a.ts, old.ts (delete)",
        risk: "high",
      },
      {
        approvalId: "run:f2",
        kind: "fileChange",
        summary:
          "Change files: src/a.ts, old.ts (delete)\nWrite access outside the workspace: /Users/me",
        risk: "critical",
      },
    ]);
  });
  it("rejects after the timeout and refuses unsupported, foreign and read-only requests", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(1000);
      await h.runtime.start(input());
      expect(h.connection.ask(1, "item/commandExecution/requestApproval", { command: "ls" })).toBe(
        true,
      );
      vi.advanceTimersByTime(1001);
      expect(h.connection.responses).toEqual([{ id: 1, result: { decision: "decline" } }]);
      for (const method of [
        "account/chatgptAuthTokens/refresh",
        "attestation/generate",
        "item/permissions/requestApproval",
        "item/tool/call",
        "item/tool/requestUserInput",
        "execCommandApproval",
      ])
        expect(h.connection.ask(2, method, {})).toBe(false);
      expect(
        h.connection.ask(3, "item/commandExecution/requestApproval", {
          threadId: "foreign",
          command: "ls",
        }),
      ).toBe(false);
      expect(
        h.connection.ask(4, "mcpServer/elicitation/request", {
          mode: "form",
          serverName: "s",
          message: "Your password?",
          requestedSchema: { type: "object", properties: { password: { type: "string" } } },
        }),
      ).toBe(false);
      const verifier = harness();
      await verifier.runtime.start({ ...input(), role: "verifier" });
      expect(
        verifier.connection.ask(5, "item/commandExecution/requestApproval", { command: "ls" }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects pending approvals before the terminal event when the turn ends", async () => {
    const h = harness();
    await h.runtime.start(input());
    expect(
      h.connection.ask("t", "mcpServer/elicitation/request", {
        mode: "form",
        serverName: "docs",
        message: "Allow lookup?",
        requestedSchema: { type: "object", properties: {} },
      }),
    ).toBe(true);
    h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    const all = await events(h.runtime);
    expect(all.map((event) => event.type).slice(-3)).toEqual([
      "approval.requested",
      "approval.resolved",
      "run.completed",
    ]);
    expect(all.find((event) => event.type === "approval.requested")?.payload).toMatchObject({
      kind: "tool",
      summary: "Tool docs: Allow lookup?",
      risk: "high",
    });
    expect(h.connection.responses).toEqual([
      { id: "t", result: { action: "decline", content: null, _meta: null } },
    ]);
  });
  it("forgets a request the runtime withdrew without answering it", async () => {
    const h = harness();
    await h.runtime.start(input());
    expect(h.connection.ask(9, "item/commandExecution/requestApproval", { command: "ls" })).toBe(
      true,
    );
    h.connection.emit("serverRequest/resolved", { requestId: 9 });
    const all = await until(h.runtime, "approval.resolved");
    expect(all.at(-1)?.payload).toEqual({
      approvalId: "run:9",
      decision: "rejected",
      reason: "withdrawn",
    });
    expect(h.connection.responses).toEqual([]);
  });
});
describe("Codex native lifecycle", () => {
  it("reserves concurrent starts, binds cwd and constrains local permissions", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.runtime.start(input()), h.runtime.start(input())]);
    expect(a.nativeSessionId).toBe(b.nativeSessionId);
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.connect).toHaveBeenCalledWith(input().workspace.cwd);
    expect(h.connection.request.mock.calls[1]?.[1]).toMatchObject({
      cwd: input().workspace.cwd,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        writableRoots: [input().workspace.cwd],
        networkAccess: false,
        excludeSlashTmp: true,
      },
    });
    await expect(h.runtime.start({ ...input(), instruction: "different" })).rejects.toThrow(
      "CONFLICT",
    );
    await h.runtime.stop({ nativeSessionId: "native" });
  });
  it("normalizes ordered tool/file/activity events and ignores duplicate and foreign events", async () => {
    const h = harness();
    await h.runtime.start(input());
    const item = {
      id: "cmd",
      type: "commandExecution",
      command: '/bin/zsh -lc "GITHUB_TOKEN=SECRET pnpm test"',
      aggregatedOutput: "SECRET",
      status: "completed",
      exitCode: 0,
    };
    h.connection.emit("item/started", { item });
    h.connection.emit("item/started", { item });
    h.connection.emit("item/completed", { item });
    h.connection.emit("item/started", {
      threadId: "foreign",
      item: { id: "other", type: "agentMessage" },
    });
    h.connection.emit("item/completed", {
      item: {
        id: "file",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "/assigned/worktree/src/index.ts" }],
      },
    });
    h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    const all = await events(h.runtime);
    expect(all.map((e) => e.type)).toEqual([
      "run.started",
      "tool.started",
      "tool.completed",
      "files.changed",
      "run.completed",
    ]);
    expect(JSON.stringify(all)).not.toContain("SECRET");
    expect(all[1]?.payload).toEqual({ tool: "command", summary: "GITHUB_TOKEN=*** pnpm test" });
    expect(all[3]?.payload).toEqual({ paths: ["src/index.ts"] });
  });
  it("emits real, redacted tool summaries and short activity labels", async () => {
    const h = harness();
    await h.runtime.start(input());
    const items = [
      { id: "r", type: "reasoning", summary: ["PRIVATE"], content: ["PRIVATE"] },
      {
        id: "c",
        type: "commandExecution",
        command: '/bin/zsh -lc "curl -u me:PASSWORD https://example.com"',
        aggregatedOutput: "PRIVATE",
        status: "failed",
        exitCode: 7,
      },
      {
        id: "m",
        type: "mcpToolCall",
        server: "docs",
        tool: "search",
        arguments: { q: "PRIVATE" },
        status: "completed",
      },
      { id: "w", type: "webSearch", query: "codex app-server", action: null },
      { id: "a", type: "agentMessage", text: "PRIVATE" },
    ];
    for (const item of items) {
      h.connection.emit("item/started", { item: { ...item, status: "inProgress" } });
      h.connection.emit("item/completed", { item });
    }
    h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    const all = await events(h.runtime);
    expect(all.map((e) => [e.type, e.payload])).toEqual([
      ["run.started", { nativeSessionId: "native" }],
      ["run.activity", { label: "Thinking" }],
      ["tool.started", { tool: "command", summary: "curl -u *** https://example.com" }],
      [
        "tool.completed",
        {
          tool: "command",
          summary: "curl -u *** https://example.com · exit code 7",
          success: false,
        },
      ],
      ["tool.started", { tool: "mcp", summary: "docs/search" }],
      ["tool.completed", { tool: "mcp", summary: "docs/search", success: true }],
      ["tool.started", { tool: "web", summary: 'Search "codex app-server"' }],
      ["tool.completed", { tool: "web", summary: 'Search "codex app-server"', success: true }],
      ["run.activity", { label: "Writing reply" }],
      ["run.completed", { summary: "PRIVATE" }],
    ]);
    expect(JSON.stringify(all.slice(0, -1))).not.toMatch(/PRIVATE|PASSWORD/);
  });
  it("redacts secrets from approval summaries and the final reply", async () => {
    const h = harness();
    await h.runtime.start(input());
    expect(
      h.connection.ask(3, "item/commandExecution/requestApproval", {
        command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr list",
        reason: "list with token=abc",
      }),
    ).toBe(true);
    h.connection.emit("item/completed", {
      item: { id: "m", type: "agentMessage", text: "Use password: hunter2 next time" },
    });
    h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    const all = await events(h.runtime);
    const requested = all.find((e) => e.type === "approval.requested")?.payload;
    expect(requested).toMatchObject({
      summary: "Run: GITHUB_TOKEN=*** gh pr list\nReason: list with token=***",
      risk: "critical",
    });
    expect(all.find((e) => e.type === "run.completed")?.payload).toEqual({
      summary: "Use password: *** next time",
    });
  });
  it("keeps the Supervisor's structured reply intact for the Node to parse and redact", async () => {
    const h = harness();
    await h.runtime.start({ ...input(), role: "supervisor" });
    const plan = JSON.stringify({
      decision: "plan",
      reply: "One task.",
      tasks: [{ key: "outcome", title: "Create outcome.txt", description: "Write ALPHA_OK" }],
    });
    h.connection.emit("item/completed", { item: { id: "m", type: "agentMessage", text: plan } });
    h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    const all = await events(h.runtime);
    expect(all.find((e) => e.type === "run.completed")?.payload).toEqual({ summary: plan });
  });
  it("steers only the active native turn and confirms stop before settlement", async () => {
    const h = harness();
    await h.runtime.start(input());
    await h.runtime.send({ nativeSessionId: "native", message: "focus tests" });
    expect(h.connection.request).toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ expectedTurnId: "turn" }),
    );
    await h.runtime.stop({ nativeSessionId: "native" });
    await h.runtime.stop({ nativeSessionId: "native" });
    expect((await h.runtime.inspect("native")).state).toBe("stopped");
    expect(
      h.connection.request.mock.calls.filter(([method]) => method === "turn/interrupt"),
    ).toHaveLength(1);
    await expect(h.runtime.send({ nativeSessionId: "native", message: "late" })).rejects.toThrow(
      "TERMINAL",
    );
  });
  it("requires reconciliation when stop is unconfirmed", async () => {
    const h = harness();
    h.connection.interrupt = false;
    await h.runtime.start(input());
    await expect(h.runtime.stop({ nativeSessionId: "native" })).rejects.toThrow("STOP_UNCONFIRMED");
    await expect(h.runtime.inspect("native")).rejects.toThrow("RECONCILIATION_REQUIRED");
  });
  it("rejects path traversal and never uploads paths outside the workspace", async () => {
    const h = harness();
    await h.runtime.start(input());
    h.connection.emit("item/completed", {
      item: {
        id: "bad",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/../../../secret" }],
      },
    });
    await expect(events(h.runtime)).rejects.toThrow("RECONCILIATION_REQUIRED");
  });
  it("wakes a live subscriber on connection loss without claiming success", async () => {
    const h = harness();
    await h.runtime.start(input());
    const pending = events(h.runtime);
    const assertion = expect(pending).rejects.toThrow("RECONCILIATION_REQUIRED");
    h.connection.close();
    await assertion;
  });
  it("does not relaunch ambiguous starts or unknown sessions after restart", async () => {
    const h = harness();
    h.connection.initialize.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(h.runtime.start(input())).rejects.toThrow("ambiguous");
    await expect(h.runtime.start(input())).rejects.toThrow("ambiguous");
    expect(h.connect).toHaveBeenCalledOnce();
    await expect(h.runtime.inspect("persisted-native")).rejects.toThrow("NOT_FOUND");
    // Resume is explicit (codex-resume.test.ts); inspect never reattaches on its own.
    expect(h.runtime.capabilities().canResume).toBe(true);
  });
});

it("propagates requested model/effort, reports provider usage and makes verifier read-only", async () => {
  const h = harness();
  await h.runtime.start({
    ...input(),
    role: "verifier",
    model: "requested",
    reasoningEffort: "high",
  });
  expect(h.connection.request.mock.calls[0]?.[1]).toMatchObject({
    model: "requested",
    sandbox: "read-only",
  });
  expect(h.connection.request.mock.calls[1]?.[1]).toMatchObject({
    effort: "high",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  expect(h.connection.request.mock.calls[1]?.[1].sandboxPolicy).not.toHaveProperty("writableRoots");
  h.connection.emit("thread/tokenUsage/updated", {
    tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 },
    },
  });
  h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
  const result = await events(h.runtime);
  expect(result.find((event) => event.type === "run.usage")?.payload).toEqual({
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    totalTokens: 120,
  });
});

it("runs the Supervisor read-only and reports the last agent message as the final summary", async () => {
  const h = harness();
  await h.runtime.start({ ...input(), role: "supervisor" });
  expect(h.connection.request.mock.calls[0]?.[1]).toMatchObject({ sandbox: "read-only" });
  expect(h.connection.request.mock.calls[1]?.[1]).toMatchObject({
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  expect(h.connection.request.mock.calls[1]?.[1].sandboxPolicy).not.toHaveProperty("writableRoots");
  h.connection.emit("item/started", { item: { id: "m1", type: "agentMessage", text: "" } });
  h.connection.emit("item/completed", {
    item: { id: "m1", type: "agentMessage", text: "Reading the repository" },
  });
  h.connection.emit("item/completed", {
    item: { id: "m2", type: "agentMessage", text: `  ${"x".repeat(9000)}  ` },
  });
  h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
  const all = await events(h.runtime);
  expect(all.find((event) => event.type === "run.completed")?.payload).toEqual({
    summary: `${"x".repeat(7999)}…`,
  });
});

it("keeps the fixed completion summary when the agent sent no message", async () => {
  const h = harness();
  await h.runtime.start(input());
  h.connection.emit("item/completed", { item: { id: "m1", type: "agentMessage", text: "  " } });
  h.connection.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
  const all = await events(h.runtime);
  expect(all.find((event) => event.type === "run.completed")?.payload).toEqual({
    summary: "Codex turn completed",
  });
});
