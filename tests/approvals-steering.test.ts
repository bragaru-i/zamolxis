import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConvexControlPlaneTransport,
  parsePendingCommand,
} from "../apps/node/src/convex-control-plane";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import type { NormalizedRunEventDto } from "../packages/contracts/src";
import type { AgentRunId, WorkspaceId, WorkstationId } from "../packages/contracts/src/shared/ids";
import { git } from "../packages/git/src/repository-inspector";
import { ControlPlaneDriver } from "../packages/node-core/src/control-plane/driver";
import { LocalStateStore } from "../packages/node-core/src/persistence/local-state";
import { RepositoryRegistry } from "../packages/node-core/src/repository/repository-registry";
import { RuntimeManager } from "../packages/node-core/src/runtime/runtime-manager";
import { repositoryFixture } from "../packages/node-core/src/testing/git-fixture";
import { WorkspaceManager } from "../packages/node-core/src/workspace/workspace-manager";
import { AppServerClient } from "../packages/runtime-codex/src/app-server-client";
import { CodexRuntime } from "../packages/runtime-codex/src/codex-runtime";
import { FakeRuntime, type FakeStep } from "../packages/runtime-core/src/fake/fake-runtime";
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
// The single row a step expects; anything else fails the test.
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// Like Codex: a subscription stays open until the run is terminal or explicitly waiting.
class LiveRuntime extends FakeRuntime {
  streaming = false;
  #wake: Array<() => void> = [];
  #signal() {
    for (const wake of this.#wake.splice(0)) wake();
  }
  override async send(input: { nativeSessionId: string; message: string }) {
    await super.send(input);
    this.#signal();
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
      this.streaming = true;
      await new Promise<void>((resolve) => this.#wake.push(resolve));
    }
  }
}

async function fixture(
  runtime: FakeRuntime,
  capabilities = ["start", "stop", "message", "approval"],
  options: { approvalPolicy?: "auto_low" | "auto_low_medium" } = {},
) {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const originalHead = git(repo.path, ["rev-parse", "HEAD"]);
  const originalStatus = git(repo.path, ["status", "--porcelain"]);
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: mallory } = await seedHuman(t, "mallory");
  await user.mutation(api.profiles.ensure, {});
  await mallory.mutation(api.profiles.ensure, {});
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
    title: "Approvals",
    goal: "Approve",
    repositoryIds: [repositoryId],
  });
  const taskId = await user.mutation(api.tasks.create, {
    workSessionId,
    title: "Task",
    description: "Needs approval",
    kind: "implementation",
    priority: 1,
    runtimePolicy: { mode: "forced", runtime: "fake" },
  });
  const store = new LocalStateStore(join(repo.root, "state.sqlite"));
  cleanup.push(() => store.close());
  const identity = store.getOrCreateIdentity();
  await node.mutation(api.node.heartbeat, {
    workstationId,
    instanceId: identity.instanceId,
    runtimeCapabilities: [{ runtime: "fake", capabilities }],
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
  const workspaceId = await user.mutation(api.workspaces.request, {
    taskId,
    repositoryLocationId,
    baseRef: "main",
  });
  await driver.tick();
  if (options.approvalPolicy)
    await user.mutation(api.agentProfiles.upsert, {
      name: "Builder",
      role: "builder",
      runtime: "fake",
      enabled: true,
      approvalPolicy: options.approvalPolicy,
    });
  const runId = await user.mutation(api.runs.request, { taskId, workspaceId, runtime: "fake" });
  const commands = () => t.run((ctx) => ctx.db.query("commands").collect());
  const approvals = () => t.run((ctx) => ctx.db.query("approvals").collect());
  const run = () => user.query(api.runs.get, { runId });
  const until = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; !(await check()) && attempt < 400; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await check()).toBe(true);
  };
  const assertCanonicalUnchanged = () => {
    expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(git(repo.path, ["status", "--porcelain"])).toBe(originalStatus);
  };
  return {
    t,
    user,
    mallory,
    node,
    workstationId,
    workSessionId,
    taskId,
    workspaceId,
    runId,
    store,
    driver,
    commands,
    approvals,
    run,
    until,
    assertCanonicalUnchanged,
  };
}
const approvalThenSuccess: FakeStep[] = [
  { type: "approval", kind: "command", summary: "Run: pnpm install", risk: "high" },
  { type: "success", summary: "Installed" },
];

describe("approvals", { timeout: 60_000 }, () => {
  it("creates an approval from the run event and holds the run in needs_approval", async () => {
    const f = await fixture(new FakeRuntime(approvalThenSuccess));
    await f.driver.tick();
    expect((await f.run()).status).toBe("needs_approval");
    const approval = only(await f.user.query(api.approvals.listPending, {}));
    expect(approval).toMatchObject({
      workSessionId: f.workSessionId,
      runId: f.runId,
      workstationId: f.workstationId,
      action: "command",
      risk: "high",
      runtimeApprovalId: `${f.runId}:fake-0`,
      request: { kind: "command", summary: "Run: pnpm install" },
      status: "pending",
    });
    expect(
      await f.user.query(api.approvals.listPendingBySession, { workSessionId: f.workSessionId }),
    ).toHaveLength(1);
    // Another user sees nothing and cannot read or resolve it.
    expect(await f.mallory.query(api.approvals.listPending, {})).toEqual([]);
    await expect(
      f.mallory.query(api.approvals.listPendingBySession, { workSessionId: f.workSessionId }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.mallory.mutation(api.approvals.resolve, { approvalId: approval._id, decision: "approved" }),
    ).rejects.toThrow("FORBIDDEN");
    expect((await f.commands()).some((command) => command.type === "runtime.approval")).toBe(false);
  });

  it("resolves idempotently, enqueues one approval command and completes the run", async () => {
    const f = await fixture(new FakeRuntime(approvalThenSuccess));
    await f.driver.tick();
    const approval = only(await f.user.query(api.approvals.listPending, {}));
    for (let attempt = 0; attempt < 2; attempt++)
      await f.user.mutation(api.approvals.resolve, {
        approvalId: approval._id,
        decision: "approved",
      });
    await expect(
      f.user.mutation(api.approvals.resolve, { approvalId: approval._id, decision: "rejected" }),
    ).rejects.toThrow("INVALID_STATE");
    const queued = (await f.commands()).filter((command) => command.type === "runtime.approval");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      workstationId: f.workstationId,
      targetType: "run",
      targetId: f.runId,
      payload: { runId: f.runId, approvalId: `${f.runId}:fake-0`, decision: "approve" },
      status: "pending",
    });
    // The run keeps waiting until the runtime confirms the decision.
    expect((await f.run()).status).toBe("needs_approval");
    await f.driver.control();
    await f.driver.idle();
    const run = await f.run();
    expect(run.status).toBe("completed");
    expect(run.resultSummary).toBe("Installed");
    const settled = only(await f.approvals());
    expect(settled).toMatchObject({
      status: "approved",
      runtimeOutcome: { decision: "approved", reason: "user" },
    });
    expect((await f.commands()).every((command) => command.status === "completed")).toBe(true);
    expect(f.store.getWorkspaceLease(f.workspaceId)).toBeUndefined();
    f.assertCanonicalUnchanged();
  });

  it("lets the owner approve similar safe commands for only the current run", async () => {
    const f = await fixture(
      new FakeRuntime([
        {
          type: "approval",
          kind: "command",
          summary: "Run: node scripts/preview-brand.mjs access",
          risk: "medium",
          allowForSession: true,
        },
        { type: "success", summary: "Previewed" },
      ]),
    );
    await f.driver.tick();
    const approval = only(await f.user.query(api.approvals.listPending, {}));
    expect(approval.request).toMatchObject({ allowForSession: true });
    await f.user.mutation(api.approvals.resolve, {
      approvalId: approval._id,
      decision: "approved",
      scope: "run",
    });
    const queued = (await f.commands()).find((command) => command.type === "runtime.approval");
    expect(queued?.payload).toMatchObject({ decision: "approve_session" });
    await f.driver.control();
    await f.driver.idle();
    expect((await f.run()).status).toBe("completed");
    f.assertCanonicalUnchanged();
  });

  it("grants commands by the profile's policy and leaves the rest to the owner", async () => {
    const f = await fixture(
      new FakeRuntime([
        {
          type: "approval",
          kind: "command",
          summary: 'Run: node -e "console.log(${HOME})"',
          risk: "low",
          allowForSession: true,
        },
        { type: "approval", kind: "command", summary: "Run: pnpm build", risk: "medium" },
        { type: "success", summary: "Built" },
      ]),
      undefined,
      { approvalPolicy: "auto_low" },
    );
    expect((await f.run()).approvalPolicy).toBe("auto_low");
    await f.driver.tick();
    // The low-risk request never waited: approved by policy, for the rest of the run.
    expect(await f.user.query(api.approvals.listPending, {})).toEqual([]);
    const granted = only(await f.approvals());
    expect(granted).toMatchObject({
      risk: "low",
      status: "approved",
      resolvedByPolicy: "auto_low",
    });
    expect(granted.resolvedBy).toBeUndefined();
    const queued = only(
      (await f.commands()).filter((command) => command.type === "runtime.approval"),
    );
    expect(queued.payload).toMatchObject({ decision: "approve_session" });
    await f.driver.control();
    await f.driver.idle();
    // The medium-risk request is outside the policy and waits for the owner.
    expect((await f.run()).status).toBe("needs_approval");
    const pending = only(await f.user.query(api.approvals.listPending, {}));
    expect(pending).toMatchObject({ risk: "medium", status: "pending" });
    await f.user.mutation(api.approvals.resolve, { approvalId: pending._id, decision: "approved" });
    await f.driver.control();
    await f.driver.idle();
    expect((await f.run()).status).toBe("completed");
    f.assertCanonicalUnchanged();
  });

  it("never grants high or critical requests, file changes or the Verifier's role by policy", async () => {
    const f = await fixture(new FakeRuntime(approvalThenSuccess), undefined, {
      approvalPolicy: "auto_low_medium",
    });
    await f.driver.tick();
    // "Run: pnpm install" is high risk: it waits even under the widest policy.
    expect(only(await f.user.query(api.approvals.listPending, {}))).toMatchObject({
      risk: "high",
      status: "pending",
    });
    await expect(
      f.user.mutation(api.agentProfiles.upsert, {
        name: "Verifier",
        role: "verifier",
        runtime: "fake",
        enabled: true,
        approvalPolicy: "auto_low",
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("refuses run-scoped approval for high-risk or unsupported requests", async () => {
    const f = await fixture(new FakeRuntime(approvalThenSuccess));
    await f.driver.tick();
    const approval = only(await f.user.query(api.approvals.listPending, {}));
    await expect(
      f.user.mutation(api.approvals.resolve, {
        approvalId: approval._id,
        decision: "approved",
        scope: "run",
      }),
    ).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("delivers the decision to a run that is still streaming and returns it to running", async () => {
    const runtime = new LiveRuntime([
      ...approvalThenSuccess.slice(0, 1),
      { type: "activity", label: "Installing" },
      { type: "approval", kind: "fileChange", summary: "Change files: a.ts", risk: "medium" },
      { type: "success", summary: "Done" },
    ]);
    const f = await fixture(runtime);
    const ticking = f.driver.tick();
    await f.until(async () => (await f.run()).status === "needs_approval");
    const first = only(await f.user.query(api.approvals.listPending, {}));
    await f.user.mutation(api.approvals.resolve, { approvalId: first._id, decision: "rejected" });
    await f.driver.control();
    // The runtime confirmed the rejection, worked on and asked again.
    await f.until(async () => (await f.user.query(api.approvals.listPending, {})).length === 1);
    const second = only(await f.user.query(api.approvals.listPending, {}));
    expect(second.risk).toBe("medium");
    expect((await f.run()).status).toBe("needs_approval");
    await f.user.mutation(api.approvals.resolve, { approvalId: second._id, decision: "approved" });
    await f.driver.control();
    await ticking;
    expect((await f.run()).status).toBe("completed");
    const rows = await f.approvals();
    expect(rows.map((row) => [row.status, row.runtimeOutcome?.decision])).toEqual([
      ["rejected", "rejected"],
      ["approved", "approved"],
    ]);
    const events = await f.user.query(api.events.listByRun, {
      runId: f.runId,
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(events.page.map((event: { type: string }) => event.type)).toContain("approval.resolved");
  });

  it("rejects pending approvals when the run is stopped and expires the request", async () => {
    const runtime = new LiveRuntime(approvalThenSuccess);
    const f = await fixture(runtime);
    const ticking = f.driver.tick();
    await f.until(async () => (await f.run()).status === "needs_approval");
    await f.user.mutation(api.runs.stop, { runId: f.runId });
    await f.driver.control();
    await ticking;
    const run = await f.run();
    expect(run.status).toBe("stopped");
    expect(run.completedAt).toBeDefined();
    const approval = only(await f.approvals());
    expect(approval).toMatchObject({
      status: "expired",
      runtimeOutcome: { decision: "rejected", reason: "stopped" },
    });
    await expect(
      f.user.mutation(api.approvals.resolve, { approvalId: approval._id, decision: "approved" }),
    ).rejects.toThrow("INVALID_STATE");
    expect(await f.user.query(api.approvals.listPending, {})).toEqual([]);
  });

  it("rejects malformed approval events from the Node", async () => {
    const f = await fixture(new FakeRuntime([{ type: "waiting", reason: "Idle" }]));
    await f.driver.tick();
    const ingest = (payload: unknown) =>
      f.node.mutation(api.node.ingestBatch, {
        workstationId: f.workstationId,
        runId: f.runId,
        events: [
          { eventId: "x:1", sequence: 3, type: "approval.requested", occurredAt: 0, payload },
        ],
      });
    await expect(
      ingest({ approvalId: "a", kind: "shell", summary: "x", risk: "low" }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      ingest({ approvalId: "a", kind: "command", summary: "x".repeat(2001), risk: "low" }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      f.node.mutation(api.node.ingestBatch, {
        workstationId: f.workstationId,
        runId: f.runId,
        events: [
          {
            eventId: "x:1",
            sequence: 3,
            type: "approval.resolved",
            occurredAt: 0,
            payload: { approvalId: "unknown", decision: "approved", reason: "user" },
          },
        ],
      }),
    ).rejects.toThrow("INVALID_STATE");
  });
});

describe("failures", { timeout: 60_000 }, () => {
  it("records why an agent run failed and when, for the owner", async () => {
    const f = await fixture(
      new FakeRuntime([{ type: "failure", message: "Codex turn failed: Quota exceeded" }]),
    );
    await f.driver.tick();
    await f.until(async () => (await f.run()).status === "failed");
    expect((await f.run()).failure).toEqual({
      reason: "Codex turn failed: Quota exceeded",
      at: expect.any(Number),
    });
    f.assertCanonicalUnchanged();
  });
});

describe("steering", { timeout: 60_000 }, () => {
  it("sends a message to a streaming run through the control loop", async () => {
    const runtime = new LiveRuntime(approvalThenSuccess);
    const f = await fixture(runtime);
    const ticking = f.driver.tick();
    await f.until(async () => (await f.run()).status === "needs_approval");
    const commandId = await f.user.mutation(api.runs.sendMessage, {
      runId: f.runId,
      message: "Prefer the lockfile",
      idempotencyKey: "k1",
    });
    expect(
      await f.user.mutation(api.runs.sendMessage, {
        runId: f.runId,
        message: "Prefer the lockfile",
        idempotencyKey: "k1",
      }),
    ).toBe(commandId);
    await f.driver.control();
    const sent = (await f.commands()).find((command) => command._id === commandId);
    expect(sent?.status).toBe("completed");
    const approval = only(await f.user.query(api.approvals.listPending, {}));
    await f.user.mutation(api.approvals.resolve, {
      approvalId: approval._id,
      decision: "approved",
    });
    await f.driver.control();
    await ticking;
    expect((await f.run()).status).toBe("completed");
    const events = await f.user.query(api.events.listByRun, {
      runId: f.runId,
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(
      events.page.some(
        (event: { type: string; payload: { label?: string } }) =>
          event.payload.label === "Message received",
      ),
    ).toBe(true);
  });

  it("continues a waiting run with a message and settles it like a start", async () => {
    const f = await fixture(
      new FakeRuntime([
        { type: "waiting", reason: "Which file?" },
        { type: "success", summary: "Updated README" },
      ]),
    );
    await f.driver.tick();
    expect((await f.run()).status).toBe("waiting");
    await f.user.mutation(api.runs.sendMessage, {
      runId: f.runId,
      message: "README.md",
      idempotencyKey: "k1",
    });
    await f.driver.tick();
    const run = await f.run();
    expect(run.status).toBe("completed");
    expect(run.resultSummary).toBe("Updated README");
    expect(run.completedAt).toBeDefined();
    expect(f.store.getWorkspaceLease(f.workspaceId)).toBeUndefined();
    await expect(
      f.user.mutation(api.runs.sendMessage, {
        runId: f.runId,
        message: "Again",
        idempotencyKey: "k2",
      }),
    ).rejects.toThrow("INVALID_STATE");
    f.assertCanonicalUnchanged();
  });

  it("refuses messages for other users, empty text or Nodes without steering", async () => {
    const f = await fixture(new FakeRuntime([{ type: "waiting", reason: "Idle" }]), [
      "start",
      "stop",
    ]);
    await f.driver.tick();
    await expect(
      f.mallory.mutation(api.runs.sendMessage, {
        runId: f.runId,
        message: "Hi",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.user.mutation(api.runs.sendMessage, { runId: f.runId, message: "  ", idempotencyKey: "k" }),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      f.user.mutation(api.runs.sendMessage, { runId: f.runId, message: "Hi", idempotencyKey: "k" }),
    ).rejects.toThrow("RUNTIME_MESSAGE_UNSUPPORTED");
    expect((await f.commands()).some((command) => command.type === "runtime.send")).toBe(false);
  });
});

it("never lets an id from another session's run be resolved through a forged row", async () => {
  const f = await fixture(new FakeRuntime(approvalThenSuccess));
  await f.driver.tick();
  const approval = only(await f.user.query(api.approvals.listPending, {}));
  const other = await f.mallory.mutation(api.sessions.create, {
    title: "Other",
    goal: "Other",
    repositoryIds: [],
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch("approvals", approval._id as Id<"approvals">, {
      workSessionId: other as Id<"workSessions">,
    });
  });
  // Mallory owns the forged session but not the run: the backend refuses to enqueue.
  await expect(
    f.mallory.mutation(api.approvals.resolve, { approvalId: approval._id, decision: "approved" }),
  ).rejects.toThrow("FORBIDDEN");
});

it("parses runtime.approval commands strictly", () => {
  const base = {
    _id: "command",
    workstationId: "node",
    idempotencyKey: "approval:1",
    type: "runtime.approval",
    targetType: "run",
    targetId: "run",
  };
  expect(
    parsePendingCommand({
      ...base,
      payload: { runId: "run", approvalId: "run:7", decision: "approve" },
    }),
  ).toMatchObject({
    type: "runtime.approval",
    payload: { runId: "run", approvalId: "run:7", decision: "approve" },
  });
  expect(
    parsePendingCommand({
      ...base,
      payload: { runId: "run", approvalId: "run:7", decision: "always" },
    }),
  ).toMatchObject({ type: "invalid", payload: { code: "INVALID_COMMAND" } });
  expect(
    parsePendingCommand({
      ...base,
      targetId: "other",
      payload: { runId: "run", approvalId: "run:7", decision: "approve" },
    }),
  ).toMatchObject({ type: "invalid", payload: { code: "INVALID_COMMAND_TARGET" } });
});

// Real codex-cli app-server in a temporary profile and a disposable repository: a command
// that needs network access is held for approval, rejected, and nothing runs.
it.skipIf(process.env.ZAMOLXIS_AUTHENTICATED_ACCEPTANCE !== "1")(
  "holds and rejects a real Codex approval request",
  async () => {
    const repo = repositoryFixture();
    cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const head = git(repo.path, ["rev-parse", "HEAD"]);
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-approval-acceptance-"));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      chmodSync(profile, 0o700);
      copyFileSync(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
        join(profile, "auth.json"),
      );
      chmodSync(join(profile, "auth.json"), 0o600);
      const worktree = join(repo.root, "worktree");
      git(repo.path, ["worktree", "add", "-b", "acceptance", worktree, "HEAD"]);
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
      const session = await runtime.start({
        runId: "acceptance" as AgentRunId,
        workstationId: "node" as WorkstationId,
        role: "builder",
        instruction:
          "Run exactly this shell command with escalated permissions because it needs network access: curl -sS -o /dev/null -w '%{http_code}' https://example.com . If it is not approved, reply BLOCKED and do nothing else.",
        workspace: {
          workspaceId: "workspace" as WorkspaceId,
          cwd: realpathSync.native(worktree),
          branch: "acceptance",
          headSha: head,
        },
      });
      const seen: NormalizedRunEventDto[] = [];
      for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId })) {
        seen.push(event);
        if (event.type === "approval.requested")
          await runtime.resolveApproval({
            nativeSessionId: session.nativeSessionId,
            approvalId: event.payload.approvalId,
            decision: "reject",
          });
      }
      const requested = seen.filter((event) => event.type === "approval.requested");
      console.info(
        "approval acceptance",
        JSON.stringify(requested.map((event) => event.payload)),
        seen.at(-1)?.type,
      );
      expect(requested.length).toBeGreaterThan(0);
      expect(
        seen
          .filter((event) => event.type === "approval.resolved")
          .every((event) => event.payload.decision === "rejected"),
      ).toBe(true);
      expect(["run.completed", "run.failed", "run.stopped"]).toContain(seen.at(-1)?.type);
      expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    }
  },
  180_000,
);
it.skipIf(process.env.ZAMOLXIS_AUTHENTICATED_ACCEPTANCE !== "1")(
  "holds a real Codex approval request and runs the command once approved",
  async () => {
    const repo = repositoryFixture();
    cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
    const head = git(repo.path, ["rev-parse", "HEAD"]);
    const profile = mkdtempSync(join(tmpdir(), "zamolxis-approve-acceptance-"));
    const children: ReturnType<typeof spawn>[] = [];
    try {
      chmodSync(profile, 0o700);
      copyFileSync(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
        join(profile, "auth.json"),
      );
      chmodSync(join(profile, "auth.json"), 0o600);
      const worktree = join(repo.root, "worktree");
      git(repo.path, ["worktree", "add", "-b", "acceptance", worktree, "HEAD"]);
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
      const session = await runtime.start({
        runId: "acceptance" as AgentRunId,
        workstationId: "node" as WorkstationId,
        role: "builder",
        instruction:
          "Run exactly this shell command with escalated permissions because it needs network access: curl -sS -o /dev/null -w '%{http_code}' https://example.com . Then reply with only the HTTP status code it printed. If it is not approved, reply BLOCKED and do nothing else.",
        workspace: {
          workspaceId: "workspace" as WorkspaceId,
          cwd: realpathSync.native(worktree),
          branch: "acceptance",
          headSha: head,
        },
      });
      const seen: NormalizedRunEventDto[] = [];
      for await (const event of runtime.subscribe({ nativeSessionId: session.nativeSessionId })) {
        seen.push(event);
        if (event.type === "approval.requested")
          await runtime.resolveApproval({
            nativeSessionId: session.nativeSessionId,
            approvalId: event.payload.approvalId,
            decision: "approve",
          });
      }
      const requested = seen.filter((event) => event.type === "approval.requested");
      console.info(
        "approval acceptance",
        JSON.stringify(requested.map((event) => event.payload)),
        seen.at(-1)?.type,
      );
      expect(requested.length).toBeGreaterThan(0);
      expect(
        seen
          .filter((event) => event.type === "approval.resolved")
          .every((event) => event.payload.decision === "approved"),
      ).toBe(true);
      const last = seen.at(-1);
      expect(last?.type).toBe("run.completed");
      expect(last?.type === "run.completed" ? last.payload.summary : "").toMatch(/\b200\b/);
      expect(git(repo.path, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    }
  },
  180_000,
);
