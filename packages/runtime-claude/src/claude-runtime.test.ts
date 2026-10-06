import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import { RESTART_CONTINUATION, type StartRunInput } from "@zamolxis/runtime-core";
import {
  defineRuntimeAdapterContract,
  defineRuntimeApprovalContract,
  defineRuntimeResumeContract,
} from "@zamolxis/test-kit/runtime-contract";
import { describe, expect, it } from "vitest";
import { ClaudeRuntime, type ClaudeRuntimeOptions } from "./claude-runtime";
import type { ClaudeLaunch, ClaudeProcess } from "./cli-process";

const CWD = "/assigned/worktree";
const input = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  runId: "run" as AgentRunId,
  workstationId: "node" as WorkstationId,
  instruction: "Do the task",
  workspace: {
    workspaceId: "workspace" as WorkspaceId,
    cwd: CWD,
    branch: "task",
    headSha: "abc",
  },
  ...overrides,
});
const USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 1000,
  output_tokens: 50,
};

/** What the CLI persisted: sessions by id with the cwd they belong to (a restart keeps it). */
class FakeNative {
  sessions = new Map<string, string>();
}
interface Behavior {
  // Finish the turn as soon as it starts.
  complete: boolean;
  // A resumed session asks for permission again in its continuation turn.
  askOnResume: boolean;
  initCwd?: string;
  // Never report the session (a CLI that dies at startup).
  silent?: boolean;
}
/** A fake `claude -p` process speaking the stream-json frames the real CLI uses. */
class FakeClaude implements ClaudeProcess {
  readonly listeners = new Set<(frame: Record<string, unknown>) => void>();
  readonly closers = new Set<() => void>();
  readonly written: Record<string, unknown>[] = [];
  readonly answers = new Map<string, Record<string, unknown>>();
  readonly pending = new Set<string>();
  readonly sessionId: string;
  readonly resumed: boolean;
  closed = false;
  ended = false;
  turns = 0;
  constructor(
    readonly launch: ClaudeLaunch,
    readonly native: FakeNative,
    readonly behavior: Behavior,
  ) {
    const at = (flag: string) => {
      const index = launch.args.indexOf(flag);
      return index >= 0 ? launch.args[index + 1] : undefined;
    };
    this.resumed = launch.args.includes("--resume");
    this.sessionId = at("--resume") ?? at("--session-id") ?? "";
  }
  write(frame: Record<string, unknown>): void {
    if (this.closed) throw new Error("CLAUDE_TRANSPORT_CLOSED");
    this.written.push(frame);
    queueMicrotask(() => this.#handle(frame));
  }
  onFrame(listener: (frame: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: () => void) {
    if (this.closed) listener();
    else this.closers.add(listener);
    return () => this.closers.delete(listener);
  }
  close() {
    this.ended = true;
    this.#exit();
  }
  kill() {
    this.#exit();
  }
  emit(frame: Record<string, unknown>) {
    if (this.closed) return;
    for (const listener of this.listeners) listener({ session_id: this.sessionId, ...frame });
  }
  ask(requestId: string, toolName: string, toolInput: Record<string, unknown>, extra = {}) {
    this.pending.add(requestId);
    this.emit({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: toolName, input: toolInput, ...extra },
    });
  }
  assistant(...content: Record<string, unknown>[]) {
    this.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { model: "claude-test-1", role: "assistant", content },
    });
  }
  toolResult(id: string, isError = false, meta?: unknown) {
    this.emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, is_error: isError }],
      },
      ...(meta ? { tool_result_meta: meta } : {}),
    });
  }
  result(subtype = "success", result = "All done", usage: unknown = USAGE) {
    this.emit({ type: "result", subtype, is_error: subtype !== "success", result, usage });
  }
  #exit() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closers) listener();
  }
  #handle(frame: Record<string, unknown>) {
    if (this.closed) return;
    if (frame.type === "user") {
      if (this.turns++ > 0 || this.behavior.silent) return;
      this.native.sessions.set(this.sessionId, this.behavior.initCwd ?? this.launch.cwd);
      this.emit({
        type: "system",
        subtype: "init",
        cwd: this.behavior.initCwd ?? this.launch.cwd,
        model: "claude-test",
      });
      if (this.resumed && this.behavior.askOnResume)
        this.ask(`again-${this.sessionId}`, "Bash", { command: "pnpm test" });
      else if (this.behavior.complete) {
        this.assistant({ type: "text", text: "All done" });
        this.result();
      }
      return;
    }
    if (frame.type === "control_response") {
      const response = frame.response as Record<string, unknown>;
      const id = String(response.request_id);
      this.pending.delete(id);
      this.answers.set(id, response.response as Record<string, unknown>);
      return;
    }
    if (frame.type === "control_request") {
      const request = frame.request as Record<string, unknown>;
      this.emit({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: {} },
      });
      if (request.subtype === "interrupt") {
        for (const id of this.pending)
          this.emit({ type: "control_cancel_request", request_id: id });
        this.pending.clear();
        this.result("error_during_execution", "");
      }
    }
  }
}
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
function harness(
  behavior: Partial<Behavior> = {},
  options: Partial<ClaudeRuntimeOptions> = {},
  native = new FakeNative(),
) {
  const launches: FakeClaude[] = [];
  const runtime = new ClaudeRuntime({
    launch: (launch) => {
      const process = new FakeClaude(launch, native, {
        complete: false,
        askOnResume: false,
        ...behavior,
      });
      launches.push(process);
      return process;
    },
    sessionExists: (cwd, id) => native.sessions.get(id) === cwd,
    sessionRunning: () => false,
    newSessionId: uuid,
    stopTimeoutMs: 5,
    startTimeoutMs: 1000,
    now: () => 0,
    ...options,
  });
  const current = () => {
    const process = launches.at(-1);
    if (!process) throw new Error("not launched");
    return process;
  };
  return { runtime, launches, current, native };
}
async function until(runtime: ClaudeRuntime, id: string, type: string, count = 1) {
  const seen: NormalizedRunEventDto[] = [];
  let matched = 0;
  for await (const event of runtime.subscribe({ nativeSessionId: id })) {
    seen.push(event);
    if (event.type === type && ++matched === count) break;
  }
  return seen;
}
async function all(runtime: ClaudeRuntime, id: string) {
  const seen: NormalizedRunEventDto[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId: id })) seen.push(event);
  return seen;
}

defineRuntimeAdapterContract("ClaudeRuntime", {
  create: () => harness({ complete: true }).runtime,
  input,
});
// The fake CLI process each runtime launched last, for the contracts' approval hook.
const processes = new WeakMap<object, () => FakeClaude>();
const ask = async (runtime: object) => {
  processes.get(runtime)?.().ask("request-1", "Bash", { command: "pnpm test" });
};
defineRuntimeApprovalContract("ClaudeRuntime", {
  create: () => {
    const h = harness();
    processes.set(h.runtime, h.current);
    return h.runtime;
  },
  input,
  requestApproval: ask,
});
{
  const native = new FakeNative();
  defineRuntimeResumeContract("ClaudeRuntime", {
    // A new runtime process sharing what the CLI persisted.
    create: () => {
      const h = harness({ askOnResume: true }, {}, native);
      processes.set(h.runtime, h.current);
      return h.runtime;
    },
    input,
    requestApproval: ask,
  });
}

describe("ClaudeRuntime launch", () => {
  it("runs a Builder in its workspace with edits accepted and commands sandboxed", async () => {
    const { runtime, current } = harness({ complete: true });
    const started = await runtime.start(
      input({ model: "claude-sonnet-5-5", reasoningEffort: "high" }),
    );
    const { launch } = current();
    expect(launch.cwd).toBe(CWD);
    const args = launch.args;
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ]),
    );
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--tools") + 1]).toBe("Bash,Read,Glob,Grep,Edit,Write,NotebookEdit");
    expect(JSON.parse(String(args[args.indexOf("--settings") + 1]))).toEqual({
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--session-id") + 1]).toBe(started.nativeSessionId);
    expect(args.join(" ")).not.toMatch(/bypassPermissions|dangerously/);
    // The handshake comes first, then the instruction as a user message.
    expect(current().written[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });
    expect(current().written[1]).toMatchObject({
      type: "user",
      message: { role: "user", content: "Do the task" },
    });
  });
  it("keeps read-only roles read-only and denies every permission request without asking", async () => {
    for (const role of ["verifier", "supervisor"] as const) {
      const { runtime, current } = harness();
      const started = await runtime.start(input({ role }));
      const args = current().launch.args;
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Bash");
      expect(args).not.toContain("--settings");
      expect(args.includes("--no-session-persistence")).toBe(role === "supervisor");
      current().ask("write-1", "Write", { file_path: `${CWD}/a.txt`, content: "x" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(current().answers.get("write-1")).toMatchObject({ behavior: "deny" });
      current().result();
      const events = await all(runtime, started.nativeSessionId);
      expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    }
  });
  it("refuses a session the CLI reports for another workspace or id", async () => {
    const { runtime } = harness({ initCwd: "/somewhere/else" });
    await expect(runtime.start(input())).rejects.toThrow("RUNTIME_WORKSPACE_MISMATCH");
  });
  it("fails the start when the CLI ends before reporting its session", async () => {
    const { runtime, current } = harness({ silent: true });
    const started = runtime.start(input());
    await new Promise((resolve) => setTimeout(resolve, 0));
    current().close();
    await expect(started).rejects.toThrow("CLAUDE_PROCESS_EXITED");
  });
});

describe("ClaudeRuntime events", () => {
  it("reports tools, notes, file changes in the workspace, usage and the final reply", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    const cli = current();
    cli.assistant({ type: "thinking", thinking: "", signature: "x" });
    cli.assistant({
      type: "text",
      text: "Reading first. token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    });
    cli.assistant({
      type: "tool_use",
      id: "t1",
      name: "Read",
      input: { file_path: `${CWD}/src/a.ts` },
    });
    cli.toolResult("t1");
    cli.assistant({ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "total" } });
    cli.toolResult("g1");
    cli.assistant({
      type: "tool_use",
      id: "t2",
      name: "Edit",
      input: { file_path: `${CWD}/src/a.ts`, old_string: "a", new_string: "b" },
    });
    cli.toolResult("t2");
    cli.assistant({ type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm test" } });
    cli.toolResult("t3", true);
    cli.assistant({
      type: "tool_use",
      id: "t4",
      name: "Write",
      input: { file_path: "/etc/elsewhere", content: "x" },
    });
    cli.toolResult("t4");
    cli.assistant({ type: "text", text: "Changed src/a.ts" });
    cli.result("success", "Changed src/a.ts");
    const events = await all(runtime, id);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ["run.started", { nativeSessionId: id }],
      ["run.usage", { modelActual: "claude-test-1" }],
      ["run.activity", { label: "Thinking" }],
      ["run.message", { text: "Reading first. token=***" }],
      ["tool.started", { tool: "Read", summary: "Read src/a.ts", reads: ["src/a.ts"] }],
      ["tool.completed", { tool: "Read", summary: "Read src/a.ts", success: true }],
      ["tool.started", { tool: "Grep", summary: "Search total" }],
      ["tool.completed", { tool: "Grep", summary: "Search total", success: true }],
      ["tool.started", { tool: "Edit", summary: "Edit src/a.ts" }],
      ["tool.completed", { tool: "Edit", summary: "Edit src/a.ts", success: true }],
      ["files.changed", { paths: ["src/a.ts"] }],
      ["tool.started", { tool: "command", summary: "pnpm test" }],
      ["tool.completed", { tool: "command", summary: "pnpm test · failed", success: false }],
      ["tool.started", { tool: "Write", summary: "Write /etc/elsewhere" }],
      ["tool.completed", { tool: "Write", summary: "Write /etc/elsewhere", success: true }],
      ["run.activity", { label: "Changed a file outside the workspace" }],
      [
        "run.usage",
        { inputTokens: 1110, cachedInputTokens: 1000, outputTokens: 50, totalTokens: 1160 },
      ],
      ["run.completed", { summary: "Changed src/a.ts" }],
    ]);
    expect(cli.ended).toBe(true);
  });
  it("leaves the Supervisor's reply unredacted (the Node redacts it) and bounded", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input({ role: "supervisor" }));
    const reply = JSON.stringify({ tasks: [{ key: "a".repeat(40) }] }) + "x".repeat(9000);
    current().result("success", reply);
    const events = await all(runtime, id);
    const done = events.at(-1);
    expect(done?.type).toBe("run.completed");
    if (done?.type === "run.completed") {
      expect(
        done.payload.summary?.startsWith(JSON.stringify({ tasks: [{ key: "a".repeat(40) }] })),
      ).toBe(true);
      expect(done.payload.summary?.length).toBeLessThanOrEqual(8000);
    }
  });
  it("reports a failed turn with the CLI's reason and no usage it did not report", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().result("error_during_execution", "Not logged in · Please run /login", null);
    const events = await all(runtime, id);
    expect(
      events.some((event) => event.type === "run.usage" && "inputTokens" in event.payload),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        code: "CLAUDE_TURN_FAILED",
        message: "Claude turn failed: Not logged in · Please run /login",
      },
    });
  });
  it("steers the running turn with a user message and refuses messages after it ended", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    await runtime.send({ nativeSessionId: id, message: "Also update the README" });
    expect(current().written.at(-1)).toMatchObject({
      type: "user",
      message: { content: "Also update the README" },
    });
    current().result();
    await all(runtime, id);
    await expect(runtime.send({ nativeSessionId: id, message: "late" })).rejects.toThrow(
      "RUNTIME_TERMINAL",
    );
  });
  it("marks the session uncertain when the CLI exits mid-turn", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().kill();
    await expect(runtime.inspect(id)).rejects.toThrow("RECONCILIATION_REQUIRED");
  });
});

describe("ClaudeRuntime approvals", () => {
  it("holds a permission request and answers with exactly the requested input", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().ask(
      "p1",
      "Bash",
      { command: "curl -s https://example.com" },
      { decision_reason: "Network" },
    );
    const [requested] = (await until(runtime, id, "approval.requested")).slice(-1);
    expect(requested).toMatchObject({
      type: "approval.requested",
      payload: {
        approvalId: "run:p1",
        kind: "command",
        risk: "high",
        summary: "Run: curl -s https://example.com\nReason: Network",
      },
    });
    expect(current().answers.has("p1")).toBe(false);
    await runtime.resolveApproval({
      nativeSessionId: id,
      approvalId: "run:p1",
      decision: "approve",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current().written.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "p1",
        response: { behavior: "allow", updatedInput: { command: "curl -s https://example.com" } },
      },
    });
  });
  it("describes file changes and network access, outside the workspace as critical", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().ask("w1", "Write", { file_path: "/tmp/outside.txt", content: "x" });
    current().ask("w2", "Edit", { file_path: `${CWD}/a.ts` });
    current().ask("n1", "SandboxNetworkAccess", { host: "registry.npmjs.org" });
    const events = (await until(runtime, id, "approval.requested", 3)).filter(
      (event) => event.type === "approval.requested",
    );
    expect(events.map((event) => event.payload)).toEqual([
      {
        approvalId: "run:w1",
        kind: "fileChange",
        risk: "critical",
        summary: "Change files: /tmp/outside.txt\nOutside the workspace",
      },
      { approvalId: "run:w2", kind: "fileChange", risk: "medium", summary: "Change files: a.ts" },
      {
        approvalId: "run:n1",
        kind: "command",
        risk: "high",
        summary: "Network access to registry.npmjs.org",
      },
    ]);
    await runtime.resolveApproval({
      nativeSessionId: id,
      approvalId: "run:w1",
      decision: "reject",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current().answers.get("w1")).toMatchObject({ behavior: "deny" });
  });
  it("records a request the CLI withdrew without answering it", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().ask("p1", "Bash", { command: "make" });
    await until(runtime, id, "approval.requested");
    current().emit({ type: "control_cancel_request", request_id: "p1" });
    const events = await until(runtime, id, "approval.resolved");
    expect(events.at(-1)?.payload).toEqual({
      approvalId: "run:p1",
      decision: "rejected",
      reason: "withdrawn",
    });
    expect(current().answers.has("p1")).toBe(false);
    await expect(
      runtime.resolveApproval({ nativeSessionId: id, approvalId: "run:p1", decision: "approve" }),
    ).rejects.toThrow("APPROVAL_NOT_PENDING");
  });
  it("rejects a request nobody answered in time", async () => {
    const { runtime, current } = harness({}, { approvalTimeoutMs: 5 });
    const { nativeSessionId: id } = await runtime.start(input());
    current().ask("p1", "Bash", { command: "make" });
    const events = await until(runtime, id, "approval.resolved");
    expect(events.at(-1)?.payload).toEqual({
      approvalId: "run:p1",
      decision: "rejected",
      reason: "timeout",
    });
    expect(current().answers.get("p1")).toMatchObject({ behavior: "deny" });
  });
  it("refuses control requests other than permission prompts", async () => {
    const { runtime, current } = harness();
    await runtime.start(input());
    current().emit({
      type: "control_request",
      request_id: "h1",
      request: { subtype: "hook_callback" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current().written.at(-1)).toMatchObject({
      type: "control_response",
      response: { subtype: "error", request_id: "h1" },
    });
  });
});

describe("ClaudeRuntime stop", () => {
  it("interrupts the turn and reports it stopped", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    await runtime.stop({ nativeSessionId: id });
    expect(
      current().written.some(
        (frame) => (frame.request as Record<string, unknown> | undefined)?.subtype === "interrupt",
      ),
    ).toBe(true);
    expect((await runtime.inspect(id)).state).toBe("stopped");
    await runtime.stop({ nativeSessionId: id });
  });
  it("reports an unconfirmed stop as uncertain", async () => {
    const { runtime, current } = harness();
    const { nativeSessionId: id } = await runtime.start(input());
    current().write = () => {};
    await expect(runtime.stop({ nativeSessionId: id })).rejects.toThrow("CLAUDE_STOP_UNCONFIRMED");
    await expect(runtime.inspect(id)).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(current().closed).toBe(true);
  });
});

describe("ClaudeRuntime resume", () => {
  it("continues with --resume in the same workspace and adds the new turn's usage", async () => {
    const native = new FakeNative();
    const before = harness({}, {}, native);
    const { nativeSessionId: id } = await before.runtime.start(input());
    const after = harness({ complete: true }, {}, native);
    await after.runtime.resume({
      ...input(),
      nativeSessionId: id,
      afterSequence: 7,
      interrupted: "continue",
      usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 2, totalTokens: 7 },
    });
    const args = after.current().launch.args;
    expect(args[args.indexOf("--resume") + 1]).toBe(id);
    expect(args).not.toContain("--session-id");
    expect(after.current().written[1]).toMatchObject({
      message: { content: RESTART_CONTINUATION },
    });
    const events = await all(after.runtime, id);
    expect(events[0]).toMatchObject({ sequence: 8, type: "run.activity" });
    expect(
      events.find((event) => event.type === "run.usage" && "inputTokens" in event.payload)?.payload,
    ).toEqual({
      inputTokens: 1115,
      cachedInputTokens: 1001,
      outputTokens: 52,
      totalTokens: 1167,
    });
    expect(events.at(-1)?.type).toBe("run.completed");
  });
  it("never resumes a session a CLI process may still be running", async () => {
    const native = new FakeNative();
    const before = harness({}, {}, native);
    const { nativeSessionId: id } = await before.runtime.start(input());
    const after = harness({}, { sessionRunning: (session) => session === id }, native);
    await expect(
      after.runtime.resume({ ...input(), nativeSessionId: id, interrupted: "continue" }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(after.launches).toHaveLength(0);
  });
});
