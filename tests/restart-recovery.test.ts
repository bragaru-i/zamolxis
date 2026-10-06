import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import { ConvexControlPlaneTransport } from "../apps/node/src/convex-control-plane";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { NormalizedRunEventDto } from "../packages/contracts/src";
import type { WorkstationId } from "../packages/contracts/src/shared/ids";
import { git } from "../packages/git/src/repository-inspector";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { AppServerClient } from "../packages/runtime-codex/src/app-server-client";
import { prepareCodexHome, releaseCodexHome } from "../packages/runtime-codex/src/codex-home";
import { CodexRuntime } from "../packages/runtime-codex/src/codex-runtime";
import type { AgentRuntime } from "../packages/runtime-core/src/agent-runtime";
import {
  FakeNativeStore,
  FakeRuntime,
  type FakeStep,
} from "../packages/runtime-core/src/fake/fake-runtime";
import { RuntimeRegistry } from "../packages/runtime-core/src/runtime-registry";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./approvals.ts": () => import("../convex/approvals"),
  "./trust.ts": () => import("../convex/trust"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./workstations.ts": () => import("../convex/workstations"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./runs.ts": () => import("../convex/runs"),
  "./events.ts": () => import("../convex/events"),
  "./node.ts": () => import("../convex/node"),
  "./traces.ts": () => import("../convex/traces"),
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// Like Codex: a subscription stays open until the run is terminal or waiting, so the start
// command is still in flight while an approval is pending.
class LiveRuntime extends FakeRuntime {
  #wake: Array<() => void> = [];
  #signal() {
    for (const wake of this.#wake.splice(0)) wake();
  }
  override async resolveApproval(input: {
    nativeSessionId: string;
    approvalId: string;
    decision: "approve" | "approve_session" | "reject";
  }) {
    await super.resolveApproval(input);
    this.#signal();
  }
  override async stop(input: { nativeSessionId: string }) {
    await super.stop(input);
    this.#signal();
  }
  override async *subscribe(input: { nativeSessionId: string; afterSequence?: number }) {
    let cursor = input.afterSequence ?? 0;
    for (;;) {
      let last: NormalizedRunEventDto | undefined;
      for await (const event of super.subscribe({ ...input, afterSequence: cursor })) {
        cursor = event.sequence;
        last = event;
        yield event;
      }
      const state = (await this.inspect(input.nativeSessionId)).state;
      if (["completed", "failed", "stopped"].includes(state) || last?.type === "run.waiting")
        return;
      await new Promise<void>((resolve) => this.#wake.push(resolve));
    }
  }
}
const scenario: FakeStep[] = [
  { type: "activity", label: "Editing" },
  { type: "approval", kind: "command", summary: "pnpm install", risk: "high" },
  { type: "success", summary: "Feature built" },
];

async function fixture(runtimeId = "fake", description = "Build a feature") {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const originalHead = git(repo.path, ["rev-parse", "HEAD"]);
  const originalStatus = git(repo.path, ["status", "--porcelain"]);
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  await user.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "computer",
    nodeAuthSubject: "device",
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  const repositoryId = await user.mutation(api.repositories.create, { name: "Repository" });
  const repositoryLocationId = await node.mutation(api.node.registerLocation, {
    workstationId,
    repositoryId,
    canonicalPath: repo.path,
    gitCommonDir: join(repo.path, ".git"),
    headSha: originalHead,
  });
  const workSessionId = await user.mutation(api.sessions.create, {
    title: "Restart",
    goal: "Survive a restart",
    repositoryIds: [repositoryId],
  });
  const taskId = await user.mutation(api.tasks.create, {
    workSessionId,
    title: "Task",
    description,
    kind: "implementation",
    priority: 1,
    runtimePolicy: { mode: "forced", runtime: runtimeId },
  });
  const native = new FakeNativeStore();
  const statePath = join(repo.root, "node-state.sqlite");
  /** One Node process: a new instance over the same durable state and native sessions. */
  const boot = async (options: { native?: FakeNativeStore; runtime?: AgentRuntime } = {}) => {
    const store = new LocalStateStore(statePath);
    cleanup.push(() => {
      try {
        store.close();
      } catch {
        /* Already closed: the process ended. */
      }
    });
    const identity = store.getOrCreateIdentity();
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: identity.instanceId,
      runtimeCapabilities: [
        { runtime: runtimeId, capabilities: ["start", "stop", "message", "approval"] },
      ],
    });
    const repositories = new RepositoryRegistry(store, () => true);
    repositories.register({
      repositoryLocationId,
      repositoryId,
      workstationId,
      path: repo.path,
      expectedIdentity: { remoteUrl: "https://example.invalid/team/repo" },
    });
    const workspaces = new WorkspaceManager(
      store,
      repositories,
      join(repo.root, "managed"),
      identity.instanceId,
      () => true,
    );
    const runtime = options.runtime ?? new LiveRuntime(scenario, () => 0, options.native ?? native);
    let starts = 0;
    const start = runtime.start.bind(runtime);
    runtime.start = async (input) => {
      starts++;
      return start(input);
    };
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      workstationId as unknown as WorkstationId,
      () => true,
    );
    const transport = new ConvexControlPlaneTransport(node, workstationId, identity.instanceId);
    const driver = new ControlPlaneDriver(
      store,
      workspaces,
      runtimes,
      manager,
      transport,
      workstationId,
    );
    return { store, identity, workspaces, driver, transport, runtime, starts: () => starts };
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; !(await check()) && attempt < 400; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await check()).toBe(true);
  };
  /** Starts a builder run and leaves it holding an approval, its start command in flight. */
  const interruptedRun = async () => {
    const first = await boot();
    const workspaceId = await user.mutation(api.workspaces.request, {
      taskId,
      repositoryLocationId,
      baseRef: "main",
    });
    await first.driver.tick();
    const runId = await user.mutation(api.runs.request, { taskId, workspaceId, runtime: "fake" });
    // The start command streams until the approval is answered; the process "dies" first.
    void first.driver.tick().catch(() => undefined);
    await until(
      async () => (await user.query(api.runs.get, { runId })).status === "needs_approval",
    );
    const path = first.workspaces.inspect(workspaceId).path;
    writeFileSync(join(path, "feature.txt"), "work in progress\n");
    first.store.close();
    return { workspaceId, runId, path };
  };
  const approvals = () => t.run((ctx) => ctx.db.query("approvals").collect());
  const commands = () => t.run((ctx) => ctx.db.query("commands").collect());
  const events = async (runId: string) => {
    const page = await user.query(api.events.listByRun, {
      runId: runId as never,
      paginationOpts: { numItems: 100, cursor: null },
    });
    return [...page.page].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    ) as Array<{
      sequence: number;
      type: string;
      eventId: string;
      payload: Record<string, unknown>;
    }>;
  };
  const canonicalUnchanged = () => {
    expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(git(repo.path, ["status", "--porcelain"])).toBe(originalStatus);
  };
  return {
    repo,
    repositoryLocationId,
    t,
    user,
    node,
    workstationId,
    workSessionId,
    taskId,
    boot,
    until,
    interruptedRun,
    approvals,
    commands,
    events,
    canonicalUnchanged,
  };
}

describe("Node restart recovery through Convex", { timeout: 60_000 }, () => {
  it("resumes a builder held for approval: the agent asks again and the run completes once", async () => {
    const f = await fixture();
    const { runId, path } = await f.interruptedRun();
    // A new Node process (new instance id) over the same state and native sessions.
    const second = await f.boot();
    await second.driver.tick();
    await f.until(async () =>
      (await f.approvals()).some(
        (approval) =>
          approval.status === "pending" && approval.runtimeApprovalId?.endsWith("-r1") === true,
      ),
    );
    const [old, fresh] = (await f.approvals()).sort((a, b) => a.requestedAt - b.requestedAt);
    // The approval pending at the restart was rejected (expired, withdrawn), never approved.
    expect(old).toMatchObject({
      status: "expired",
      runtimeOutcome: { decision: "rejected", reason: "withdrawn" },
    });
    expect((await f.user.query(api.runs.get, { runId: runId as never })).status).toBe(
      "needs_approval",
    );
    if (!fresh) throw new Error("missing approval");
    await f.user.mutation(api.approvals.resolve, { approvalId: fresh._id, decision: "approved" });
    await second.driver.control();
    await second.driver.idle();
    const run = await f.user.query(api.runs.get, { runId: runId as never });
    expect(run).toMatchObject({ status: "completed", resultSummary: "Feature built" });
    expect(run.completedAt).toBeDefined();
    const all = await f.events(runId);
    expect(all.map((event) => event.sequence)).toEqual(all.map((_, index) => index + 1));
    expect(new Set(all.map((event) => event.eventId)).size).toBe(all.length);
    expect(all.map((event) => event.type)).toEqual([
      "run.started",
      "run.activity",
      "approval.requested",
      "approval.resolved",
      "run.activity",
      "approval.requested",
      "approval.resolved",
      "run.completed",
    ]);
    // One candidate commit containing the work done before and after the restart.
    const task = await f.t.run((ctx) => ctx.db.get(f.taskId));
    expect(task).toMatchObject({ candidateRunId: runId, phase: "waiting_for_verification" });
    expect(git(path, ["log", "--format=%s", "-1"])).toBe("Zamolxis candidate");
    expect(git(path, ["show", "--name-only", "--format=", "HEAD"])).toBe("feature.txt");
    // The interrupted start command completed with the run; nothing stays pending.
    const commands = await f.commands();
    expect(commands.find((command) => command.type === "runtime.start")?.status).toBe("completed");
    expect(commands.find((command) => command.type === "runtime.approval")?.status).toBe(
      "completed",
    );
    expect(second.store.listPendingEvents()).toEqual([]);
    expect(second.starts()).toBe(0);
    const trace = await f.t.run((ctx) => ctx.db.query("traceSteps").collect());
    expect(trace.some((step) => step.label === "Resumed after a Node restart")).toBe(true);
    f.canonicalUnchanged();
  });

  it("reports a run lost with its reason and keeps its workspace when it cannot be resumed", async () => {
    const f = await fixture();
    const { runId, workspaceId } = await f.interruptedRun();
    const second = await f.boot({ native: new FakeNativeStore() });
    await second.driver.tick();
    await second.driver.idle();
    const run = await f.user.query(api.runs.get, { runId: runId as never });
    expect(run.status).toBe("lost");
    expect(run.exitReason).toContain("RUNTIME_SESSION_NOT_FOUND");
    // Lost runs keep their workspace and capacity until reconciled; approvals are void.
    const workspace = await f.t.run((ctx) => ctx.db.get(workspaceId as never));
    expect(workspace).toMatchObject({ ownerRunId: runId });
    const session = await f.user.query(api.sessions.get, { workSessionId: f.workSessionId });
    expect(session.activeRunCount).toBe(1);
    expect((await f.approvals()).map((approval) => approval.status)).toEqual(["expired"]);
    expect(second.store.getWorkspaceLease(workspaceId)?.runId).toBe(runId);
    // The queue keeps working: a later tick neither retries nor throws.
    await second.driver.tick();
    expect(second.starts()).toBe(0);
    f.canonicalUnchanged();
  });

  it("lets the current Node instance fail a command an earlier instance claimed", async () => {
    const f = await fixture();
    const first = await f.boot();
    await f.user.mutation(api.workspaces.request, {
      taskId: f.taskId,
      repositoryLocationId: (await f.t.run((ctx) => ctx.db.query("repositoryLocations").first()))
        ?._id as never,
      baseRef: "main",
    });
    const [command] = await first.transport.listPending();
    if (!command) throw new Error("missing command");
    await first.transport.claim(command.commandId);
    await first.transport.acknowledge(command.commandId);
    first.store.close();
    const second = await f.boot();
    // The replaced instance can no longer report anything.
    await expect(
      f.node.mutation(api.node.failCommand, {
        workstationId: f.workstationId,
        commandId: command.commandId as never,
        instanceId: first.identity.instanceId,
        code: "WORKSPACE_INTERRUPTED",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await second.transport.deliver({
      kind: "command.failed",
      commandId: command.commandId,
      code: "WORKSPACE_INTERRUPTED",
    });
    const stored = (await f.commands()).find((item) => item._id === command.commandId);
    expect(stored).toMatchObject({ status: "failed", error: "WORKSPACE_INTERRUPTED" });
  });
});

// Opt-in: a real authenticated Codex builder is killed mid-command with its Node, then a new
// Node process resumes the thread from the persistent CODEX_HOME and completes the run.
it.skipIf(process.env.ZAMOLXIS_CODEX_RESTART_ACCEPTANCE !== "1")(
  "real Codex: a builder killed mid-turn by a Node restart is resumed and completes",
  async () => {
    const f = await fixture(
      "codex",
      "Run the shell command `sleep 15 && echo resumed > restart.txt` in the workspace (do not run anything else), then reply with exactly DONE.",
    );
    const profile = join(f.repo.root, "codex-home");
    prepareCodexHome(profile, {
      authSource: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
    });
    const children: ReturnType<typeof spawn>[] = [];
    cleanup.push(() => {
      for (const child of children) child.kill("SIGKILL");
      releaseCodexHome(profile);
    });
    // Each Node process launches its own app-servers over the same persistent CODEX_HOME.
    const codex = (owned: ReturnType<typeof spawn>[]) =>
      new CodexRuntime({
        connect: (cwd) =>
          new AppServerClient({
            cwd,
            launch: (executable, assignedCwd) => {
              const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
                cwd: assignedCwd,
                env: { ...process.env, CODEX_HOME: profile },
                shell: false,
                stdio: ["pipe", "pipe", "ignore"],
              });
              owned.push(child);
              children.push(child);
              return child;
            },
          }),
      });
    const firstChildren: ReturnType<typeof spawn>[] = [];
    const firstRuntime = codex(firstChildren);
    const first = await f.boot({ runtime: firstRuntime });
    const workspaceId = await f.user.mutation(api.workspaces.request, {
      taskId: f.taskId,
      repositoryLocationId: f.repositoryLocationId,
      baseRef: "main",
    });
    await first.driver.tick();
    const runId = await f.user.mutation(api.runs.request, {
      taskId: f.taskId,
      workspaceId,
      runtime: "codex",
    });
    const ticking = first.driver.tick().catch((error: unknown) => error);
    // Wait until the agent is running its command, then the Node dies with its app-server.
    let nativeSessionId: string | undefined;
    for (let attempt = 0; attempt < 600 && !nativeSessionId; attempt++) {
      nativeSessionId = first.store.getRuntimeSession(runId)?.nativeSessionId;
      if (!nativeSessionId) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!nativeSessionId) throw new Error("Codex did not start");
    let commandStarted = false;
    for await (const event of firstRuntime.subscribe({ nativeSessionId })) {
      if (event.type === "tool.started" && event.payload.tool === "command") {
        commandStarted = true;
        break;
      }
      if (["run.completed", "run.failed", "run.stopped"].includes(event.type)) break;
    }
    expect(commandStarted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const child of firstChildren) child.kill("SIGKILL");
    expect(await ticking).toBeInstanceOf(Error);
    first.store.close();

    const second = await f.boot({ runtime: codex([]) });
    await second.driver.tick();
    await second.driver.idle();
    const run = await f.user.query(api.runs.get, { runId: runId as never });
    const events = await f.events(runId);
    console.log(
      "REAL CODEX RESTART",
      JSON.stringify({
        status: run.status,
        resultSummary: run.resultSummary,
        events: events.map((event) => [
          event.sequence,
          event.type,
          event.payload.label ?? event.payload.summary ?? "",
        ]),
      }),
    );
    expect(run.status).toBe("completed");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.payload.label === "Continuing after a restart")).toBe(true);
    expect(second.starts()).toBe(0);
    const path = second.workspaces.inspect(workspaceId).path;
    console.log(
      "REAL CODEX RESTART candidate files",
      git(path, ["show", "--name-only", "--format=", "HEAD"]) || "(none)",
    );
    expect(second.store.listPendingEvents()).toEqual([]);
    f.canonicalUnchanged();
  },
  300_000,
);

it("lets the owner dismiss a lost run, releasing its workspace and capacity", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  const { runId, workspaceId } = await f.interruptedRun();
  const second = await f.boot({ native: new FakeNativeStore() });
  await second.driver.tick();
  await second.driver.idle();
  expect((await f.user.query(api.runs.get, { runId: runId as never })).status).toBe("lost");
  await f.user.mutation(api.runs.stop, { runId: runId as never });
  const run = await f.user.query(api.runs.get, { runId: runId as never });
  expect(run.status).toBe("stopped");
  expect(run.completedAt).toBeDefined();
  const workspace = await f.t.run((ctx) => ctx.db.get(workspaceId as never));
  expect(workspace).not.toMatchObject({ ownerRunId: runId });
  // A best-effort stop still reaches the Node in case the session is alive after all.
  expect((await f.commands()).some((command) => command.type === "runtime.stop")).toBe(true);
});
