import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRunEventDto } from "@zamolxis/contracts";
import { git } from "@zamolxis/git";
import {
  FakeNativeStore,
  FakeRuntime,
  type FakeStep,
  RuntimeRegistry,
} from "@zamolxis/runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { RuntimeManager } from "../runtime/runtime-manager";
import { repositoryFixture } from "../testing/git-fixture";
import { WorkspaceManager } from "../workspace/workspace-manager";
import {
  ControlPlaneDriver,
  type ControlPlaneTransport,
  type Delivery,
  type ExecutionCommand,
} from "./driver";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const approval: FakeStep = {
  type: "approval",
  kind: "command",
  summary: "pnpm install",
  risk: "high",
};
const start = (runId: string): Extract<ExecutionCommand, { type: "runtime.start" }> => ({
  commandId: `cmd-${runId}`,
  idempotencyKey: `start:${runId}`,
  workstationId: "node",
  type: "runtime.start",
  payload: { runId, workspaceId: "build", runtime: "fake", role: "builder", instruction: "Build" },
});
const approve = (runId: string, approvalId: string, id = "1"): ExecutionCommand => ({
  commandId: `approval-${id}`,
  idempotencyKey: `approval:${runId}:${id}`,
  workstationId: "node",
  type: "runtime.approval",
  payload: { runId, approvalId, decision: "approve" },
});

/**
 * One repository and one durable Node state file, booted as successive Node processes:
 * each boot has a new instance id, a new runtime process (sharing only the native store,
 * like Codex rollouts under CODEX_HOME) and a new driver.
 */
function machine(scenario: readonly FakeStep[]) {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  writeFileSync(join(repo.path, "package.json"), JSON.stringify({ scripts: {} }));
  git(repo.path, ["add", "."]);
  git(repo.path, ["commit", "-m", "scripts"]);
  const native = new FakeNativeStore();
  const statePath = join(repo.root, "node-state.sqlite");
  const deliveries: Delivery[] = [];
  const reconciles: Array<[string, string | undefined, string | undefined]> = [];
  // The control plane's view: pending commands and run status.
  const cloud = { pending: [] as ExecutionCommand[], status: "running" };
  let boots = 0;
  const boot = (
    options: { native?: FakeNativeStore; failDelivery?: (d: Delivery) => boolean } = {},
  ) => {
    const instance = `instance-${++boots}`;
    const store = new LocalStateStore(statePath);
    cleanup.push(() => {
      try {
        store.close();
      } catch {
        /* Closed by the test (the process ended). */
      }
    });
    const repositories = new RepositoryRegistry(store, () => true);
    repositories.register({
      repositoryLocationId: "location",
      repositoryId: "repo",
      workstationId: "node",
      path: repo.path,
      expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
    });
    const workspaces = new WorkspaceManager(
      store,
      repositories,
      join(repo.root, "workspaces"),
      instance,
      () => true,
    );
    const runtime = new FakeRuntime(scenario, () => 0, options.native ?? native);
    let starts = 0;
    const originalStart = runtime.start.bind(runtime);
    runtime.start = async (input) => {
      starts++;
      return originalStart(input);
    };
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    const manager = new RuntimeManager(store, workspaces, runtimes, "node" as never, () => true);
    const transport: ControlPlaneTransport = {
      listPending: async () => cloud.pending,
      claim: async () => {},
      acknowledge: async () => {},
      reconcile: async (runId, observation, reason) => {
        reconciles.push([runId, observation, reason]);
        if (observation === "missing") cloud.status = "lost";
        return { status: cloud.status };
      },
      deliver: async (delivery) => {
        if (options.failDelivery?.(delivery)) throw new Error("NODE_DIED");
        deliveries.push(delivery);
        if (delivery.kind === "command.complete" || delivery.kind === "command.failed")
          cloud.pending = cloud.pending.filter((c) => c.commandId !== delivery.commandId);
      },
    };
    const driver = new ControlPlaneDriver(store, workspaces, runtimes, manager, transport, "node");
    return { instance, store, workspaces, runtime, driver, starts: () => starts };
  };
  const events = (runId: string) =>
    deliveries.flatMap((delivery) =>
      delivery.kind === "run.events" && delivery.runId === runId ? delivery.events : [],
    );
  return { repo, native, boot, deliveries, reconciles, cloud, events };
}
const summary = (events: readonly NormalizedRunEventDto[]) =>
  events.map((event) => [event.sequence, event.type]);
function expectContiguous(events: readonly NormalizedRunEventDto[]) {
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
}

describe("runs survive a Node restart", { timeout: 30_000 }, () => {
  it("withdraws an approval pending at the restart, asks again and completes once approved", async () => {
    const m = machine([
      { type: "activity", label: "Working" },
      approval,
      { type: "success", summary: "Built" },
    ]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-a")];
    await first.driver.tick();
    expect(m.cloud.status).toBe("running");
    const before = m.events("run-a");
    expect(summary(before)).toEqual([
      [1, "run.started"],
      [2, "run.activity"],
      [3, "approval.requested"],
    ]);
    m.cloud.status = "needs_approval";
    const workspace = first.workspaces.inspect("build");
    writeFileSync(join(workspace.path, "feature.txt"), "partial work\n");
    first.store.close();

    // The Mac restarts: a new Node process, instance and runtime process.
    const second = m.boot();
    await second.driver.tick();
    await second.driver.idle();
    expect(m.reconciles).toEqual([["run-a", "resuming", undefined]]);
    expect(second.store.getWorkspaceLease("build")).toMatchObject({
      runId: "run-a",
      nodeInstanceId: second.instance,
    });
    const resumed = m.events("run-a").slice(3);
    expect(resumed.map((event) => [event.sequence, event.type, event.payload])).toEqual([
      [
        4,
        "approval.resolved",
        { approvalId: "run-a:fake-1", decision: "rejected", reason: "withdrawn" },
      ],
      [5, "run.activity", { label: "Continuing after a restart" }],
      [
        6,
        "approval.requested",
        { approvalId: "run-a:fake-1-r1", kind: "command", summary: "pnpm install", risk: "high" },
      ],
    ]);
    // A trace step records the recovery.
    const trace = m.deliveries.flatMap((d) => (d.kind === "run.trace" ? d.steps : []));
    expect(trace.find((step) => step.stepId === "run:run-a:recovery:1")).toMatchObject({
      label: "Resumed after a Node restart",
      status: "passed",
    });

    // The owner approves the new request: the run completes with one candidate commit.
    m.cloud.pending = [approve("run-a", "run-a:fake-1-r1")];
    await second.driver.control();
    await second.driver.idle();
    const all = m.events("run-a");
    expectContiguous(all);
    expect(all.at(-1)?.type).toBe("run.completed");
    const complete = m.deliveries.filter((d) => d.kind === "run.complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ runId: "run-a", summary: "Built", dirty: false });
    const head = second.workspaces.inspect("build").headSha;
    expect(git(workspace.path, ["log", "--format=%s", `${workspace.baseSha}..${head}`])).toBe(
      "Zamolxis candidate",
    );
    expect(second.store.getWorkspaceLease("build")).toBeUndefined();
    expect(second.starts()).toBe(0);
    expect(second.store.listPendingEvents()).toEqual([]);
  });

  it("reattaches a waiting run, which a message then continues to completion", async () => {
    const m = machine([
      { type: "waiting", reason: "Need input" },
      { type: "success", summary: "Done" },
    ]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-w")];
    await first.driver.tick();
    expect(summary(m.events("run-w"))).toEqual([
      [1, "run.started"],
      [2, "run.waiting"],
    ]);
    first.store.close();

    const second = m.boot();
    m.cloud.status = "waiting";
    await second.driver.tick();
    await second.driver.idle();
    // Nothing new happened while the Node was down: no events, the run still waits.
    expect(m.events("run-w")).toHaveLength(2);
    m.cloud.pending = [
      {
        commandId: "send-1",
        idempotencyKey: "send:run-w:1",
        workstationId: "node",
        type: "runtime.send",
        payload: { runId: "run-w", message: "Go on" },
      },
    ];
    await second.driver.control();
    await second.driver.idle();
    const all = m.events("run-w");
    expectContiguous(all);
    expect(summary(all).slice(2)).toEqual([
      [3, "run.activity"],
      [4, "run.completed"],
    ]);
    expect(m.deliveries.filter((d) => d.kind === "run.complete")).toHaveLength(1);
    expect(m.deliveries).toContainEqual({ kind: "command.complete", commandId: "send-1" });
  });

  it("continues a run whose start command the restart interrupted mid-stream", async () => {
    const m = machine([
      { type: "activity", label: "Working" },
      approval,
      { type: "success", summary: "Built" },
    ]);
    // The Node dies while it reports the approval: the start command never finishes.
    const first = m.boot({ failDelivery: (d) => d.kind === "run.events" });
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-s")];
    await expect(first.driver.tick()).rejects.toThrow("NODE_DIED");
    expect(first.store.listInterruptedCommands().map((c) => c.commandId)).toEqual(["cmd-run-s"]);
    first.store.close();

    const second = m.boot();
    await second.driver.tick();
    await second.driver.idle();
    // The recorded events are delivered first, then the resumed ones continue after them.
    const all = m.events("run-s");
    expectContiguous(all);
    expect(summary(all)).toEqual([
      [1, "run.started"],
      [2, "run.activity"],
      [3, "approval.requested"],
      [4, "approval.resolved"],
      [5, "run.activity"],
      [6, "approval.requested"],
    ]);
    // The interrupted start command completes with the run it now follows.
    expect(m.deliveries).toContainEqual({ kind: "command.complete", commandId: "cmd-run-s" });
    expect(second.store.listInterruptedCommands()).toEqual([]);
    expect(second.starts()).toBe(0);
  });

  it("completes a run whose outcome was recorded before the restart without resuming it", async () => {
    const m = machine([{ type: "success", summary: "Built" }]);
    // The Node dies after recording the outcome but before completing the run.
    const first = m.boot({ failDelivery: (d) => d.kind === "run.events" });
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    writeFileSync(join(first.workspaces.inspect("build").path, "feature.txt"), "done\n");
    first.store.recordCommand(start("run-t"));
    first.store.markCommandRunning("cmd-run-t");
    const workspace = first.workspaces.inspect("build");
    first.workspaces.acquire("build", "run-t", workspace.path, workspace.branch);
    first.store.upsertRuntimeSession({
      runId: "run-t",
      runtime: "fake",
      workspaceId: "build",
      nativeSessionId: "fake:run-t",
      status: "running",
      instructionDigest: "digest",
    });
    first.store.appendEvent({
      eventId: "stream:cmd-run-t:00000002",
      type: "control-plane.delivery",
      payload: {
        kind: "run.events",
        runId: "run-t",
        events: [
          {
            eventId: "fake:run-t:1",
            sequence: 1,
            type: "run.started",
            payload: {},
            runId: "run-t",
            workspaceId: "build",
            workstationId: "node",
            occurredAt: 0,
          },
          {
            eventId: "fake:run-t:2",
            sequence: 2,
            type: "run.completed",
            payload: { summary: "Built" },
            runId: "run-t",
            workspaceId: "build",
            workstationId: "node",
            occurredAt: 0,
          },
        ],
      },
      createdAt: 1,
    });
    first.store.close();

    // The native store never saw this run: resuming it would fail.
    const second = m.boot({ native: new FakeNativeStore() });
    await second.driver.tick();
    await second.driver.idle();
    expect(m.reconciles).toEqual([["run-t", "resuming", undefined]]);
    expect(m.deliveries.filter((d) => d.kind === "run.complete")).toEqual([
      expect.objectContaining({ runId: "run-t", summary: "Built", dirty: false }),
    ]);
    expect(m.deliveries).toContainEqual({ kind: "command.complete", commandId: "cmd-run-t" });
    expect(second.store.getWorkspaceLease("build")).toBeUndefined();
    expect(second.store.getRuntimeSession("run-t")?.status).toBe("completed");
  });

  it("reports a run lost, keeping its workspace, when its native session cannot be resumed", async () => {
    const m = machine([approval, { type: "success", summary: "Built" }]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-l")];
    await first.driver.tick();
    first.store.close();

    // The native state is gone (for example the runtime's history was deleted).
    const second = m.boot({ native: new FakeNativeStore() });
    await second.driver.tick();
    await second.driver.idle();
    expect(m.reconciles).toEqual([
      ["run-l", "resuming", undefined],
      ["run-l", "missing", "RUNTIME_SESSION_NOT_FOUND"],
    ]);
    expect(m.cloud.status).toBe("lost");
    // Conservative ownership: the run keeps its workspace (and capacity) until reconciled.
    expect(second.store.getWorkspaceLease("build")?.runId).toBe("run-l");
    expect(m.deliveries.filter((d) => d.kind === "run.complete")).toEqual([]);
    expect(second.starts()).toBe(0);
    // Later ticks neither retry nor block the queue.
    await second.driver.tick();
    expect(m.reconciles).toHaveLength(2);
    const trace = m.deliveries.flatMap((d) => (d.kind === "run.trace" ? d.steps : []));
    expect(trace.find((step) => step.stepId === "run:run-l:recovery:1")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("RUNTIME_SESSION_NOT_FOUND"),
    });
  });

  it("stops a run whose stop was requested before the restart, then acknowledges the stop", async () => {
    const m = machine([approval, { type: "success", summary: "Built" }]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-x")];
    await first.driver.tick();
    first.store.close();

    const second = m.boot();
    m.cloud.status = "stopping";
    m.cloud.pending = [
      {
        commandId: "stop-x",
        idempotencyKey: "stop:run-x",
        workstationId: "node",
        type: "runtime.stop",
        payload: { runId: "run-x" },
      },
    ];
    await second.driver.tick();
    await second.driver.idle();
    const all = m.events("run-x");
    expectContiguous(all);
    expect(all.slice(-2).map((event) => [event.type, event.payload])).toEqual([
      [
        "approval.resolved",
        { approvalId: "run-x:fake-0", decision: "rejected", reason: "withdrawn" },
      ],
      ["run.stopped", { reason: "Stopped during a restart" }],
    ]);
    const complete = m.deliveries.findIndex((d) => d.kind === "run.complete");
    const stopped = m.deliveries.findIndex(
      (d) => d.kind === "command.complete" && d.commandId === "stop-x",
    );
    expect(complete).toBeGreaterThanOrEqual(0);
    // The stop is acknowledged only after the run's outcome was recorded.
    expect(stopped).toBeGreaterThan(complete);
    expect(second.store.getWorkspaceLease("build")).toBeUndefined();
  });

  it("fails an interrupted run once it was continued twice", async () => {
    const m = machine([approval, { type: "success", summary: "Built" }]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "build",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    m.cloud.pending = [start("run-f")];
    await first.driver.tick();
    first.store.close();
    for (let restart = 1; restart <= 3; restart++) {
      const node = m.boot();
      await node.driver.tick();
      await node.driver.idle();
      node.store.close();
    }
    const all = m.events("run-f");
    expectContiguous(all);
    expect(all.filter((event) => event.type === "approval.requested")).toHaveLength(3);
    expect(all.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { code: "NODE_RESTART_INTERRUPTED", message: "Interrupted by a Node restart" },
    });
    expect(m.deliveries.filter((d) => d.kind === "run.complete")).toHaveLength(1);
  });

  it("fails an interrupted Supervisor visibly and frees the planning workspace", async () => {
    const m = machine([{ type: "success", summary: "{}" }]);
    const first = m.boot();
    first.workspaces.provision({
      workspaceId: "plan",
      repositoryLocationId: "location",
      baseRef: "main",
    });
    const plan: ExecutionCommand = {
      commandId: "plan-1",
      idempotencyKey: "plan:text-1",
      workstationId: "node",
      type: "repository.plan",
      payload: { textCommandId: "text-1", workspaceId: "plan", text: "Do it" },
    };
    first.store.recordCommand(plan);
    first.store.markCommandRunning("plan-1");
    const workspace = first.workspaces.inspect("plan");
    first.workspaces.acquire("plan", "supervisor:text-1", workspace.path, workspace.branch);
    first.store.upsertRuntimeSession({
      runId: "supervisor:text-1",
      runtime: "fake",
      workspaceId: "plan",
      nativeSessionId: "fake:supervisor:text-1",
      status: "running",
    });
    first.store.close();

    const second = m.boot();
    await second.driver.tick();
    expect(m.deliveries).toContainEqual({
      kind: "command.failed",
      commandId: "plan-1",
      code: "SUPERVISOR_INTERRUPTED",
    });
    // The lease of the previous instance is released; the Supervisor is never resumed.
    expect(second.store.getWorkspaceLease("plan")).toBeUndefined();
    expect(m.reconciles).toEqual([]);
    expect(second.store.getRuntimeSession("supervisor:text-1")?.status).toBe("failed");
  });
});
