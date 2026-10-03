import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import { git } from "@zamolxis/git";
import { FakeRuntime, RuntimeRegistry } from "@zamolxis/runtime-core";
import { afterEach, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "../workspace/workspace-manager";
import { RuntimeManager } from "./runtime-manager";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const f = repositoryFixture();
  cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));
  const store = new LocalStateStore(":memory:");
  cleanup.push(() => store.close());
  const repositories = new RepositoryRegistry(store, () => true);
  repositories.register({
    repositoryLocationId: "location",
    repositoryId: "repo",
    workstationId: "node",
    path: f.path,
    expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
  });
  const workspaces = new WorkspaceManager(
    store,
    repositories,
    join(f.root, "workspaces"),
    "instance",
    () => true,
  );
  const workspace = workspaces.provision({
    workspaceId: "workspace",
    repositoryLocationId: "location",
    baseRef: "main",
  });
  const runtime = new FakeRuntime();
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const manager = new RuntimeManager(
    store,
    workspaces,
    runtimes,
    "node" as WorkstationId,
    () => true,
  );
  const input = {
    runId: "run" as AgentRunId,
    workspaceId: "workspace" as WorkspaceId,
    runtime: "fake",
    instruction: "Test",
  };
  return { ...f, store, workspaces, workspace, runtime, manager, input };
}
it("assigns only the validated isolated workspace and does not execute a duplicate Run", async () => {
  const f = fixture();
  const a = await f.manager.start(f.input);
  const b = await f.manager.start(f.input);
  expect(a.nativeSessionId).toBe(b.nativeSessionId);
  await expect(f.manager.start({ ...f.input, instruction: "Different task" })).rejects.toThrow(
    "CONFLICT",
  );
  expect(a.workspace.cwd).toBe(f.workspace.path);
  expect(a.workspace.cwd).not.toBe(f.path);
  expect(f.store.getRuntimeSession("run")?.status).toBe("completed");
  expect(f.store.getWorkspaceLease("workspace")).toBeUndefined();
});
it("rejects a changed worktree branch before invoking the runtime", async () => {
  const f = fixture();
  git(f.workspace.path, ["checkout", "-b", "wrong"]);
  await expect(f.manager.start(f.input)).rejects.toThrow("IDENTITY");
  expect(f.store.getRuntimeSession("run")).toBeUndefined();
});
it("preserves an ambiguous persisted start instead of launching it again", async () => {
  const f = fixture();
  f.store.reserveRuntimeSession({
    runId: "run",
    workspaceId: "workspace",
    runtime: "fake",
    status: "starting",
  });
  await expect(f.manager.start(f.input)).rejects.toThrow("RECONCILIATION_REQUIRED");
  await expect(f.runtime.inspect("fake:run")).rejects.toThrow("NOT_FOUND");
});
