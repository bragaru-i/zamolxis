import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    first.appendEvent({ eventId: "evt-1", type: "run.started", payload: { runId: "run-1" }, createdAt: 1 });
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
    const first = store.recordCommand({ commandId: "cmd-1", idempotencyKey: "start:run-1", type: "runtime.start", payload: { runId: "run-1" } });
    const duplicate = store.recordCommand({ commandId: "cmd-2", idempotencyKey: "start:run-1", type: "runtime.start", payload: { runId: "run-1" } });
    expect(duplicate.commandId).toBe(first.commandId);
    store.close();
  });

  it("keeps dirty workspace metadata across restart", () => {
    const path = databasePath();
    const first = new LocalStateStore(path);
    first.upsertWorkspace({ workspaceId: "ws-1", repositoryId: "repo-1", path: "/tmp/repo", branch: "task-1", headSha: "abc", dirty: true, status: "in_use" });
    first.close();

    const second = new LocalStateStore(path);
    expect(second.getWorkspace("ws-1")).toMatchObject({ workspaceId: "ws-1", dirty: true, headSha: "abc" });
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
