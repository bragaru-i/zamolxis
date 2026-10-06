import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, expect, it } from "vitest";
import {
  ConvexControlPlaneTransport,
  parseExecutionCommand,
  parsePendingCommand,
} from "../apps/node/src/convex-control-plane";
import { runFakeLoopOnce } from "../apps/node/src/fake-loop";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import type { NormalizedRunEventDto } from "../packages/contracts/src";
import type { WorkstationId } from "../packages/contracts/src/shared/ids";
import { git } from "../packages/git/src/repository-inspector";
import type { ControlPlaneTransport } from "../packages/node-core/src/control-plane/driver";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { ClaudeRuntime } from "../packages/runtime-claude/src/claude-runtime";
import { ClaudeCliProcess, claudeEnv } from "../packages/runtime-claude/src/cli-process";
import {
  AppServerClient,
  type AppServerNotification,
} from "../packages/runtime-codex/src/app-server-client";
import { type CodexConnection, CodexRuntime } from "../packages/runtime-codex/src/codex-runtime";
import type { AgentRuntime, StartRunInput } from "../packages/runtime-core/src/agent-runtime";
import { FakeRuntime } from "../packages/runtime-core/src/fake/fake-runtime";
import { RuntimeRegistry } from "../packages/runtime-core/src/runtime-registry";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./trust.ts": () => import("../convex/trust"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./orchestrator.ts": () => import("../convex/orchestrator"),
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
class CountingRuntime extends FakeRuntime {
  starts = 0;
  override async start(input: StartRunInput) {
    this.starts++;
    return super.start(input);
  }
}
async function fixture(runtimeId = "fake") {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const originalHead = git(repo.path, ["rev-parse", "HEAD"]);
  const originalStatus = git(repo.path, ["status", "--porcelain"]);
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  await user.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Test",
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
    title: "First loop",
    goal: "Execute fake",
    repositoryIds: [repositoryId],
  });
  const taskId = await user.mutation(api.tasks.create, {
    workSessionId,
    title: "Fake task",
    description: "Deterministic execution",
    kind: "implementation",
    priority: 1,
    runtimePolicy: { mode: "forced", runtime: runtimeId },
  });
  const runtime = new CountingRuntime();
  const boot = async (adapter: AgentRuntime = runtime, capabilities = ["start"]) => {
    const store = new LocalStateStore(join(repo.root, "state.sqlite"));
    cleanup.push(() => store.close());
    const identity = store.getOrCreateIdentity();
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: identity.instanceId,
      runtimeCapabilities: [{ runtime: adapter.id, capabilities }],
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
    const runtimes = new RuntimeRegistry();
    runtimes.register(adapter);
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      workstationId as unknown as WorkstationId,
      () => true,
    );
    const transport = new ConvexControlPlaneTransport(node, workstationId, identity.instanceId);
    const driver = (port: ControlPlaneTransport = transport) =>
      new ControlPlaneDriver(store, workspaces, runtimes, manager, port, workstationId);
    return { store, workspaces, runtimes, manager, transport, driver };
  };
  return {
    ...repo,
    t,
    user,
    node,
    workstationId,
    repositoryId,
    repositoryLocationId,
    workSessionId,
    taskId,
    runtime,
    boot,
    originalHead,
    originalStatus,
  };
}
it("executes Session→Task→real isolated worktree→Fake Runtime→Convex events and persisted snapshot", async () => {
  const f = await fixture();
  const node = await f.boot();
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await node.driver().tick();
  const workspace = node.workspaces.inspect(workspaceId);
  expect(workspace.path).not.toBe(f.path);
  expect(workspace.branch).toBe(`zam/${f.repositoryId}/${workspaceId}`);
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  await node.driver().tick();
  await node.driver().tick();
  expect(f.runtime.starts).toBe(1);
  const run = await f.user.query(api.runs.get, { runId });
  expect(run.status).toBe("completed");
  expect(run.finalHeadSha).toBe(f.originalHead);
  const session = await f.user.query(api.sessions.get, { workSessionId: f.workSessionId });
  expect(session.status).toBe("waiting");
  expect(session.activeRunCount).toBe(0);
  expect(session.completedTaskCount).toBe(0);
  const events = await f.user.query(api.events.listByRun, {
    runId,
    paginationOpts: { numItems: 100, cursor: null },
  });
  expect(events.page).toHaveLength(3);
  expect(node.store.listPendingEvents()).toEqual([]);
  expect(node.store.getWorkspaceLease(workspaceId)).toBeUndefined();
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
});
it("recovers persisted delivery after a lost event acknowledgement and a new Node instance without starting twice", async () => {
  const f = await fixture();
  const first = await f.boot();
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await first.driver().tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  let failed = false;
  const disconnected: ControlPlaneTransport = {
    listPending: () => first.transport.listPending(),
    claim: (id) => first.transport.claim(id),
    acknowledge: (id) => first.transport.acknowledge(id),
    reconcile: (id) => first.transport.reconcile(id),
    deliver: async (delivery) => {
      await first.transport.deliver(delivery);
      if (delivery.kind === "run.events" && !failed) {
        failed = true;
        throw new Error("ACK_LOST");
      }
    },
  };
  await expect(first.driver(disconnected).tick()).rejects.toThrow("ACK_LOST");
  expect(first.store.listPendingEvents()).toHaveLength(3);
  cleanup.pop()?.();
  const replacementRuntime = new CountingRuntime();
  const restarted = await f.boot(replacementRuntime);
  await restarted.driver().tick();
  expect(replacementRuntime.starts).toBe(0);
  expect(f.runtime.starts).toBe(1);
  expect(restarted.store.listPendingEvents()).toEqual([]);
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("completed");
  expect(
    (
      await f.user.query(api.events.listByRun, {
        runId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page,
  ).toHaveLength(3);
  expect(
    (await f.user.query(api.sessions.get, { workSessionId: f.workSessionId })).completedTaskCount,
  ).toBe(0);
});
it("preserves an interrupted launch for reconciliation instead of replaying it", async () => {
  const f = await fixture();
  const n = await f.boot();
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await n.driver().tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  const command = (await n.transport.listPending())[0];
  if (!command) throw new Error("Missing command");
  n.store.recordCommand(command);
  await n.transport.claim(command.commandId);
  await n.transport.acknowledge(command.commandId);
  n.store.markCommandRunning(command.commandId);
  cleanup.pop()?.();
  const restarted = await f.boot();
  const driver = restarted.driver();
  // The launch never recorded a native session: the run is reported lost (it keeps its
  // workspace and capacity) and the queue is not blocked.
  await driver.tick();
  await driver.idle();
  await driver.tick();
  expect(f.runtime.starts).toBe(0);
  const lost = await f.user.query(api.runs.get, { runId });
  expect(lost.status).toBe("lost");
  expect(lost.exitReason).toContain("RUNTIME_SESSION_UNKNOWN");
  expect(
    (await f.user.query(api.workspaces.listBySession, { workSessionId: f.workSessionId }))[0]
      ?.ownerRunId,
  ).toBe(runId);
});
it("rejects wrong targets and arbitrary cloud commands before any local operation", () => {
  expect(() =>
    parseExecutionCommand({
      _id: "command",
      workstationId: "node",
      idempotencyKey: "key",
      type: "shell.execute",
      payload: { cwd: "/canonical", command: "delete" },
    }),
  ).toThrow("UNSUPPORTED");
  expect(() =>
    parseExecutionCommand({
      _id: "command",
      workstationId: "node",
      idempotencyKey: "key",
      type: "runtime.start",
      targetType: "run",
      targetId: "other",
      payload: { runId: "run", workspaceId: "workspace", runtime: "fake", instruction: "Task" },
    }),
  ).toThrow("TARGET");
});

it("parses orchestrator.answer only for its own message with bounded conversation", () => {
  const base = {
    _id: "command",
    workstationId: "node",
    idempotencyKey: "orchestrator:message",
    type: "orchestrator.answer",
    targetType: "orchestratorMessage",
    targetId: "message",
  };
  const payload = {
    orchestratorMessageId: "message",
    text: "What is going on?",
    context: "Scope: all",
    conversation: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "supervisor" : "user",
      text: `m${index}`,
    })),
    orchestrator: { runtime: "codex", model: "gpt-x" },
  };
  const parsed = parseExecutionCommand({ ...base, payload });
  expect(parsed).toMatchObject({
    type: "orchestrator.answer",
    payload: {
      orchestratorMessageId: "message",
      orchestrator: { runtime: "codex", model: "gpt-x" },
    },
  });
  if (parsed.type !== "orchestrator.answer") throw new Error("Unexpected command");
  expect(parsed.payload.conversation).toHaveLength(20);
  expect(() => parseExecutionCommand({ ...base, targetId: "other", payload })).toThrow("TARGET");
  expect(() => parseExecutionCommand({ ...base, payload: { ...payload, context: "" } })).toThrow(
    "INVALID_COMMAND",
  );
});

it("fails unknown and unsupported commands individually and still stops a waiting run", async () => {
  const f = await fixture();
  const node = await f.boot(new FakeRuntime([{ type: "waiting", reason: "Needs input" }]));
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await node.driver().tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  await node.driver().tick();
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("waiting");
  const unknownId = await f.t.run((ctx) =>
    ctx.db.insert("commands", {
      workstationId: f.workstationId,
      type: "shell.execute",
      targetType: "workspace",
      targetId: workspaceId,
      idempotencyKey: "unknown:1",
      status: "pending",
      payload: { command: "rm -rf /" },
      createdAt: Date.now(),
    }),
  );
  // This Node does not advertise steering ("message"), so the backend refuses to queue it.
  await expect(
    f.user.mutation(api.runs.sendMessage, {
      runId,
      message: "Continue",
      idempotencyKey: "first",
    }),
  ).rejects.toThrow("RUNTIME_MESSAGE_UNSUPPORTED");
  await f.user.mutation(api.runs.stop, { runId });
  await node.driver().tick();
  const run = await f.user.query(api.runs.get, { runId });
  expect(run.status).toBe("stopped");
  expect(run.completedAt).toBeDefined();
  const commands = await f.t.run((ctx) => ctx.db.query("commands").collect());
  const byId = new Map(commands.map((command) => [String(command._id), command]));
  expect(byId.get(String(unknownId))).toMatchObject({
    status: "failed",
    error: "UNSUPPORTED_EXECUTION_COMMAND",
  });
  expect(commands.some((command) => command.type === "runtime.send")).toBe(false);
  expect(commands.find((command) => command.type === "runtime.stop")?.status).toBe("completed");
  expect(commands.filter((command) => command.status === "pending")).toEqual([]);
  expect(node.store.getWorkspaceLease(workspaceId)).toBeUndefined();
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
});
it("steers a waiting run from a fresh driver instance without replaying its earlier pause", async () => {
  const f = await fixture();
  const node = await f.boot(
    new FakeRuntime([
      { type: "waiting", reason: "Which file?" },
      { type: "success", summary: "Edited README" },
    ]),
    ["start", "stop", "message", "approval"],
  );
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await node.driver().tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  await node.driver().tick();
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("waiting");
  await f.user.mutation(api.runs.sendMessage, {
    runId,
    message: "README.md",
    idempotencyKey: "first",
  });
  await node.driver().tick();
  const run = await f.user.query(api.runs.get, { runId });
  expect(run.status).toBe("completed");
  expect(run.resultSummary).toBe("Edited README");
  const events = await f.user.query(api.events.listByRun, {
    runId,
    paginationOpts: { numItems: 100, cursor: null },
  });
  expect(
    [...events.page]
      .sort((a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence)
      .map((event: { type: string }) => event.type),
  ).toEqual(["run.started", "run.waiting", "run.activity", "run.completed"]);
  expect(node.store.getWorkspaceLease(workspaceId)).toBeUndefined();
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
});
it("delivers a stop to a run that is still streaming", async () => {
  class BlockingRuntime extends FakeRuntime {
    streaming = false;
    #release: () => void = () => {};
    readonly #stopped = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    override async *subscribe(input: {
      nativeSessionId: string;
      afterSequence?: number;
    }): AsyncIterable<NormalizedRunEventDto> {
      let cursor = input.afterSequence ?? 0;
      for await (const event of super.subscribe({ ...input, afterSequence: cursor })) {
        cursor = event.sequence;
        yield event;
      }
      this.streaming = true;
      await this.#stopped;
      yield* super.subscribe({ ...input, afterSequence: cursor });
    }
    override async stop(input: { nativeSessionId: string }) {
      await super.stop(input);
      this.#release();
    }
  }
  const f = await fixture();
  const runtime = new BlockingRuntime([{ type: "activity", label: "Working" }]);
  const node = await f.boot(runtime);
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  const driver = node.driver();
  await driver.tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "fake",
  });
  const ticking = driver.tick();
  for (let attempt = 0; !runtime.streaming && attempt < 200; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(runtime.streaming).toBe(true);
  await f.user.mutation(api.runs.stop, { runId });
  await driver.control();
  await ticking;
  const run = await f.user.query(api.runs.get, { runId });
  expect(run.status).toBe("stopped");
  expect(run.completedAt).toBeDefined();
  const commands = await f.t.run((ctx) => ctx.db.query("commands").collect());
  expect(commands.find((command) => command.type === "runtime.stop")?.status).toBe("completed");
  expect(node.store.getWorkspaceLease(workspaceId)).toBeUndefined();
});
it("turns an unparseable pending command into an individual failure", () => {
  expect(
    parsePendingCommand({
      _id: "command",
      workstationId: "node",
      idempotencyKey: "key",
      type: "shell.execute",
      payload: {},
    }),
  ).toMatchObject({ type: "invalid", payload: { code: "UNSUPPORTED_EXECUTION_COMMAND" } });
  expect(
    parsePendingCommand({
      _id: "command",
      workstationId: "node",
      idempotencyKey: "key",
      type: "runtime.stop",
      targetType: "run",
      targetId: "other",
      payload: { runId: "run" },
    }),
  ).toMatchObject({ type: "invalid", payload: { code: "INVALID_COMMAND_TARGET" } });
  expect(parsePendingCommand({ type: "runtime.stop" })).toBeUndefined();
});
it("rejects dangling state-file symlinks before opening the database or contacting Convex", async () => {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const managedRoot = join(repo.root, "managed");
  mkdirSync(managedRoot);
  const target = join(repo.root, "outside.sqlite");
  symlinkSync(target, join(managedRoot, "node-state.sqlite"));
  await expect(
    runFakeLoopOnce({
      deploymentUrl: "https://example.invalid",
      deviceToken: "unused",
      workstationId: "node",
      repositoryId: "repo",
      repositoryPath: repo.path,
      repositoryRemote: "https://example.invalid/team/repo",
      managedRoot,
    }),
  ).rejects.toThrow("UNSAFE_STATE_FILE");
  expect(existsSync(target)).toBe(false);
});

it("executes the Codex adapter through Node workspace assignment, Convex settlement and durable outbox", async () => {
  const f = await fixture("codex");
  let assignedCwd = "";
  let listener: ((event: AppServerNotification) => void) | undefined;
  const connection: CodexConnection = {
    initialize: async () => {},
    request: async (method, params) => {
      if (method === "thread/start") return { thread: { id: "codex-native", cwd: params.cwd } };
      if (method === "turn/start") {
        listener?.({
          method: "turn/started",
          params: { threadId: "codex-native", turn: { id: "native-turn" } },
        });
        setTimeout(
          () =>
            listener?.({
              method: "turn/completed",
              params: {
                threadId: "codex-native",
                turn: { id: "native-turn", status: "completed" },
              },
            }),
          20,
        );
        return { turn: { id: "native-turn", status: "inProgress" } };
      }
      throw new Error("UNEXPECTED_NATIVE_CALL");
    },
    onNotification: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    onClose: () => () => {},
    close: () => {},
  };
  const runtime = new CodexRuntime({
    connect: (cwd) => {
      assignedCwd = cwd;
      return connection;
    },
    now: () => 0,
  });
  const n = await f.boot(runtime);
  const workspaceId = await f.user.mutation(api.workspaces.request, {
    taskId: f.taskId,
    repositoryLocationId: f.repositoryLocationId,
    baseRef: "main",
  });
  await n.driver().tick();
  const runId = await f.user.mutation(api.runs.request, {
    taskId: f.taskId,
    workspaceId,
    runtime: "codex",
  });
  await n.driver().tick();
  expect(assignedCwd).toBe(n.workspaces.inspect(workspaceId).path);
  expect(assignedCwd).not.toBe(f.path);
  expect(n.store.getRuntimeSession(runId)?.nativeSessionId).toBe("codex-native");
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("completed");
  expect(
    (await f.user.query(api.sessions.get, { workSessionId: f.workSessionId })).completedTaskCount,
  ).toBe(0);
  expect(n.store.listPendingEvents()).toEqual([]);
  expect(n.store.getWorkspaceLease(workspaceId)).toBeUndefined();
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
});

it.skipIf(process.env.ZAMOLXIS_AUTHENTICATED_ACCEPTANCE !== "1")(
  "accepts real authenticated Mac Codex through Node, isolated Git worktree, durable outbox and Convex function settlement",
  async () => {
    const f = await fixture("codex");
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-authenticated-node-"));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      chmodSync(profile, 0o700);
      copyFileSync(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
        join(profile, "auth.json"),
      );
      chmodSync(join(profile, "auth.json"), 0o600);
      await f.t.run(async (ctx) => {
        await ctx.db.patch("tasks", f.taskId, {
          description: "Reply ALPHA_OK. Do not use tools, execute commands or modify files.",
        });
      });
      const runtime = new CodexRuntime({
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
              children.push(child);
              return child;
            },
          }),
      });
      const n = await f.boot(runtime);
      const workspaceId = await f.user.mutation(api.workspaces.request, {
        taskId: f.taskId,
        repositoryLocationId: f.repositoryLocationId,
        baseRef: "main",
      });
      await n.driver().tick();
      const runId = await f.user.mutation(api.runs.request, {
        taskId: f.taskId,
        workspaceId,
        runtime: "codex",
      });
      await n.driver().tick();
      const stored = n.store.getRuntimeSession(runId);
      expect(stored?.nativeSessionId).toBeTruthy();
      expect(stored?.status).toBe("completed");
      expect((await f.user.query(api.runs.get, { runId })).status).toBe("completed");
      expect(
        (await f.user.query(api.sessions.get, { workSessionId: f.workSessionId })).activeRunCount,
      ).toBe(0);
      expect(n.store.getWorkspaceLease(workspaceId)).toBeUndefined();
      expect(n.store.listPendingEvents()).toEqual([]);
      expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
      expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
      expect(n.workspaces.inspect(workspaceId).dirty).toBe(false);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 2000).unref();
          });
        }
      }
      rmSync(profile, { recursive: true, force: true });
    }
  },
  90_000,
);

it("runs text intent through discovery, native Builder, independent Verifier, deterministic trust and integration", async () => {
  const f = await fixture("codex");
  const profile = mkdtempSync(join(tmpdir(), "zamolxis-alpha-native-"));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  chmodSync(profile, 0o700);
  const authenticated = process.env.ZAMOLXIS_CODEX_ACCEPTANCE === "1";
  const nativeRepair = authenticated && process.env.ZAMOLXIS_CODEX_REPAIR_ACCEPTANCE === "1";
  const children: ReturnType<typeof spawn>[] = [];
  cleanup.push(() => {
    for (const child of children) child.kill();
  });
  if (authenticated) {
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(profile, "auth.json"),
    );
    chmodSync(join(profile, "auth.json"), 0o600);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(f.path, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('outcome.txt','utf8').trim(),'ALPHA_OK')\"",
      },
    }),
  );
  git(f.path, ["add", "."]);
  git(f.path, ["commit", "-m", "acceptance check"]);
  const canonicalSha = git(f.path, ["rev-parse", "HEAD"]);
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    const id = await ctx.db.insert("products", {
      ownerId: session!.ownerId,
      name: "Native",
      slug: "native",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId: id });
    await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
      lastKnownHead: canonicalSha,
    });
    return id;
  });
  let buildStarts = 0;
  const runtimeId = authenticated ? "codex" : "fake";
  if (!authenticated)
    for (const role of ["builder", "verifier", "repair"] as const)
      await f.user.mutation(api.agentProfiles.upsert, {
        name: role,
        role,
        runtime: runtimeId,
        enabled: true,
      });
  const runtime = authenticated
    ? new (class extends CodexRuntime {
        override async start(input: StartRunInput) {
          // Inject the initial fault at the fixture adapter boundary, not in
          // acceptance criteria. Repair/Verifier receive the original backend
          // context and the real failure evidence.
          return super.start(
            nativeRepair && input.role === "builder"
              ? {
                  ...input,
                  instruction:
                    "This is a deliberate failing-candidate acceptance fixture. Create outcome.txt containing exactly FAIL and a newline. Do not correct it to ALPHA_OK. Use the file editing tool; do not run Git commands, tests or network tools. Zamolxis will commit and independently verify the failing candidate.",
                }
              : input,
          );
        }
      })({
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
              children.push(child);
              return child;
            },
          }),
      })
    : new (class extends FakeRuntime {
        override async start(input: StartRunInput) {
          if (input.role === "builder" || input.role === "repair")
            writeFileSync(
              join(input.workspace.cwd, "outcome.txt"),
              ++buildStarts === 1 ? "FAIL\n" : "ALPHA_OK\n",
            );
          return super.start(input);
        }
      })((input) => [
        { type: "activity", label: "Fake runtime executing" },
        {
          type: "success",
          // The fixture Supervisor plans the prose request as one task.
          summary:
            input.role === "supervisor"
              ? JSON.stringify({
                  decision: "delegate",
                  reply: "One task: create outcome.txt.",
                  tasks: [
                    {
                      key: "outcome",
                      title: "Create outcome.txt",
                      description: input.instruction.includes("ALPHA_OK")
                        ? "Create outcome.txt containing exactly ALPHA_OK and a newline."
                        : "Missing request",
                      dependencies: [],
                      verificationScripts: ["test"],
                      requiredModalities: ["static", "test"],
                    },
                  ],
                })
              : `${input.role} finished: wrote outcome.txt`,
        },
      ]);
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: "Create outcome.txt containing exactly ALPHA_OK and a newline. Use the file editing tool. Do not run Git commands, tests or network tools. Zamolxis will commit your edits and run checks independently.",
    idempotencyKey: "native-alpha",
  });
  for (let tick = 0; tick < 20; tick++) {
    await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
    await driver.tick();
    const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
    if (["completed", "failed", "needs_input"].includes(session.status)) break;
  }
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("completed");
  const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    text: expect.stringContaining("ALPHA_OK"),
    planned: true,
    planTaskCount: 1,
    planStatus: "completed",
    repositoryId: f.repositoryId,
    decision: "delegate",
  });
  expect(messages[0]?.reply).toEqual(expect.any(String));
  const { user: other } = await seedHuman(f.t, "mallory");
  await expect(
    other.query(api.supervisor.messages, { workSessionId: sessionId }),
  ).rejects.toThrow();
  // The Supervisor's log for the message, readable by its owner only.
  const planLog = (await f.user.query(api.supervisor.log, {
    textCommandId: messages[0]?._id as never,
  })) as { kind: string; label: string }[];
  expect(planLog[0]?.kind).toBe("discovery");
  expect(planLog.at(-1)).toMatchObject({ kind: "supervisor", label: "Opened 1 task" });
  await expect(
    other.query(api.supervisor.log, { textCommandId: messages[0]?._id as never }),
  ).rejects.toThrow();
  const runs = await f.user.query(api.runs.listBySession, { workSessionId: sessionId });
  const repaired = !authenticated || nativeRepair;
  const candidate = runs.find((run) => run.role === (repaired ? "repair" : "builder"));
  if (!candidate) throw new Error("Missing accepted candidate run");
  // The agent's final message is stored as the run's result summary.
  if (authenticated) expect(candidate.resultSummary).toEqual(expect.any(String));
  else expect(candidate.resultSummary).toBe(`${candidate.role} finished: wrote outcome.txt`);
  // Intermediate agent messages (if the model wrote any) are bounded notes, never the reply.
  const notes = (
    await f.user.query(api.events.listByRun, {
      runId: candidate._id,
      paginationOpts: { numItems: 100, cursor: null },
    })
  ).page.filter((event: { type: string }) => event.type === "run.message") as {
    payload: { text: string };
  }[];
  for (const note of notes) {
    expect(note.payload.text.trim()).not.toBe("");
    expect(note.payload.text.length).toBeLessThanOrEqual(2000);
  }
  console.log(`Candidate run notes (run.message): ${notes.length}`);
  if (repaired) {
    const initial = runs.find((run) => run.role === "builder");
    if (!initial) throw new Error("Missing initial Builder run");
    expect(initial.finalHeadSha).not.toBe(candidate.finalHeadSha);
    expect(initial.workspaceId).not.toBe(candidate.workspaceId);
    const failedDecision = (await f.user.query(api.trust.listByRun, { runId: initial._id }))[0];
    expect(failedDecision?.eligible).toBe(false);
    const verifiers = runs.filter((run) => run.role === "verifier");
    expect(verifiers).toHaveLength(2);
    expect(new Set(verifiers.map((run) => run.workspaceId)).size).toBe(2);
  }
  const verifier = runs.find(
    (run) => run.role === "verifier" && run.finalHeadSha === candidate.finalHeadSha,
  )!;
  expect(candidate.workspaceId).not.toBe(verifier.workspaceId);
  expect((await f.user.query(api.trust.listByRun, { runId: candidate._id }))[0]!.eligible).toBe(
    true,
  );
  // The Node recorded both execution traces through the outbox.
  const trace = async (runId: Id<"agentRuns">) =>
    (
      await f.user.query(api.traces.listByRun, {
        runId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page as {
      kind: string;
      status: string;
      label: string;
      references?: Record<string, unknown>;
    }[];
  const built = await trace(candidate._id);
  expect(built.map((step) => [step.kind, step.status])).toEqual([
    ["discovery", "passed"],
    ["workspace", "passed"],
    ["runtime", "passed"],
    ["workspace", "passed"],
    // Backend-side: the trust decision and the prepared integration branch.
    ["trust", "passed"],
    ["integration", "passed"],
  ]);
  expect(built[3]?.references?.sha).toBe(candidate.finalHeadSha);
  expect(built[4]?.references?.sha).toBe(candidate.finalHeadSha);
  expect(built[5]?.references?.sha).toBe(candidate.finalHeadSha);
  const checked = await trace(verifier._id);
  expect(checked.filter((step) => step.kind === "verification-check")).toEqual([
    expect.objectContaining({ status: "passed", label: "git diff --check HEAD^ HEAD" }),
    expect.objectContaining({
      status: "passed",
      label: "npm run test",
      references: { script: "test", exitCode: 0, sha: candidate.finalHeadSha },
    }),
  ]);
  const spaces = await f.user.query(api.workspaces.listBySession, { workSessionId: sessionId });
  expect(
    spaces.some(
      (space) => space.kind === "integration" && space.currentHeadSha === candidate.finalHeadSha,
    ),
  ).toBe(true);
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(canonicalSha);
  expect(git(f.path, ["status", "--porcelain"])).toBe("");
  expect(n.store.listPendingEvents()).toEqual([]);
  console.log(
    `PASS Alpha ${authenticated ? (nativeRepair ? "native Codex with repair" : "native Codex") : "fixture runtime with repair"}: intent → context → plan → candidate → verifier → evidence → trust → integration; canonical unchanged`,
  );
}, 240_000);

it("runs independent builders concurrently and provisions a dependent task with both trusted commits", async () => {
  const f = await fixture();
  const { writeFileSync, existsSync } = await import("node:fs");
  writeFileSync(
    join(f.path, "package.json"),
    JSON.stringify({
      scripts: {
        "test:a": "node -e \"require('node:assert').ok(require('node:fs').existsSync('a.txt'))\"",
        "test:b": "node -e \"require('node:assert').ok(require('node:fs').existsSync('b.txt'))\"",
        "test:combined":
          "node -e \"const f=require('node:fs');require('node:assert').ok(f.existsSync('a.txt')&&f.existsSync('b.txt')&&f.existsSync('c.txt'))\"",
      },
    }),
  );
  git(f.path, ["add", "."]);
  git(f.path, ["commit", "-m", "DAG checks"]);
  const base = git(f.path, ["rev-parse", "HEAD"]);
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    const id = await ctx.db.insert("products", {
      ownerId: session!.ownerId,
      name: "DAG",
      slug: "dag",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId: id });
    await ctx.db.patch("repositoryLocations", f.repositoryLocationId, { lastKnownHead: base });
    return id;
  });
  for (const role of ["builder", "verifier", "repair"] as const)
    await f.user.mutation(api.agentProfiles.upsert, {
      name: role,
      role,
      runtime: "fake",
      enabled: true,
    });
  let active = 0,
    peak = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new (class extends FakeRuntime {
    override async start(input: StartRunInput) {
      if (input.role !== "verifier") {
        active++;
        peak = Math.max(peak, active);
        const key = input.instruction.slice(0, 1);
        if (key === "a" || key === "b") {
          if (active === 2) release!();
          await barrier;
        } else {
          expect(existsSync(join(input.workspace.cwd, "a.txt"))).toBe(true);
          expect(existsSync(join(input.workspace.cwd, "b.txt"))).toBe(true);
        }
        writeFileSync(join(input.workspace.cwd, `${key}.txt`), `${key}\n`);
        active--;
      }
      return super.start(input);
    }
  })();
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const tasks = ["a", "b", "c"].map((key) => ({
    key,
    title: key,
    description: key,
    dependencies: key === "c" ? ["a", "b"] : [],
    verificationScripts: [key === "c" ? "test:combined" : `test:${key}`],
    requiredModalities: ["test"],
  }));
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: JSON.stringify({ tasks }),
    idempotencyKey: "dag",
  });
  for (let tick = 0; tick < 30; tick++) {
    await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
    await driver.tick();
    if ((await f.user.query(api.sessions.get, { workSessionId: sessionId })).status === "completed")
      break;
  }
  expect(peak).toBe(2);
  expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).status).toBe(
    "completed",
  );
  expect(
    (await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).every(
      (task) => task.phase === "completed",
    ),
  ).toBe(true);
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(base);
  expect(git(f.path, ["status", "--porcelain"])).toBe("");
}, 60_000);

it("parses optional Supervisor selection and bounded conversation on repository.plan", () => {
  const base = {
    _id: "command",
    workstationId: "node",
    idempotencyKey: "key",
    type: "repository.plan",
    targetType: "textCommand",
    targetId: "text",
  };
  const legacy = parseExecutionCommand({
    ...base,
    payload: { textCommandId: "text", workspaceId: "workspace", text: "Hi" },
  });
  expect(legacy.payload).toEqual({ textCommandId: "text", workspaceId: "workspace", text: "Hi" });
  const conversation = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 ? "supervisor" : "user",
    text: `${index}`.padEnd(5000, "x"),
  }));
  const parsed = parseExecutionCommand({
    ...base,
    payload: {
      textCommandId: "text",
      workspaceId: "workspace",
      text: "Hi",
      supervisor: { runtime: "codex", model: "gpt", reasoningEffort: "high" },
      conversation,
    },
  });
  if (parsed.type !== "repository.plan") throw new Error("Wrong command");
  expect(parsed.payload.supervisor).toEqual({
    runtime: "codex",
    model: "gpt",
    reasoningEffort: "high",
  });
  expect(parsed.payload.conversation).toHaveLength(20);
  expect(parsed.payload.conversation?.[0]?.text.startsWith("5x")).toBe(true);
  expect(parsed.payload.conversation?.every((message) => message.text.length === 4000)).toBe(true);
  for (const payload of [
    { supervisor: { model: "gpt" } },
    { supervisor: "codex" },
    { conversation: [{ role: "system", text: "x" }] },
    { conversation: "x" },
  ])
    expect(
      parsePendingCommand({
        ...base,
        payload: { textCommandId: "text", workspaceId: "workspace", text: "Hi", ...payload },
      })?.type,
    ).toBe("invalid");
});

it("answers a question through the Supervisor without starting builders", async () => {
  const f = await fixture();
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    const id = await ctx.db.insert("products", {
      ownerId: session!.ownerId,
      name: "Question",
      slug: "question",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId: id });
    await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
      lastKnownHead: f.originalHead,
    });
    return id;
  });
  for (const role of ["builder", "verifier", "repair"] as const)
    await f.user.mutation(api.agentProfiles.upsert, {
      name: role,
      role,
      runtime: "fake",
      enabled: true,
    });
  const roles: Array<string | undefined> = [];
  const runtime = new (class extends FakeRuntime {
    override async start(input: StartRunInput) {
      roles.push(input.role);
      return super.start(input);
    }
  })((input) => [
    {
      type: "success",
      summary: input.instruction.includes("What does source.txt contain?")
        ? `\`\`\`json\n${JSON.stringify({ decision: "answer", reply: "It contains `base`.", tasks: [] })}\n\`\`\``
        : "Unexpected instruction",
    },
  ]);
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: "What does source.txt contain?",
    idempotencyKey: "question",
  });
  for (let tick = 0; tick < 5; tick++) {
    await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
    await driver.tick();
  }
  expect(roles).toEqual(["supervisor"]);
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("waiting");
  expect(session.totalTaskCount).toBe(0);
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toEqual([]);
  expect(await f.user.query(api.runs.listBySession, { workSessionId: sessionId })).toEqual([]);
  const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    text: "What does source.txt contain?",
    planned: true,
    planTaskCount: 0,
    decision: "answer",
    reply: "It contains `base`.",
  });
  expect(n.store.listPendingEvents()).toEqual([]);
  expect(n.store.listInterruptedCommands()).toEqual([]);
  expect(await n.transport.listPending()).toEqual([]);
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
}, 60_000);

async function orchestratorFixture(
  script: ConstructorParameters<typeof FakeRuntime>[0],
  beforeStart: (input: StartRunInput) => Promise<void> | undefined = () => undefined,
) {
  const f = await fixture();
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    const id = await ctx.db.insert("products", {
      ownerId: session!.ownerId,
      name: "Shop",
      slug: "shop",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId: id });
    await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
      lastKnownHead: f.originalHead,
    });
    return id;
  });
  for (const role of ["orchestrator", "supervisor", "builder", "verifier", "repair"] as const)
    await f.user.mutation(api.agentProfiles.upsert, {
      name: role,
      role,
      runtime: "fake",
      enabled: true,
      ...(role === "orchestrator" ? { model: "fake-model" } : {}),
    });
  const starts: StartRunInput[] = [];
  const runtime = new (class extends FakeRuntime {
    override async start(input: StartRunInput) {
      starts.push(input);
      await beforeStart(input);
      return super.start(input);
    }
  })(script);
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const run = async () => {
    for (let tick = 0; tick < 5; tick++) {
      await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
      await driver.tick();
      await driver.idle();
    }
  };
  return { f, n, driver, productId, starts, run };
}

it("answers a top-level question with the Orchestrator model and opens its proposal only on request", async () => {
  const { f, n, productId, starts, run } = await orchestratorFixture((input) => [
    {
      type: "success",
      summary: input.instruction.includes("What should we do about checkout?")
        ? `\`\`\`json\n${JSON.stringify({ decision: "propose", reply: "Checkout totals look wrong; I can fix them.", proposal: "Fix checkout totals rounding; add a test." })}\n\`\`\``
        : `\`\`\`json\n${JSON.stringify({ decision: "answer", reply: "Planned.", tasks: [] })}\n\`\`\``,
    },
  ]);
  const sessionsBefore = await f.t.run((ctx) => ctx.db.query("workSessions").collect());
  const submitted = await f.user.mutation(api.orchestrator.submit, {
    text: "What should we do about checkout?",
    idempotencyKey: "orch-model",
    productId,
    repositoryId: f.repositoryId,
  });
  expect(submitted.route).toBe("answer");
  let [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message).toMatchObject({
    status: "thinking",
    runtime: "fake",
    modelRequested: "fake-model",
  });
  await run();
  expect(starts).toHaveLength(1);
  const start = starts[0]!;
  expect(start).toMatchObject({ role: "supervisor", model: "fake-model" });
  // No repository: an empty scratch directory that is removed afterwards.
  expect(start.workspace.cwd).not.toContain(f.path);
  expect(existsSync(start.workspace.cwd)).toBe(false);
  expect(start.instruction).toContain("Zamolxis Orchestrator");
  expect(start.instruction).toContain('Scope: Product "Shop"');
  [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message).toMatchObject({
    status: "answered",
    answeredBy: "model",
    route: "propose",
    reply: "Checkout totals look wrong; I can fix them.",
    proposal: "Fix checkout totals rounding; add a test.",
  });
  // A proposal is inert: nothing was opened or dispatched.
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(
    sessionsBefore.length,
  );
  expect(await f.t.run((ctx) => ctx.db.query("textCommands").collect())).toEqual([]);

  const sessionId = await f.user.mutation(api.orchestrator.openProposal, {
    messageId: message!._id,
    productId,
    repositoryId: f.repositoryId,
  });
  expect(
    await f.user.mutation(api.orchestrator.openProposal, {
      messageId: message!._id,
      productId,
      repositoryId: f.repositoryId,
    }),
  ).toBe(sessionId);
  const commands = await f.t.run((ctx) => ctx.db.query("textCommands").collect());
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    workSessionId: sessionId,
    text: "Open this work: Fix checkout totals rounding; add a test.",
  });
  [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message?.proposalSessionId).toBe(sessionId);
  expect(message?.links.at(-1)).toMatchObject({ targetType: "session", workSessionId: sessionId });
  expect(n.store.listInterruptedCommands()).toEqual([]);
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
}, 60_000);

it("keeps the deterministic answer when the Orchestrator model fails", async () => {
  const { f, run } = await orchestratorFixture(() => [{ type: "failure", message: "boom" }]);
  await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "orch-fail",
  });
  const [before] = await f.user.query(api.orchestrator.messages, {});
  expect(before?.status).toBe("thinking");
  await run();
  const [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message).toMatchObject({
    status: "answered",
    answeredBy: "deterministic",
    modelError: "ORCHESTRATOR_FAILED",
    route: "answer",
    reply: before?.reply,
  });
  const session = await f.user.query(api.sessions.get, { workSessionId: f.workSessionId });
  expect(session.status).not.toBe("needs_input");
}, 60_000);

it("does not hold up Session planning while the Orchestrator model is replying", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { f, driver, productId } = await orchestratorFixture(
    (input) => [
      {
        type: "success",
        summary: `\`\`\`json\n${JSON.stringify(
          input.instruction.includes("Zamolxis Orchestrator")
            ? { decision: "answer", reply: "Late reply." }
            : { decision: "answer", reply: "Planned answer.", tasks: [] },
        )}\n\`\`\``,
      },
    ],
    (input) => (input.instruction.includes("Zamolxis Orchestrator") ? gate : undefined),
  );
  await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "slow",
  });
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: "What does source.txt contain?",
    idempotencyKey: "plan-while-answering",
  });
  for (let tick = 0; tick < 5; tick++) {
    await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
    await driver.tick();
  }
  const [plan] = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
  expect(plan).toMatchObject({ decision: "answer", reply: "Planned answer." });
  expect((await f.user.query(api.orchestrator.messages, {}))[0]?.status).toBe("thinking");
  release();
  await driver.idle();
  await driver.tick();
  expect((await f.user.query(api.orchestrator.messages, {}))[0]).toMatchObject({
    status: "answered",
    reply: "Late reply.",
  });
}, 60_000);

it("parses supervisor.stop only for its own text command", () => {
  const base = {
    _id: "command",
    workstationId: "node",
    idempotencyKey: "supervisor-stop:text",
    type: "supervisor.stop",
    targetType: "textCommand",
    targetId: "text",
  };
  expect(parseExecutionCommand({ ...base, payload: { textCommandId: "text" } })).toEqual({
    commandId: "command",
    workstationId: "node",
    idempotencyKey: "supervisor-stop:text",
    type: "supervisor.stop",
    payload: { textCommandId: "text" },
  });
  for (const command of [
    { ...base, payload: { textCommandId: "other" } },
    { ...base, targetType: "run", payload: { textCommandId: "text" } },
    { ...base, payload: {} },
  ])
    expect(parsePendingCommand(command)?.type).toBe("invalid");
});

it("shows a blocking Supervisor's progress and stops it from the owner's message", async () => {
  const f = await fixture();
  const productId = await f.t.run(async (ctx) => {
    const session = await ctx.db.get("workSessions", f.workSessionId);
    const id = await ctx.db.insert("products", {
      ownerId: session!.ownerId,
      name: "Stop",
      slug: "stop",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", f.repositoryId, { productId: id });
    await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
      lastKnownHead: f.originalHead,
    });
    return id;
  });
  for (const role of ["builder", "verifier", "repair"] as const)
    await f.user.mutation(api.agentProfiles.upsert, {
      name: role,
      role,
      runtime: "fake",
      enabled: true,
    });
  // A Supervisor that reads the repository and never answers until it is stopped.
  const roles: Array<string | undefined> = [];
  class BlockingSupervisor extends FakeRuntime {
    #release: () => void = () => {};
    readonly #stopped = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    override async start(input: StartRunInput) {
      roles.push(input.role);
      return super.start(input);
    }
    override async *subscribe(input: {
      nativeSessionId: string;
      afterSequence?: number;
    }): AsyncIterable<NormalizedRunEventDto> {
      let cursor = input.afterSequence ?? 0;
      for await (const event of super.subscribe({ ...input, afterSequence: cursor })) {
        cursor = event.sequence;
        yield event;
      }
      await this.#stopped;
      yield* super.subscribe({ ...input, afterSequence: cursor });
    }
    override async stop(input: { nativeSessionId: string }) {
      await super.stop(input);
      this.#release();
    }
  }
  const runtime = new BlockingSupervisor([{ type: "activity", label: "Reading source.txt" }]);
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: "Explain the whole repository",
    idempotencyKey: "blocking",
  });
  const ticking = (async () => {
    for (let tick = 0; tick < 3; tick++) {
      await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
      await driver.tick();
    }
  })();
  // The throttled activity reaches the owner while the Supervisor still works.
  type Message = {
    _id: Id<"textCommands">;
    progress?: { activity?: string; startedAt: number };
    [key: string]: unknown;
  };
  let message: Message | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    [message] = (await f.user.query(api.supervisor.messages, {
      workSessionId: sessionId,
    })) as Message[];
    if (message?.progress?.activity) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(message?.progress).toEqual({
    activity: "Reading source.txt",
    startedAt: expect.any(Number),
  });
  expect(message?.planStatus).toBe("acknowledged");
  expect(await f.user.mutation(api.supervisor.stop, { textCommandId: message!._id })).toBe(
    "stopping",
  );
  await driver.control();
  await ticking;
  [message] = (await f.user.query(api.supervisor.messages, {
    workSessionId: sessionId,
  })) as Message[];
  expect(message).toMatchObject({
    stopped: true,
    planStatus: "failed",
    planError: "SUPERVISOR_STOPPED",
    planned: false,
  });
  expect(roles).toEqual(["supervisor"]);
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("waiting");
  expect(session.needsInputCount).toBe(0);
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toEqual([]);
  expect(await f.user.query(api.runs.listBySession, { workSessionId: sessionId })).toEqual([]);
  const stops = await f.t.run(async (ctx) =>
    (await ctx.db.query("commands").collect()).filter(
      (command) => command.type === "supervisor.stop",
    ),
  );
  expect(stops.map((command) => command.status)).toEqual(["completed"]);
  // A second stop is a no-op once the Supervisor stopped.
  expect(await f.user.mutation(api.supervisor.stop, { textCommandId: message!._id })).toBe(
    "stopped",
  );
  expect(n.store.listPendingEvents()).toEqual([]);
  expect(n.store.listInterruptedCommands()).toEqual([]);
  expect(await n.transport.listPending()).toEqual([]);
  expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
  expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
}, 60_000);

it.skipIf(process.env.ZAMOLXIS_CODEX_ACCEPTANCE !== "1")(
  "real Codex Supervisor answers a question without builders and can be stopped",
  async () => {
    const f = await fixture("codex");
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-supervisor-native-"));
    cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
    chmodSync(profile, 0o700);
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(profile, "auth.json"),
    );
    chmodSync(join(profile, "auth.json"), 0o600);
    const children: ReturnType<typeof spawn>[] = [];
    cleanup.push(() => {
      for (const child of children) child.kill();
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: "true" } }),
    );
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "acceptance scripts"]);
    const canonicalSha = git(f.path, ["rev-parse", "HEAD"]);
    const productId = await f.t.run(async (ctx) => {
      const session = await ctx.db.get("workSessions", f.workSessionId);
      const id = await ctx.db.insert("products", {
        ownerId: session!.ownerId,
        name: "Native",
        slug: "native-supervisor",
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.patch("repositories", f.repositoryId, { productId: id });
      await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
        lastKnownHead: canonicalSha,
      });
      return id;
    });
    const runtime = new CodexRuntime({
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
            children.push(child);
            return child;
          },
        }),
    });
    const n = await f.boot(runtime);
    const driver = n.driver();
    const { RepositoryDiscovery } = await import(
      "../packages/node-core/src/capabilities/repository-discovery"
    );
    driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));

    // 1. A question is answered in chat: no tasks, no runs, the repository untouched.
    const sessionId = await f.user.mutation(api.supervisor.submit, {
      productId,
      repositoryId: f.repositoryId,
      text: "Question only, do not change anything: which npm scripts does package.json define? Answer in one sentence.",
      idempotencyKey: "native-answer",
    });
    for (let tick = 0; tick < 5; tick++) {
      await driver.tick();
      const [message] = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
      if (message?.decision) break;
    }
    const [answered] = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
    expect(answered).toMatchObject({ decision: "answer", planTaskCount: 0 });
    expect(String(answered?.reply)).toMatch(/test/);
    expect(String(answered?.reply)).toMatch(/lint/);
    expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toEqual([]);
    expect(await f.user.query(api.runs.listBySession, { workSessionId: sessionId })).toEqual([]);
    expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).status).toBe(
      "waiting",
    );
    // "Show what I did": the Supervisor's log reached the backend through the outbox.
    const answeredLog = (await f.user.query(api.supervisor.log, {
      textCommandId: answered?._id as never,
    })) as { kind: string; label: string; status: string; detail?: string }[];
    expect(answeredLog[0]).toMatchObject({ kind: "discovery", status: "passed" });
    expect(answeredLog[1]).toMatchObject({ label: "Supervisor finished", status: "passed" });
    expect(answeredLog[1]?.detail).toMatch(/tokens/);
    expect(answeredLog.at(-1)).toMatchObject({ kind: "supervisor", label: "Answered" });
    console.log(
      `Supervisor log (answer): ${answeredLog.length} steps; ${answeredLog
        .map(
          (step) =>
            `${step.kind}:${step.label}${step.detail?.startsWith("Read ") ? ` [${step.detail}]` : ""}`,
        )
        .join(" | ")
        .slice(0, 2000)}`,
    );

    // 2. A follow-up that needs a long investigation is stopped while the Supervisor works.
    await f.user.mutation(api.supervisor.submit, {
      productId,
      repositoryId: f.repositoryId,
      text: "Question only: read every file in the repository one by one, run `git log` and `ls -la` several times, and then write a very long, detailed report about each file.",
      idempotencyKey: "native-stop",
      sessionId,
    });
    const ticking = driver.tick();
    let stopTarget: string | undefined;
    for (let attempt = 0; attempt < 240 && !stopTarget; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
      const pending = messages[1];
      if (pending && !pending.decision && pending.progress) stopTarget = pending._id;
      if (pending?.decision) break;
    }
    if (!stopTarget) {
      await ticking;
      throw new Error("The Supervisor finished before it could be stopped");
    }
    await f.user.mutation(api.supervisor.stop, { textCommandId: stopTarget as never });
    for (let attempt = 0; attempt < 60; attempt++) {
      await driver.control();
      const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
      if (messages[1]?.stopped || messages[1]?.decision) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await ticking.catch(() => undefined);
    const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
    expect(messages[1]).toMatchObject({ stopped: true });
    expect(messages[1]?.decision).toBeUndefined();
    const stoppedLog = (await f.user.query(api.supervisor.log, {
      textCommandId: stopTarget as never,
    })) as { kind: string; label: string; status: string }[];
    // How much it did before the stop depends on timing; the session and outcome are logged.
    console.log(
      `Supervisor log (stopped): ${stoppedLog.map((step) => `${step.kind}:${step.label}`).join(" | ")}`,
    );
    expect(stoppedLog[0]).toMatchObject({ kind: "discovery" });
    expect(stoppedLog.find((step) => step.kind === "supervisor")).toMatchObject({
      status: "failed",
    });
    expect(stoppedLog.at(-1)).toMatchObject({
      label: "Stopped before answering",
      status: "failed",
    });
    expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).status).toBe(
      "waiting",
    );
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(canonicalSha);
    expect(git(f.path, ["status", "--porcelain"])).toBe("");
  },
  900_000,
);

it.skipIf(process.env.ZAMOLXIS_CODEX_ACCEPTANCE !== "1")(
  "real Codex Orchestrator answers a top-level question without a repository",
  async () => {
    const f = await fixture("codex");
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-orchestrator-native-"));
    cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
    chmodSync(profile, 0o700);
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(profile, "auth.json"),
    );
    chmodSync(join(profile, "auth.json"), 0o600);
    const children: ReturnType<typeof spawn>[] = [];
    cleanup.push(() => {
      for (const child of children) child.kill();
    });
    const canonicalSha = git(f.path, ["rev-parse", "HEAD"]);
    const runtime = new CodexRuntime({
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
            children.push(child);
            return child;
          },
        }),
    });
    const n = await f.boot(runtime);
    const driver = n.driver();
    await f.user.mutation(api.orchestrator.submit, {
      text: "Question only: how many Work Sessions are listed in the current state? Reply in one short sentence that contains the number as digits.",
      idempotencyKey: "native-orchestrator",
    });
    for (let tick = 0; tick < 5; tick++) {
      await driver.tick();
      await driver.idle();
      const [message] = await f.user.query(api.orchestrator.messages, {});
      if (message?.status === "answered") break;
    }
    const [message] = await f.user.query(api.orchestrator.messages, {});
    expect(message).toMatchObject({ status: "answered", answeredBy: "model" });
    expect(["answer", "ask"]).toContain(message?.route);
    expect(String(message?.reply)).toMatch(/\d/);
    expect(message?.totalTokens).toBeGreaterThan(0);
    expect(await f.t.run((ctx) => ctx.db.query("textCommands").collect())).toEqual([]);
    expect(n.store.listInterruptedCommands()).toEqual([]);
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(canonicalSha);
    expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
  },
  900_000,
);

it.skipIf(process.env.ZAMOLXIS_CODEX_ACCEPTANCE !== "1")(
  "real Codex lists its models with reasoning efforts",
  async () => {
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-models-native-"));
    cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
    chmodSync(profile, 0o700);
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      join(profile, "auth.json"),
    );
    chmodSync(join(profile, "auth.json"), 0o600);
    const children: ReturnType<typeof spawn>[] = [];
    cleanup.push(() => {
      for (const child of children) child.kill();
    });
    const runtime = new CodexRuntime({
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
            children.push(child);
            return child;
          },
        }),
    });
    const models = await runtime.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.id && model.displayName)).toBe(true);
    expect(models.some((model) => (model.efforts?.length ?? 0) > 0)).toBe(true);
  },
  120_000,
);

// Real Claude Code acceptance (ZAMOLXIS_CLAUDE_ACCEPTANCE=1): the installed, signed-in
// `claude` CLI with the owner's subscription login (API key variables removed), using
// Haiku to spare quota. Every run uses a disposable repository and managed worktrees.
const claudeAcceptance = process.env.ZAMOLXIS_CLAUDE_ACCEPTANCE === "1";
const CLAUDE_TEST_MODEL = "claude-haiku-4-5";
function realClaude() {
  const children: ReturnType<typeof spawn>[] = [];
  cleanup.push(() => {
    for (const child of children) child.kill("SIGKILL");
  });
  const runtime = new ClaudeRuntime({
    launch: (launch) =>
      new ClaudeCliProcess({
        ...launch,
        spawnChild: (file, args, cwd) => {
          const child = spawn(file, [...args], {
            cwd,
            env: claudeEnv(),
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
          });
          children.push(child);
          return child;
        },
      }),
  });
  return { runtime, children };
}
async function claudeProfiles(
  f: Awaited<ReturnType<typeof fixture>>,
  roles: readonly ("supervisor" | "builder" | "verifier" | "repair")[],
) {
  for (const role of roles)
    await f.user.mutation(api.agentProfiles.upsert, {
      name: `Claude ${role}`,
      role,
      runtime: "claude",
      model: CLAUDE_TEST_MODEL,
      enabled: true,
    });
}

it.skipIf(!claudeAcceptance)(
  "answers a read-only Supervisor question with real Claude Code and edits nothing",
  async () => {
    const f = await fixture("claude");
    const productId = await f.t.run(async (ctx) => {
      const session = await ctx.db.get("workSessions", f.workSessionId);
      const id = await ctx.db.insert("products", {
        ownerId: session!.ownerId,
        name: "Claude question",
        slug: "claude-question",
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.patch("repositories", f.repositoryId, { productId: id });
      await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
        lastKnownHead: f.originalHead,
      });
      return id;
    });
    await claudeProfiles(f, ["supervisor", "builder", "verifier", "repair"]);
    const { runtime } = realClaude();
    const starts: Array<string | undefined> = [];
    const original = runtime.start.bind(runtime);
    runtime.start = (input) => {
      starts.push(input.role);
      return original(input);
    };
    const n = await f.boot(runtime, ["start", "stop", "message", "approval"]);
    const driver = n.driver();
    const { RepositoryDiscovery } = await import(
      "../packages/node-core/src/capabilities/repository-discovery"
    );
    driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
    const sessionId = await f.user.mutation(api.supervisor.submit, {
      productId,
      repositoryId: f.repositoryId,
      text: "What exact text does source.txt contain? Answer the question only; do not plan any work or change anything.",
      idempotencyKey: "claude-question",
    });
    for (let tick = 0; tick < 10; tick++) {
      await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
      await driver.tick();
      const [message] = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
      if (message?.planned) break;
    }
    expect(starts).toEqual(["supervisor"]);
    const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
    expect(messages[0]).toMatchObject({ planned: true, decision: "answer", planTaskCount: 0 });
    expect(String(messages[0]?.reply)).toMatch(/base/);
    expect(await f.user.query(api.runs.listBySession, { workSessionId: sessionId })).toEqual([]);
    const log = (await f.user.query(api.supervisor.log, {
      textCommandId: messages[0]?._id as never,
    })) as { kind: string; label: string }[];
    console.log(`Claude Supervisor log: ${log.map((step) => step.label).join(" | ")}`);
    expect(n.store.listPendingEvents()).toEqual([]);
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
    expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
  },
  180_000,
);

it.skipIf(!claudeAcceptance)(
  "makes a Builder change with real Claude Code in its own worktree and reports usage",
  async () => {
    const f = await fixture("claude");
    await claudeProfiles(f, ["builder"]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("tasks", f.taskId, {
        description:
          "Create the file claude.txt containing exactly CLAUDE_OK followed by a newline, using the Write tool. Do not run shell commands, Git or tests, and do not change any other file.",
      });
    });
    const { runtime } = realClaude();
    const n = await f.boot(runtime, ["start", "stop", "message", "approval"]);
    const workspaceId = await f.user.mutation(api.workspaces.request, {
      taskId: f.taskId,
      repositoryLocationId: f.repositoryLocationId,
      baseRef: "main",
    });
    await n.driver().tick();
    const runId = await f.user.mutation(api.runs.request, {
      taskId: f.taskId,
      workspaceId,
      runtime: "claude",
    });
    await n.driver().tick();
    const run = await f.user.query(api.runs.get, { runId });
    expect(run.status).toBe("completed");
    expect(run.modelActual).toMatch(/haiku/);
    expect(run.inputTokens).toBeGreaterThan(0);
    expect(run.outputTokens).toBeGreaterThan(0);
    expect(run.totalTokens).toBe((run.inputTokens ?? 0) + (run.outputTokens ?? 0));
    const stored = n.store.getRuntimeSession(runId);
    expect(stored?.runtime).toBe("claude");
    expect(stored?.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const events = (
      await f.user.query(api.events.listByRun, {
        runId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page as { type: string; payload: Record<string, unknown> }[];
    expect(events.some((event) => event.type === "files.changed")).toBe(true);
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    const workspace = n.workspaces.inspect(workspaceId);
    expect(workspace.path).not.toBe(f.path);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(workspace.path, "claude.txt"), "utf8").trim()).toBe("CLAUDE_OK");
    console.log(
      `Claude Builder: ${run.modelActual}, ${run.inputTokens} in (${run.cachedInputTokens} cached) / ${run.outputTokens} out; events ${events.map((event) => event.type).join(",")}`,
    );
    expect(n.store.listPendingEvents()).toEqual([]);
    expect(n.store.getWorkspaceLease(workspaceId)).toBeUndefined();
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(f.originalHead);
    expect(git(f.path, ["status", "--porcelain"])).toBe(f.originalStatus);
    expect(existsSync(join(f.path, "claude.txt"))).toBe(false);
  },
  180_000,
);

it.skipIf(!claudeAcceptance)(
  "lists the models of the real Claude Code CLI",
  async () => {
    const { runtime } = realClaude();
    const models = await runtime.listModels();
    console.log(`Claude models: ${models.map((model) => model.id).join(", ")}`);
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((model) => model.isDefault)).toHaveLength(1);
    expect(models.every((model) => model.id && model.displayName)).toBe(true);
  },
  90_000,
);

it.skipIf(!claudeAcceptance)(
  "holds a real Claude permission request for a human, then stops and resumes after a restart",
  async () => {
    const repo = repositoryFixture();
    cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const head = git(repo.path, ["rev-parse", "HEAD"]);
    const input = {
      runId: "claude-acceptance-run" as never,
      workstationId: "claude-acceptance-node" as never,
      role: "builder" as const,
      model: CLAUDE_TEST_MODEL,
      instruction:
        "Run exactly this shell command with the Bash tool, in the foreground: node -e \"setTimeout(()=>console.log('done'),20000)\" . If it is not allowed, reply with the single word BLOCKED and stop.",
      workspace: {
        workspaceId: "claude-ws" as never,
        cwd: repo.path,
        branch: "main",
        headSha: head,
      },
    };
    const first = realClaude();
    const started = await first.runtime.start(input);
    const seen: NormalizedRunEventDto[] = [];
    for await (const event of first.runtime.subscribe({
      nativeSessionId: started.nativeSessionId,
    })) {
      seen.push(event);
      if (event.type === "approval.requested" || event.type.startsWith("run.c")) break;
    }
    const requested = seen.at(-1);
    expect(requested?.type).toBe("approval.requested");
    if (requested?.type !== "approval.requested") throw new Error("no approval");
    expect(requested.payload.kind).toBe("command");
    expect(requested.payload.summary).toContain("node -e");
    // A Node restart: the CLI process dies with its pending request.
    for (const child of first.children) child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = realClaude();
    const resumed = await second.runtime.resume({
      ...input,
      nativeSessionId: started.nativeSessionId,
      afterSequence: requested.sequence,
      pendingApprovalIds: [requested.payload.approvalId],
      interrupted: "continue",
    });
    expect(resumed.nativeSessionId).toBe(started.nativeSessionId);
    const after: NormalizedRunEventDto[] = [];
    for await (const event of second.runtime.subscribe({
      nativeSessionId: started.nativeSessionId,
    })) {
      after.push(event);
      if (event.type === "approval.requested") {
        // The resumed agent asks again under a new id; stopping rejects it first.
        expect(event.payload.approvalId).not.toBe(requested.payload.approvalId);
        await second.runtime.stop({ nativeSessionId: started.nativeSessionId });
      }
    }
    console.log(`Claude resume events: ${after.map((event) => event.type).join(",")}`);
    expect(after[0]).toMatchObject({
      sequence: requested.sequence + 1,
      type: "approval.resolved",
      payload: {
        approvalId: requested.payload.approvalId,
        decision: "rejected",
        reason: "withdrawn",
      },
    });
    expect(["run.stopped", "run.completed"]).toContain(after.at(-1)?.type);
    expect(
      after.some(
        (event) => event.type === "approval.resolved" && event.payload.decision === "approved",
      ),
    ).toBe(false);
    // Stop while a request is held: it is rejected before the run reports stopped.
    const third = realClaude();
    const held = await third.runtime.start({ ...input, runId: "claude-acceptance-stop" as never });
    const stopped: NormalizedRunEventDto[] = [];
    for await (const event of third.runtime.subscribe({ nativeSessionId: held.nativeSessionId })) {
      stopped.push(event);
      if (event.type === "approval.requested")
        await third.runtime.stop({ nativeSessionId: held.nativeSessionId });
    }
    console.log(`Claude stop events: ${stopped.map((event) => event.type).join(",")}`);
    const types = stopped.map((event) => event.type);
    expect(types.at(-1)).toBe("run.stopped");
    expect(types.indexOf("approval.resolved")).toBeGreaterThan(types.indexOf("approval.requested"));
    expect(stopped.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
      decision: "rejected",
      reason: "stopped",
    });
    expect(git(repo.path, ["status", "--porcelain"])).toBe("");
  },
  180_000,
);

it.skipIf(!claudeAcceptance)(
  "keeps a real Claude Verifier read-only even when told to write",
  async () => {
    const repo = repositoryFixture();
    cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const head = git(repo.path, ["rev-parse", "HEAD"]);
    const { runtime } = realClaude();
    const started = await runtime.start({
      runId: "claude-acceptance-verifier" as never,
      workstationId: "claude-acceptance-node" as never,
      role: "verifier",
      model: CLAUDE_TEST_MODEL,
      instruction:
        "Read source.txt. Then try to create written.txt containing x with a file tool, and run the shell command `touch touched.txt`. Report which of these worked.",
      workspace: {
        workspaceId: "claude-ws" as never,
        cwd: repo.path,
        branch: "main",
        headSha: head,
      },
    });
    const events: NormalizedRunEventDto[] = [];
    for await (const event of runtime.subscribe({ nativeSessionId: started.nativeSessionId }))
      events.push(event);
    console.log(`Claude Verifier events: ${events.map((event) => event.type).join(",")}`);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    expect(events.some((event) => event.type === "files.changed")).toBe(false);
    expect(existsSync(join(repo.path, "written.txt"))).toBe(false);
    expect(existsSync(join(repo.path, "touched.txt"))).toBe(false);
    expect(git(repo.path, ["status", "--porcelain"])).toBe("");
    expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(head);
  },
  120_000,
);

it.skipIf(!claudeAcceptance)(
  "runs text intent with real Claude Code as Supervisor, Builder and independent Verifier",
  async () => {
    const f = await fixture("claude");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('outcome.txt','utf8').trim(),'ALPHA_OK')\"",
        },
      }),
    );
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "acceptance check"]);
    const canonicalSha = git(f.path, ["rev-parse", "HEAD"]);
    const productId = await f.t.run(async (ctx) => {
      const session = await ctx.db.get("workSessions", f.workSessionId);
      const id = await ctx.db.insert("products", {
        ownerId: session!.ownerId,
        name: "Claude native",
        slug: "claude-native",
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.patch("repositories", f.repositoryId, { productId: id });
      await ctx.db.patch("repositoryLocations", f.repositoryLocationId, {
        lastKnownHead: canonicalSha,
      });
      return id;
    });
    await claudeProfiles(f, ["supervisor", "builder", "verifier", "repair"]);
    const { runtime } = realClaude();
    const n = await f.boot(runtime, ["start", "stop", "message", "approval"]);
    const driver = n.driver();
    const { RepositoryDiscovery } = await import(
      "../packages/node-core/src/capabilities/repository-discovery"
    );
    driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
    const sessionId = await f.user.mutation(api.supervisor.submit, {
      productId,
      repositoryId: f.repositoryId,
      text: "Create outcome.txt containing exactly ALPHA_OK and a newline. Use the file editing tool. Do not run Git commands, tests or network tools. Zamolxis will commit your edits and run checks independently.",
      idempotencyKey: "claude-native-alpha",
    });
    for (let tick = 0; tick < 20; tick++) {
      await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
      await driver.tick();
      const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
      if (["completed", "failed", "needs_input"].includes(session.status)) break;
    }
    const runs = await f.user.query(api.runs.listBySession, { workSessionId: sessionId });
    console.log(
      `Claude loop runs: ${runs.map((run) => `${run.role}:${run.runtime}:${run.status}:${run.modelActual ?? "-"}`).join(" ")}`,
    );
    const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
    expect(session.status).toBe("completed");
    expect(runs.every((run) => run.runtime === "claude")).toBe(true);
    const candidate = runs.find(
      (run) =>
        (run.role === "builder" || run.role === "repair") &&
        run.status === "completed" &&
        run.finalHeadSha,
    );
    if (!candidate) throw new Error("Missing candidate run");
    const verifier = runs.find(
      (run) => run.role === "verifier" && run.finalHeadSha === candidate.finalHeadSha,
    );
    if (!verifier) throw new Error("Missing verifier run");
    expect(verifier.workspaceId).not.toBe(candidate.workspaceId);
    expect((await f.user.query(api.trust.listByRun, { runId: candidate._id }))[0]?.eligible).toBe(
      true,
    );
    const spaces = await f.user.query(api.workspaces.listBySession, { workSessionId: sessionId });
    expect(
      spaces.some(
        (space) => space.kind === "integration" && space.currentHeadSha === candidate.finalHeadSha,
      ),
    ).toBe(true);
    expect(git(f.path, ["rev-parse", "HEAD"])).toBe(canonicalSha);
    expect(git(f.path, ["status", "--porcelain"])).toBe("");
    expect(n.store.listPendingEvents()).toEqual([]);
  },
  300_000,
);
