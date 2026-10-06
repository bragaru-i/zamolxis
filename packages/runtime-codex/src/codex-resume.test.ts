import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import { RESTART_CONTINUATION, type StartRunInput } from "@zamolxis/runtime-core";
import { defineRuntimeResumeContract } from "@zamolxis/test-kit/runtime-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerNotification,
  AppServerRequestHandler,
  AppServerRequestId,
} from "./app-server-client";
import { type CodexConnection, CodexRuntime } from "./codex-runtime";

interface StoredTurn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: Record<string, unknown>[];
}
interface StoredThread {
  cwd: string;
  turns: StoredTurn[];
}
/**
 * Codex's rollout files under CODEX_HOME: threads outlive the app-server process that ran
 * them. A process that exits leaves its turn in progress recorded as interrupted, like
 * codex-cli 0.160.0 does when its stdin closes or it is killed.
 */
class Rollouts {
  readonly threads = new Map<string, StoredThread>();
  threadStatus: Record<string, unknown> = { type: "idle" };
  // Every new turn asks for one command approval (the agent "needs" it again).
  askOnTurn = false;
  #turns = 0;
  nextTurnId(): string {
    return `turn-${++this.#turns}`;
  }
}
/** One app-server process speaking the subset of the protocol the adapter uses. */
class NativeConnection implements CodexConnection {
  readonly listeners = new Set<(event: AppServerNotification) => void>();
  readonly closers = new Set<() => void>();
  handler: AppServerRequestHandler | undefined;
  readonly responses: { id: AppServerRequestId; result: Record<string, unknown> }[] = [];
  closed = false;
  #requests = 0;
  // Threads this process runs a turn for.
  readonly running = new Set<string>();
  constructor(readonly rollouts: Rollouts) {}
  initialize = vi.fn(async () => {});
  request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (this.closed) throw new Error("CODEX_TRANSPORT_CLOSED");
    const threadId = String(params.threadId ?? "");
    if (method === "thread/start") {
      const id = `thread-${this.rollouts.threads.size + 1}`;
      this.rollouts.threads.set(id, { cwd: String(params.cwd), turns: [] });
      return { thread: { id, cwd: params.cwd }, model: "gpt-test" };
    }
    if (method === "thread/resume") {
      const thread = this.rollouts.threads.get(threadId);
      if (!thread) throw new Error("CODEX_REQUEST_REJECTED");
      return {
        thread: { id: threadId, cwd: thread.cwd, status: this.rollouts.threadStatus, turns: [] },
        model: "gpt-test",
      };
    }
    if (method === "thread/turns/list") {
      const thread = this.rollouts.threads.get(threadId);
      if (!thread) throw new Error("CODEX_REQUEST_REJECTED");
      return { data: thread.turns.slice(-1).reverse(), nextCursor: null };
    }
    if (method === "turn/start") {
      const thread = this.rollouts.threads.get(threadId);
      if (!thread) throw new Error("CODEX_REQUEST_REJECTED");
      const turn: StoredTurn = { id: this.rollouts.nextTurnId(), status: "inProgress", items: [] };
      thread.turns.push(turn);
      this.running.add(threadId);
      this.emit(threadId, "turn/started", { turn: { id: turn.id } });
      if (this.rollouts.askOnTurn)
        setTimeout(() =>
          this.ask(threadId, turn.id, "item/commandExecution/requestApproval", {
            command: "pnpm install",
          }),
        );
      return { turn: { id: turn.id, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      this.settle(threadId, "interrupted");
      return {};
    }
    throw new Error("unexpected method");
  });
  // Ends the thread's running turn as the app-server would and notifies the client.
  settle(threadId: string, status: StoredTurn["status"], items: StoredTurn["items"] = []): void {
    const turn = this.rollouts.threads.get(threadId)?.turns.at(-1);
    if (turn?.status !== "inProgress") return;
    turn.status = status;
    turn.items.push(...items);
    this.running.delete(threadId);
    this.emit(threadId, "turn/completed", { turn: { id: turn.id, status } });
  }
  ask(threadId: string, turnId: string, method: string, params: Record<string, unknown>): boolean {
    return (
      this.handler?.({
        id: ++this.#requests,
        method,
        params: { threadId, turnId, itemId: "item", ...params },
      }) ?? false
    );
  }
  emit(threadId: string, method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener({ method, params: { threadId, ...params } });
  }
  onNotification(listener: (event: AppServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onServerRequest(handler: AppServerRequestHandler) {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  respond(id: AppServerRequestId, result: Record<string, unknown>) {
    this.responses.push({ id, result });
  }
  onClose(listener: () => void) {
    this.closers.add(listener);
    return () => this.closers.delete(listener);
  }
  // The process exits: its turns in flight are recorded as interrupted.
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const threadId of this.running) {
      const turn = this.rollouts.threads.get(threadId)?.turns.at(-1);
      if (turn?.status === "inProgress") turn.status = "interrupted";
    }
    this.running.clear();
    for (const listener of this.closers) listener();
  }
}
const input = (runId = "run"): StartRunInput => ({
  runId: runId as AgentRunId,
  workstationId: "node" as WorkstationId,
  instruction: "Do the task",
  workspace: {
    workspaceId: "workspace" as WorkspaceId,
    cwd: "/assigned/worktree",
    branch: "task",
    headSha: "abc",
  },
});
function node(rollouts: Rollouts) {
  const connections: NativeConnection[] = [];
  const runtime = new CodexRuntime({
    connect: () => {
      const connection = new NativeConnection(rollouts);
      connections.push(connection);
      return connection;
    },
    now: () => 0,
  });
  // The Node process ends: every app-server child exits with it.
  const exit = () => {
    for (const connection of connections) connection.close();
  };
  return { runtime, connections, exit };
}
async function collect(runtime: CodexRuntime, nativeSessionId: string, afterSequence = 0) {
  const events: NormalizedRunEventDto[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId, afterSequence }))
    events.push(event);
  return events;
}
{
  const rollouts = new Rollouts();
  rollouts.askOnTurn = true;
  let runs = 0;
  let previous: ReturnType<typeof node> | undefined;
  defineRuntimeResumeContract("CodexRuntime", {
    create: () => {
      // Creating the next process means the previous one ended.
      previous?.exit();
      previous = node(rollouts);
      return previous.runtime;
    },
    input: () => input(`run-${++runs}`),
    requestApproval: async () => {},
  });
}

describe("Codex resume after a Node restart", () => {
  it("resumes the thread with the assigned sandbox and continues an interrupted turn", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start({ ...input(), role: "builder", model: "m" });
    before.exit();
    const after = node(rollouts);
    const resumed = await after.runtime.resume({
      ...input(),
      role: "builder",
      model: "m",
      nativeSessionId: started.nativeSessionId,
      afterSequence: 7,
      interrupted: "continue",
    });
    expect(resumed).toMatchObject({ state: "running", lastSequence: 8 });
    const calls = after.connections[0]?.request.mock.calls ?? [];
    expect(calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/turns/list",
      "turn/start",
    ]);
    expect(calls[0]?.[1]).toEqual({
      threadId: started.nativeSessionId,
      cwd: "/assigned/worktree",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "m",
      excludeTurns: true,
    });
    expect(calls[1]?.[1]).toEqual({
      threadId: started.nativeSessionId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    expect(calls[2]?.[1]).toEqual({
      threadId: started.nativeSessionId,
      cwd: "/assigned/worktree",
      input: [{ type: "text", text: RESTART_CONTINUATION }],
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/assigned/worktree"],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    // The continuation turn streams and completes like any other.
    after.connections[0]?.settle(started.nativeSessionId, "completed");
    const events = await collect(after.runtime, started.nativeSessionId);
    expect(events.map((event) => [event.sequence, event.eventId, event.type])).toEqual([
      [8, `${started.nativeSessionId}:8`, "run.activity"],
      [9, `${started.nativeSessionId}:9`, "run.completed"],
    ]);
  });
  it("keeps a resumed Verifier read-only", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start({ ...input(), role: "verifier" });
    before.exit();
    const after = node(rollouts);
    await after.runtime.resume({
      ...input(),
      role: "verifier",
      nativeSessionId: started.nativeSessionId,
      interrupted: "continue",
    });
    const calls = after.connections[0]?.request.mock.calls ?? [];
    expect(calls[0]?.[1]).toMatchObject({ sandbox: "read-only" });
    expect(calls[2]?.[1]).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(calls[2]?.[1].sandboxPolicy).not.toHaveProperty("writableRoots");
  });
  it("completes a turn that finished before the restart with its redacted final reply", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start(input());
    // The turn ended, but the Node died before it recorded the completion.
    const thread = rollouts.threads.get(started.nativeSessionId);
    const turn = thread?.turns.at(-1);
    if (!turn) throw new Error("missing turn");
    turn.status = "completed";
    turn.items.push(
      { type: "userMessage", id: "u" },
      { type: "agentMessage", id: "a", text: "Working on it" },
      { type: "agentMessage", id: "b", text: "Done. Used API_TOKEN=supersecretvalue123" },
    );
    before.exit();
    const after = node(rollouts);
    const resumed = await after.runtime.resume({
      ...input(),
      nativeSessionId: started.nativeSessionId,
      afterSequence: 3,
      announce: true,
      interrupted: "continue",
    });
    expect(resumed.state).toBe("completed");
    const calls = after.connections[0]?.request.mock.calls ?? [];
    expect(calls.map(([method]) => method)).not.toContain("turn/start");
    const events = await collect(after.runtime, started.nativeSessionId);
    expect(events.map((event) => [event.sequence, event.type, event.payload])).toEqual([
      [4, "run.started", { nativeSessionId: started.nativeSessionId }],
      [5, "run.usage", { modelActual: "gpt-test" }],
      [6, "run.completed", { summary: "Done. Used API_TOKEN=***" }],
    ]);
    expect(after.connections[0]?.closed).toBe(true);
  });
  it("reports a failed last turn and fails or stops an interrupted one when asked", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const failed = await before.runtime.start(input("failed"));
    const turn = rollouts.threads.get(failed.nativeSessionId)?.turns.at(-1);
    if (turn) turn.status = "failed";
    const interrupted = await before.runtime.start(input("interrupted"));
    before.exit();
    const after = node(rollouts);
    expect(
      (
        await after.runtime.resume({
          ...input("failed"),
          nativeSessionId: failed.nativeSessionId,
          interrupted: "continue",
        })
      ).state,
    ).toBe("failed");
    expect(
      (
        await after.runtime.resume({
          ...input("interrupted"),
          nativeSessionId: interrupted.nativeSessionId,
        })
      ).state,
    ).toBe("failed");
    const events = await collect(after.runtime, interrupted.nativeSessionId);
    expect(events.at(-1)?.payload).toEqual({
      code: "NODE_RESTART_INTERRUPTED",
      message: "Interrupted by a Node restart",
    });
  });
  it("requires reconciliation when the thread may still run elsewhere and never starts a turn", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start(input());
    // The old process is still alive: its turn is in progress.
    const after = node(rollouts);
    await expect(
      after.runtime.resume({
        ...input(),
        nativeSessionId: started.nativeSessionId,
        interrupted: "continue",
      }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
    rollouts.threadStatus = { type: "active", activeFlags: [] };
    before.exit();
    await expect(
      after.runtime.resume({
        ...input(),
        nativeSessionId: started.nativeSessionId,
        interrupted: "continue",
      }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
    for (const connection of after.connections) {
      expect(connection.request.mock.calls.map(([method]) => method)).not.toContain("turn/start");
      expect(connection.closed).toBe(true);
    }
    await expect(after.runtime.inspect(started.nativeSessionId)).rejects.toThrow();
  });
  it("scopes approval ids of a resumed session and keeps usage totals monotonic", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start(input());
    before.exit();
    const after = node(rollouts);
    await after.runtime.resume({
      ...input(),
      nativeSessionId: started.nativeSessionId,
      afterSequence: 5,
      interrupted: "continue",
      usage: { inputTokens: 500, totalTokens: 600, modelCalls: 3 },
    });
    const connection = after.connections[0];
    const turnId = rollouts.threads.get(started.nativeSessionId)?.turns.at(-1)?.id ?? "";
    // A new app-server numbers its requests from 1 again.
    expect(
      connection?.ask(started.nativeSessionId, turnId, "item/commandExecution/requestApproval", {
        command: "pnpm test",
      }),
    ).toBe(true);
    connection?.emit(started.nativeSessionId, "thread/tokenUsage/updated", {
      turnId,
      tokenUsage: {
        total: { inputTokens: 400, cachedInputTokens: 10, outputTokens: 20, totalTokens: 700 },
      },
    });
    connection?.settle(started.nativeSessionId, "completed");
    const events = await collect(after.runtime, started.nativeSessionId, 5);
    expect(events.find((event) => event.type === "approval.requested")?.payload).toMatchObject({
      approvalId: "run:r5.1",
    });
    expect(events.find((event) => event.type === "run.usage")?.payload).toEqual({
      inputTokens: 500,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 700,
      modelCalls: 4,
    });
  });
  it("shares one reattachment between concurrent resumes and rejects a conflicting one", async () => {
    const rollouts = new Rollouts();
    const before = node(rollouts);
    const started = await before.runtime.start(input());
    before.exit();
    const after = node(rollouts);
    const request = { ...input(), nativeSessionId: started.nativeSessionId, afterSequence: 2 };
    const [a, b] = await Promise.all([
      after.runtime.resume({ ...request, interrupted: "continue" }),
      after.runtime.resume({ ...request, interrupted: "continue" }),
    ]);
    expect(a).toEqual(b);
    expect(after.connections).toHaveLength(1);
    // Attached now: resuming again is a no-op, even with other recovery options.
    await expect(after.runtime.resume({ ...request, afterSequence: 9 })).resolves.toMatchObject({
      lastSequence: 3,
    });
    expect(after.connections).toHaveLength(1);
  });
});
