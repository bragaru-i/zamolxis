import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "../runtime-registry";
import { FakeNativeStore, FakeRuntime } from "./fake-runtime";

const input = {
  runId: "run" as AgentRunId,
  workstationId: "node" as WorkstationId,
  instruction: "Task",
  workspace: {
    workspaceId: "workspace" as WorkspaceId,
    cwd: "/workspace",
    branch: "task",
    headSha: "abc",
  },
};

describe("deterministic fake runtime", () => {
  it("waits for a message and then emits activity and failure", async () => {
    const runtime = new FakeRuntime([
      { type: "waiting", reason: "Need input" },
      { type: "activity", label: "Continuing" },
      { type: "failure", message: "Simulated failure" },
    ]);
    const waiting = await runtime.start(input);
    expect(waiting.state).toBe("waiting");
    await runtime.send({ nativeSessionId: waiting.nativeSessionId, message: "Continue" });
    expect((await runtime.inspect(waiting.nativeSessionId)).state).toBe("failed");
    const types = [];
    for await (const event of runtime.subscribe({ nativeSessionId: waiting.nativeSessionId }))
      types.push(event.type);
    expect(types).toEqual([
      "run.started",
      "run.waiting",
      "run.activity",
      "run.activity",
      "run.failed",
    ]);
    await expect(
      runtime.send({ nativeSessionId: waiting.nativeSessionId, message: "Again" }),
    ).rejects.toThrow("TERMINAL");
  });
  it("resumes within the same workspace and stops idempotently", async () => {
    const runtime = new FakeRuntime([
      { type: "waiting", reason: "First" },
      { type: "waiting", reason: "Second" },
    ]);
    const started = await runtime.start(input);
    await runtime.resume({ ...input, nativeSessionId: started.nativeSessionId });
    await runtime.stop({ nativeSessionId: started.nativeSessionId });
    const stopped = await runtime.inspect(started.nativeSessionId);
    await runtime.stop({ nativeSessionId: started.nativeSessionId });
    expect(await runtime.inspect(started.nativeSessionId)).toEqual(stopped);
    expect(stopped.state).toBe("stopped");
  });
  it("returns defensive snapshots and deterministic event timestamps", async () => {
    const runtime = new FakeRuntime(undefined, () => 42);
    const session = await runtime.start(input);
    Object.assign(session.workspace, { cwd: "/tampered" });
    expect((await runtime.inspect(session.nativeSessionId)).workspace.cwd).toBe("/workspace");
    for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId }))
      expect(event.occurredAt).toBe(42);
  });
});
it("selects eligible adapters without vendor branches and respects forced policy", () => {
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime());
  expect(
    registry.resolve({ mode: "preferred", runtime: "missing" }, ["canStart"], () => true).id,
  ).toBe("fake");
  expect(() =>
    registry.resolve({ mode: "forced", runtime: "missing" }, ["canStart"], () => true),
  ).toThrow("UNAVAILABLE");
  expect(() => registry.resolve({ mode: "auto" }, ["supportsSubagents"], () => true)).toThrow(
    "UNAVAILABLE",
  );
  expect(() => registry.resolve({ mode: "auto" }, ["canStart"], () => false)).toThrow(
    "UNAVAILABLE",
  );
  expect(() => registry.register(new FakeRuntime())).toThrow("ALREADY_REGISTERED");
  expect(registry.ids()).toEqual(["fake"]);
});
it("plays a per-run scenario and reports an arbitrary final summary", async () => {
  const runtime = new FakeRuntime((run) => [
    { type: "success", summary: run.role === "supervisor" ? '{"decision":"answer"}' : "Built" },
  ]);
  const supervisor = await runtime.start({
    ...input,
    runId: "s" as AgentRunId,
    role: "supervisor",
  });
  const builder = await runtime.start({ ...input, runId: "b" as AgentRunId, role: "builder" });
  const summaries: Array<string | undefined> = [];
  for (const session of [supervisor, builder])
    for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId }))
      if (event.type === "run.completed") summaries.push(event.payload.summary);
  expect(summaries).toEqual(['{"decision":"answer"}', "Built"]);
});
it("holds an approval step: messages do not settle it, rejection continues the scenario", async () => {
  const runtime = new FakeRuntime([
    { type: "approval", kind: "command", summary: "rm -rf build", risk: "high" },
    { type: "success", summary: "Continued without it" },
  ]);
  const session = await runtime.start(input);
  expect(session.state).toBe("running");
  await runtime.send({ nativeSessionId: session.nativeSessionId, message: "Hurry" });
  expect((await runtime.inspect(session.nativeSessionId)).state).toBe("running");
  await runtime.resolveApproval({
    nativeSessionId: session.nativeSessionId,
    approvalId: "run:fake-0",
    decision: "reject",
  });
  const events: unknown[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId }))
    events.push([event.type, event.payload]);
  expect(events).toEqual([
    ["run.started", { nativeSessionId: "fake:run" }],
    [
      "approval.requested",
      { approvalId: "run:fake-0", kind: "command", summary: "rm -rf build", risk: "high" },
    ],
    ["run.activity", { label: "Message received" }],
    ["approval.resolved", { approvalId: "run:fake-0", decision: "rejected", reason: "user" }],
    ["run.completed", { summary: "Continued without it" }],
  ]);
});
it("survives a restart only through a shared native store: waiting stays waiting", async () => {
  const native = new FakeNativeStore();
  const scenario = [
    { type: "waiting", reason: "Need input" },
    { type: "success", summary: "Finished" },
  ] as const;
  const first = new FakeRuntime(scenario, () => 0, native);
  const session = await first.start(input);
  // Without the native store a new process knows nothing about the session.
  await expect(
    new FakeRuntime(scenario).resume({ ...input, nativeSessionId: session.nativeSessionId }),
  ).rejects.toThrow("RUNTIME_SESSION_NOT_FOUND");
  const second = new FakeRuntime(scenario, () => 0, native);
  const waiting = await second.resume({
    ...input,
    nativeSessionId: session.nativeSessionId,
    afterSequence: 2,
    interrupted: "continue",
  });
  expect(waiting).toMatchObject({ state: "waiting", lastSequence: 2 });
  await second.send({ nativeSessionId: session.nativeSessionId, message: "Go" });
  const after: unknown[] = [];
  for await (const event of second.subscribe({ nativeSessionId: session.nativeSessionId }))
    after.push([event.sequence, event.type]);
  expect(after).toEqual([
    [3, "run.activity"],
    [4, "run.completed"],
  ]);
  // A terminal session resumed again reports its outcome once more after the cursor.
  const third = new FakeRuntime(scenario, () => 0, native);
  const done = await third.resume({
    ...input,
    nativeSessionId: session.nativeSessionId,
    afterSequence: 3,
  });
  expect(done).toMatchObject({ state: "completed", lastSequence: 4 });
  const replayed: unknown[] = [];
  for await (const event of third.subscribe({
    nativeSessionId: session.nativeSessionId,
    afterSequence: 3,
  }))
    replayed.push([event.eventId, event.type, event.payload]);
  expect(replayed).toEqual([["fake:run:4", "run.completed", { summary: "Finished" }]]);
});
