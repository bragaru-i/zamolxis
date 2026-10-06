import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "./local-state";

const dirs: string[] = [];
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zamolxis-node-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LocalStateStore", () => {
  it("keeps unsent events across restart", () => {
    const path = databasePath();
    const first = new LocalStateStore(path);
    first.appendEvent({
      eventId: "evt-1",
      type: "run.started",
      payload: { runId: "run-1" },
      createdAt: 1,
    });
    first.close();

    const second = new LocalStateStore(path);
    expect(second.listPendingEvents()).toEqual([
      { eventId: "evt-1", type: "run.started", payload: { runId: "run-1" }, createdAt: 1 },
    ]);
    second.acknowledgeEvent("evt-1");
    expect(second.listPendingEvents()).toEqual([]);
    second.close();
  });

  it("deduplicates command delivery by idempotency key", () => {
    const store = new LocalStateStore(databasePath());
    const first = store.recordCommand({
      commandId: "cmd-1",
      idempotencyKey: "start:run-1",
      type: "runtime.start",
      payload: { runId: "run-1" },
    });
    const duplicate = store.recordCommand({
      commandId: "cmd-2",
      idempotencyKey: "start:run-1",
      type: "runtime.start",
      payload: { runId: "run-1" },
    });
    expect(duplicate.commandId).toBe(first.commandId);
    store.close();
  });

  it("keeps dirty workspace metadata across restart", () => {
    const path = databasePath();
    const first = new LocalStateStore(path);
    first.upsertWorkspace({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      path: "/tmp/repo",
      branch: "task-1",
      headSha: "abc",
      dirty: true,
      status: "in_use",
    });
    first.close();

    const second = new LocalStateStore(path);
    expect(second.getWorkspace("ws-1")).toMatchObject({
      workspaceId: "ws-1",
      dirty: true,
      headSha: "abc",
    });
    second.close();
  });

  it("persists node identity but rotates process instance identity", () => {
    const path = databasePath();
    const first = new LocalStateStore(path);
    const identityA = first.getOrCreateIdentity();
    first.close();

    const second = new LocalStateStore(path);
    const identityB = second.getOrCreateIdentity();
    expect(identityB.nodeId).toBe(identityA.nodeId);
    expect(identityB.instanceId).not.toBe(identityA.instanceId);
    second.close();
  });
});

describe("migration recovery", () => {
  it("reopens the same version without losing acknowledged events or commands", () => {
    const path = databasePath();
    const first = new LocalStateStore(path);
    first.recordCommand({ commandId: "cmd", idempotencyKey: "once", type: "start", payload: {} });
    first.appendEvent({ eventId: "event", type: "ready", payload: {}, createdAt: 1 });
    first.acknowledgeEvent("event");
    first.close();
    for (let i = 0; i < 3; i++) {
      const reopened = new LocalStateStore(path);
      expect(reopened.findCommandByIdempotencyKey("once")?.commandId).toBe("cmd");
      expect(reopened.listPendingEvents()).toEqual([]);
      reopened.close();
    }
  });
});

it("rejects changed command content and rolls back completion if outbox persistence fails", () => {
  const store = new LocalStateStore(databasePath());
  const command = {
    commandId: "cmd",
    idempotencyKey: "key",
    type: "runtime.start",
    payload: { runId: "run" },
  };
  store.recordCommand(command);
  expect(() => store.recordCommand({ ...command, payload: { runId: "other" } })).toThrow(
    "CONFLICT",
  );
  store.markCommandRunning("cmd");
  expect(() =>
    store.completeCommandWithEvents("cmd", [
      { eventId: "invalid", type: "delivery", createdAt: 1, payload: BigInt(1) },
    ]),
  ).toThrow();
  expect(store.findCommandByIdempotencyKey("key")?.status).toBe("running");
  expect(store.listPendingEvents()).toEqual([]);
  store.close();
});
it("remembers unfinished runs, recovery attempts and recorded run events across restart", () => {
  const path = databasePath();
  const first = new LocalStateStore(path);
  for (const [runId, status] of [
    ["run-a", "running"],
    ["run-b", "waiting"],
    ["run-c", "completed"],
    ["supervisor:text", "running"],
  ] as const)
    first.upsertRuntimeSession({ runId, runtime: "fake", workspaceId: "w", status });
  const event = (sequence: number, type: string, payload: Record<string, unknown> = {}) => ({
    eventId: `e${sequence}`,
    sequence,
    type,
    payload,
  });
  const runEvents = (eventId: string, runId: string, events: unknown[], createdAt: number) =>
    first.appendEvent({
      eventId,
      type: "control-plane.delivery",
      payload: { kind: "run.events", runId, events },
      createdAt,
    });
  runEvents("stream:1", "run-a", [event(1, "run.started"), event(2, "approval.requested")], 1);
  first.acknowledgeEvent("stream:1");
  // Overlapping batches are merged by sequence.
  runEvents("delivery:1", "run-a", [event(2, "approval.requested"), event(3, "run.activity")], 2);
  runEvents("delivery:2", "run-b", [event(1, "run.started")], 3);
  expect(first.recordRecovery("run-a")).toBe(1);
  first.close();

  const second = new LocalStateStore(path);
  expect(
    second
      .listUnfinishedRuntimeSessions()
      .map((session) => session.runId)
      .sort(),
  ).toEqual(["run-a", "run-b"]);
  expect(second.recordRecovery("run-a")).toBe(2);
  expect(() => second.recordRecovery("unknown")).toThrow("RECONCILIATION_REQUIRED");
  expect(second.listRecordedRunEvents("run-a")).toEqual([
    { sequence: 1, type: "run.started", payload: {} },
    { sequence: 2, type: "approval.requested", payload: {} },
    { sequence: 3, type: "run.activity", payload: {} },
  ]);
  expect(second.listRecordedRunEvents("run-c")).toEqual([]);
  second.close();
});
