import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import {
  rmSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  copyFileSync,
  chmodSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { runFakeLoopOnce } from "../apps/node/src/fake-loop";
import {
  ConvexControlPlaneTransport,
  parseExecutionCommand,
} from "../apps/node/src/convex-control-plane";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import type { ControlPlaneTransport } from "../packages/node-core/src/control-plane/driver";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { FakeRuntime } from "../packages/runtime-core/src/fake/fake-runtime";
import { RuntimeRegistry } from "../packages/runtime-core/src/runtime-registry";
import type { AgentRuntime, StartRunInput } from "../packages/runtime-core/src/agent-runtime";
import type { WorkstationId } from "../packages/contracts/src/shared/ids";
import { git } from "../packages/git/src/repository-inspector";
import { CodexRuntime, type CodexConnection } from "../packages/runtime-codex/src/codex-runtime";
import {
  AppServerClient,
  type AppServerNotification,
} from "../packages/runtime-codex/src/app-server-client";
const modules = {
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
  const user = t.withIdentity({ subject: "alice", tokenIdentifier: "alice" });
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
  const boot = async (adapter: AgentRuntime = runtime) => {
    const store = new LocalStateStore(join(repo.root, "state.sqlite"));
    cleanup.push(() => store.close());
    const identity = store.getOrCreateIdentity();
    await node.mutation(api.node.heartbeat, {
      workstationId,
      instanceId: identity.instanceId,
      runtimeCapabilities: [{ runtime: adapter.id, capabilities: ["start"] }],
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
  await expect(restarted.driver().tick()).rejects.toThrow("RECONCILIATION_REQUIRED");
  expect(f.runtime.starts).toBe(0);
  expect((await f.user.query(api.runs.get, { runId })).status).toBe("lost");
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
    ? new CodexRuntime({
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
          if (input.role !== "verifier")
            writeFileSync(
              join(input.workspace.cwd, "outcome.txt"),
              ++buildStarts === 1 ? "FAIL\n" : "ALPHA_OK\n",
            );
          return super.start(input);
        }
      })();
  const n = await f.boot(runtime);
  const driver = n.driver();
  const { RepositoryDiscovery } = await import(
    "../packages/node-core/src/capabilities/repository-discovery"
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(n.workspaces));
  const sessionId = await f.user.mutation(api.supervisor.submit, {
    productId,
    repositoryId: f.repositoryId,
    text: nativeRepair
      ? "Acceptance requires outcome.txt containing exactly ALPHA_OK and a newline. This is a repair-loop acceptance exercise: the initial Builder must deliberately write FAIL and a newline; the Repair agent must replace it with ALPHA_OK and a newline after independent verification fails. Use the file editing tool. Do not run Git commands, tests or network tools. Zamolxis commits edits and executes checks independently."
      : "Create outcome.txt containing exactly ALPHA_OK and a newline. Use the file editing tool. Do not run Git commands, tests or network tools. Zamolxis will commit your edits and run checks independently.",
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
  const runs = await f.user.query(api.runs.listBySession, { workSessionId: sessionId });
  const repaired = !authenticated || nativeRepair;
  const candidate = runs.find((run) => run.role === (repaired ? "repair" : "builder"));
  if (!candidate) throw new Error("Missing accepted candidate run");
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
