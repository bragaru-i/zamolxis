import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import type { StartRunInput } from "@zamolxis/runtime-core";
import { defineRuntimeAdapterContract } from "@zamolxis/test-kit/runtime-contract";
import { describe, expect, it, vi } from "vitest";
import type { AppServerNotification } from "./app-server-client";
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
}
function harness() {
  const connection = new ControlledConnection();
  const connect = vi.fn(() => connection);
  const runtime = new CodexRuntime({ connect, stopTimeoutMs: 5, now: () => 0 });
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
      command: "SECRET",
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
    expect(all[3]?.payload).toEqual({ paths: ["src/index.ts"] });
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
    expect(h.runtime.capabilities().canResume).toBe(false);
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
