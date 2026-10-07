import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NormalizedRunEventDto,
  SUPERVISOR_LOG_STEPS_LIMIT,
  supervisorLogStepProblem,
  traceStepProblem,
} from "@zamolxis/contracts";
import { git } from "@zamolxis/git";
import {
  FakeRuntime,
  type FakeStep,
  RuntimeRegistry,
  type StartRunInput,
} from "@zamolxis/runtime-core";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryDiscovery } from "../capabilities/repository-discovery";
import { LocalStateStore } from "../persistence/local-state";
import { RepositoryRegistry } from "../repository/repository-registry";
import { RuntimeManager } from "../runtime/runtime-manager";
import { repositoryFixture } from "../testing/git-fixture";
import type { SupervisorLogBatch } from "../trace/supervisor-log";
import { WorkspaceManager } from "../workspace/workspace-manager";
import {
  CHECKS_ONLY_SUMMARY,
  ControlPlaneDriver,
  type ControlPlaneDriverOptions,
  type ControlPlaneTransport,
  type Delivery,
  type ExecutionCommand,
  type SupervisorProgress,
  supervisorActivity,
} from "./driver";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// Plays a scenario per run and reports provider usage before completion, like Codex.
class RecordingRuntime extends FakeRuntime {
  readonly started: StartRunInput[] = [];
  constructor(scenario: (input: StartRunInput) => readonly FakeStep[]) {
    super(scenario);
  }
  override async start(input: StartRunInput) {
    this.started.push(input);
    return super.start(input);
  }
  override async *subscribe(input: { nativeSessionId: string; afterSequence?: number }) {
    for await (const event of super.subscribe(input)) {
      if (event.type === "run.completed")
        yield {
          ...event,
          eventId: `${event.eventId}:usage`,
          type: "run.usage",
          payload: { modelActual: "model-x", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        } as NormalizedRunEventDto;
      yield event;
    }
  }
}

function fixture(
  scenario: (input: StartRunInput) => readonly FakeStep[],
  setup: { runtime?: FakeRuntime; options?: ControlPlaneDriverOptions } = {},
) {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  writeFileSync(
    join(repo.path, "package.json"),
    JSON.stringify({ scripts: { lint: "biome lint", test: "vitest", "test:unit": "vitest" } }),
  );
  git(repo.path, ["add", "."]);
  git(repo.path, ["commit", "-m", "scripts"]);
  const head = git(repo.path, ["rev-parse", "HEAD"]);
  const store = new LocalStateStore(":memory:");
  cleanup.push(() => store.close());
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
    "instance",
    () => true,
  );
  // Tests that pass their own runtime do not read `started`.
  const runtime = (setup.runtime ?? new RecordingRuntime(scenario)) as RecordingRuntime;
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const manager = new RuntimeManager(store, workspaces, runtimes, "node" as never, () => true);
  const deliveries: Delivery[] = [];
  const progress: SupervisorProgress[] = [];
  const logs: SupervisorLogBatch[] = [];
  const state = { pending: [] as ExecutionCommand[] };
  const transport: ControlPlaneTransport = {
    listPending: async () => state.pending,
    claim: async () => {},
    acknowledge: async () => {},
    reconcile: async () => {},
    deliver: async (delivery) => {
      // Supervisor logs are asserted on their own.
      if (delivery.kind === "supervisor.log") {
        logs.push(delivery);
        return;
      }
      deliveries.push(delivery);
      if (delivery.kind === "command.complete" || delivery.kind === "command.failed")
        state.pending = state.pending.filter((command) => command.commandId !== delivery.commandId);
    },
    reportProgress: async (report) => {
      progress.push(report);
    },
  };
  const driver = new ControlPlaneDriver(
    store,
    workspaces,
    runtimes,
    manager,
    transport,
    "node",
    setup.options,
  );
  driver.setRepositoryDiscovery(new RepositoryDiscovery(workspaces));
  for (const workspaceId of ["plan", "build"])
    workspaces.provision({ workspaceId, repositoryLocationId: "location", baseRef: "main" });
  let counter = 0;
  const planCommand = (
    text: string,
    extra: Partial<Extract<ExecutionCommand, { type: "repository.plan" }>["payload"]> = {},
  ): Extract<ExecutionCommand, { type: "repository.plan" }> => {
    const id = `command-${++counter}`;
    return {
      commandId: id,
      idempotencyKey: id,
      workstationId: "node",
      type: "repository.plan",
      payload: { textCommandId: `text-${counter}`, workspaceId: "plan", text, ...extra },
    };
  };
  const stopCommand = (textCommandId: string): ExecutionCommand => ({
    commandId: `stop-${textCommandId}`,
    idempotencyKey: `supervisor-stop:${textCommandId}`,
    workstationId: "node",
    type: "supervisor.stop",
    payload: { textCommandId },
  });
  const plan = async (
    text: string,
    extra: Partial<Extract<ExecutionCommand, { type: "repository.plan" }>["payload"]> = {},
  ) => {
    const command = planCommand(text, extra);
    state.pending = [command];
    deliveries.length = 0;
    await driver.tick();
    return { id: command.commandId, textCommandId: command.payload.textCommandId };
  };
  return {
    repo,
    head,
    store,
    workspaces,
    runtime,
    deliveries,
    progress,
    logs,
    state,
    driver,
    plan,
    planCommand,
    stopCommand,
    transport,
  };
}
const answer = (text: string): FakeStep[] => [{ type: "success", summary: text }];
const json = (value: unknown): FakeStep[] => answer(JSON.stringify(value));

describe("repository.plan through a Supervisor run", { timeout: 30_000 }, () => {
  it("puts the Supervisor profile's owner instructions into the Supervisor prompt", async () => {
    const f = fixture(() => json({ decision: "answer", reply: "Done.", tasks: [] }));
    await f.plan("What changed?", {
      supervisor: { runtime: "fake", instructions: "Prefer answers under five sentences." },
    });
    const [started] = f.runtime.started;
    expect(started?.instruction).toContain("Owner instructions for this role");
    expect(started?.instruction).toContain("Prefer answers under five sentences.");
  });
  it("answers a question without tasks, with usage, and releases the planning workspace", async () => {
    const f = fixture(() => json({ decision: "answer", reply: "It uses **turbo**.", tasks: [] }));
    const { id, textCommandId } = await f.plan("How is the build organised?", {
      supervisor: { runtime: "fake", model: "m-1", reasoningEffort: "high" },
      conversation: [
        { role: "user", text: "Earlier question" },
        { role: "supervisor", text: "Earlier answer" },
      ],
    });
    const [started] = f.runtime.started;
    expect(started).toMatchObject({
      runId: `supervisor:${textCommandId}`,
      role: "supervisor",
      model: "m-1",
      reasoningEffort: "high",
    });
    expect(started?.workspace.cwd).toBe(f.workspaces.inspect("plan").path);
    for (const fragment of [
      "Zamolxis Supervisor",
      "User: Earlier question",
      "Supervisor: Earlier answer",
      "How is the build organised?",
      '"test:unit"',
    ])
      expect(started?.instruction).toContain(fragment);
    expect(f.deliveries).toEqual([
      {
        kind: "repository.plan",
        textCommandId,
        contextSha: f.head,
        contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        tasks: [],
        decision: "answer",
        reply: "It uses **turbo**.",
        usage: { modelActual: "model-x", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      { kind: "command.complete", commandId: id },
    ]);
    // Supervisor events are never delivered as agent-run events.
    expect(f.deliveries.some((delivery) => delivery.kind === "run.events")).toBe(false);
    expect(f.store.getWorkspaceLease("plan")).toBeUndefined();
    expect(git(f.repo.path, ["rev-parse", "HEAD"])).toBe(f.head);
    expect(git(f.repo.path, ["status", "--porcelain"])).toBe("");
  });

  it("gives an unusable plan one correction round, without the repository again", async () => {
    let call = 0;
    const f = fixture(() =>
      ++call === 1
        ? json({ decision: "delegate", reply: "Would you like a plan?", tasks: [] })
        : json({
            decision: "delegate",
            reply: "One task.",
            tasks: [{ title: "Palette", description: "Add apps/web/app/palette.tsx." }],
          }),
    );
    const { textCommandId } = await f.plan("Open this work: add a command palette");
    expect(f.runtime.started.map((run) => run.runId)).toEqual([
      `supervisor:${textCommandId}`,
      `supervisor:${textCommandId}:repair`,
    ]);
    expect(f.runtime.started[1]?.instruction).toContain("Would you like a plan?");
    expect(f.runtime.started[1]?.instruction).toContain("Do not read files");
    expect(f.deliveries[0]).toMatchObject({
      kind: "repository.plan",
      decision: "delegate",
      tasks: [{ key: "task-1", title: "Palette" }],
      // Both runs are counted.
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
    expect(f.store.getWorkspaceLease("plan")).toBeUndefined();
  });

  it("asks once more for tasks when the owner opened the work and got none", async () => {
    let call = 0;
    const f = fixture(() =>
      ++call === 1
        ? json({ decision: "answer", reply: "Here is how I'd do it. Shall I start?", tasks: [] })
        : json({
            decision: "delegate",
            reply: "Starting.",
            tasks: [{ key: "a", title: "Palette", description: "Add apps/web/app/palette.tsx." }],
          }),
    );
    const { textCommandId } = await f.plan("Open this work: add a command palette");
    expect(f.runtime.started.map((run) => run.runId)).toEqual([
      `supervisor:${textCommandId}`,
      `supervisor:${textCommandId}:repair`,
    ]);
    expect(f.runtime.started[1]?.instruction).toContain("Do not ask for confirmation");
    expect(f.deliveries[0]).toMatchObject({ decision: "delegate", tasks: [{ key: "a" }] });
    // A question is answered once: no second run.
    const g = fixture(() => json({ decision: "answer", reply: "It uses turbo.", tasks: [] }));
    await g.plan("How is the build organised?");
    expect(g.runtime.started).toHaveLength(1);
  });

  it("starts a proposal when the owner opened the work", async () => {
    const f = fixture(() =>
      json({
        decision: "propose",
        reply: "Here is a plan.",
        tasks: [{ key: "a", title: "Palette", description: "Add apps/web/app/palette.tsx." }],
      }),
    );
    await f.plan("Open this work: add a command palette");
    expect(f.deliveries[0]).toMatchObject({ decision: "delegate", tasks: [{ key: "a" }] });
    const g = fixture(() =>
      json({
        decision: "propose",
        reply: "Here is a plan.",
        tasks: [{ key: "a", title: "Palette", description: "Add apps/web/app/palette.tsx." }],
      }),
    );
    await g.plan("How would you add a command palette?");
    expect(g.deliveries[0]).toMatchObject({ decision: "propose" });
  });

  it("delivers a validated plan with repository default checks", async () => {
    const f = fixture(() =>
      answer(
        `I will do this:\n\`\`\`json\n${JSON.stringify({
          decision: "delegate",
          reply: "Two independent tasks.",
          tasks: [
            { key: "a", title: "A", description: "Do A", verificationScripts: ["test:unit"] },
            { key: "b", title: "B", description: "Do B" },
          ],
        })}\n\`\`\``,
      ),
    );
    await f.plan("Implement A and B");
    const delivery = f.deliveries[0];
    if (delivery?.kind !== "repository.plan") throw new Error("Missing plan");
    expect(delivery.decision).toBe("delegate");
    expect(delivery.reply).toBe("Two independent tasks.");
    expect(delivery.tasks).toEqual([
      {
        key: "a",
        title: "A",
        description: "Do A",
        dependencies: [],
        verificationScripts: ["test:unit"],
        requiredModalities: ["static", "test"],
      },
      {
        key: "b",
        title: "B",
        description: "Do B",
        dependencies: [],
        verificationScripts: ["lint", "test"],
        requiredModalities: ["static", "test"],
      },
    ]);
  });

  it("turns unusable Supervisor output into an answer and never plans", async () => {
    const f = fixture(() => answer("I could not decide."));
    await f.plan("Do something vague");
    expect(f.deliveries[0]).toMatchObject({
      kind: "repository.plan",
      decision: "answer",
      reply: "I could not decide.",
      tasks: [],
    });
  });

  it("uses a JSON plan typed by the user without starting a Supervisor", async () => {
    const f = fixture(() => answer("unused"));
    const tasks = [
      {
        key: "only",
        title: "Only",
        description: "Only task",
        dependencies: [],
        verificationScripts: ["test"],
        requiredModalities: ["test"],
      },
    ];
    await f.plan(JSON.stringify({ tasks }));
    expect(f.runtime.started).toEqual([]);
    expect(f.deliveries[0]).toMatchObject({
      decision: "delegate",
      reply: "Planned 1 task from the provided plan.",
      tasks,
    });
    expect(f.deliveries[0]).not.toHaveProperty("usage");
  });

  it("falls back to a registered runtime when the requested Supervisor runtime is not installed", async () => {
    const f = fixture(() => json({ decision: "ask", reply: "Which file?" }));
    await f.plan("Fix it", { supervisor: { runtime: "codex" } });
    expect(f.runtime.started).toHaveLength(1);
    expect(f.deliveries[0]).toMatchObject({ decision: "ask", reply: "Which file?", tasks: [] });
  });

  it("fails the command visibly when the Supervisor fails or cannot finish", async () => {
    const failing = fixture(() => [{ type: "failure", message: "boom" }]);
    const first = await failing.plan("Question");
    expect(failing.deliveries).toEqual([
      {
        kind: "command.failed",
        commandId: first.id,
        code: "SUPERVISOR_FAILED",
        // Who failed and why reaches the owner, not only the code.
        failure: { agent: "supervisor", runtime: "fake", reason: "boom", at: expect.any(Number) },
      },
    ]);
    expect(failing.store.getWorkspaceLease("plan")).toBeUndefined();

    const waiting = fixture(() => [{ type: "waiting", reason: "Needs approval" }]);
    const second = await waiting.plan("Question");
    expect(waiting.deliveries).toEqual([
      {
        kind: "command.failed",
        commandId: second.id,
        code: "SUPERVISOR_INCOMPLETE",
        failure: { agent: "supervisor", runtime: "fake", at: expect.any(Number) },
      },
    ]);
    expect(waiting.store.getWorkspaceLease("plan")).toBeUndefined();
    expect((await waiting.runtime.inspect(`fake:supervisor:${second.textCommandId}`)).state).toBe(
      "stopped",
    );
  });

  it("fails an interrupted plan instead of blocking the queue and frees the workspace", async () => {
    const f = fixture(() => json({ decision: "answer", reply: "unused" }));
    const command: ExecutionCommand = {
      commandId: "interrupted",
      idempotencyKey: "interrupted",
      workstationId: "node",
      type: "repository.plan",
      payload: { textCommandId: "text-x", workspaceId: "plan", text: "Question" },
    };
    f.store.recordCommand(command);
    f.store.markCommandRunning("interrupted");
    const workspace = f.workspaces.inspect("plan");
    f.workspaces.acquire("plan", "supervisor:text-x", workspace.path, workspace.branch);
    await f.driver.tick();
    expect(f.deliveries).toEqual([
      { kind: "command.failed", commandId: "interrupted", code: "SUPERVISOR_INTERRUPTED" },
    ]);
    expect(f.store.getWorkspaceLease("plan")).toBeUndefined();
    expect(f.store.listInterruptedCommands()).toEqual([]);
  });
});

it("reports a builder's bounded final message with run completion", {
  timeout: 30_000,
}, async () => {
  const f = fixture(() => answer(`  ${"r".repeat(9000)}`));
  await f.transport.listPending();
  const command: ExecutionCommand = {
    commandId: "start",
    idempotencyKey: "start",
    workstationId: "node",
    type: "runtime.start",
    payload: {
      runId: "run",
      workspaceId: "build",
      runtime: "fake",
      role: "builder",
      instruction: "Build",
    },
  };
  await f.driver.execute(command);
  const complete = f.deliveries.find((delivery) => delivery.kind === "run.complete");
  expect(complete).toMatchObject({ kind: "run.complete", runId: "run", summary: "r".repeat(8000) });
});

// Like Codex: a subscription stays open until the run is terminal or explicitly waiting.
class LiveRuntime extends FakeRuntime {
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
      await new Promise<void>((resolve) => this.#wake.push(resolve));
    }
  }
}
function runFixture(runtime: FakeRuntime, options: ControlPlaneDriverOptions = {}) {
  const repo = repositoryFixture();
  cleanup.push(() => rmSync(repo.root, { recursive: true, force: true }));
  const store = new LocalStateStore(":memory:");
  cleanup.push(() => store.close());
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
    "instance",
    () => true,
  );
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const manager = new RuntimeManager(store, workspaces, runtimes, "node" as never, () => true);
  const deliveries: Delivery[] = [];
  const state = { pending: [] as ExecutionCommand[] };
  const transport: ControlPlaneTransport = {
    listPending: async () => state.pending,
    claim: async () => {},
    acknowledge: async () => {},
    reconcile: async () => {},
    deliver: async (delivery) => {
      deliveries.push(delivery);
      if (delivery.kind === "command.complete" || delivery.kind === "command.failed")
        state.pending = state.pending.filter((command) => command.commandId !== delivery.commandId);
    },
  };
  const driver = new ControlPlaneDriver(
    store,
    workspaces,
    runtimes,
    manager,
    transport,
    "node",
    options,
  );
  workspaces.provision({ workspaceId: "build", repositoryLocationId: "location", baseRef: "main" });
  const command = <T extends ExecutionCommand["type"]>(
    id: string,
    type: T,
    payload: Extract<ExecutionCommand, { type: T }>["payload"],
  ) =>
    ({ commandId: id, idempotencyKey: id, workstationId: "node", type, payload }) as Extract<
      ExecutionCommand,
      { type: T }
    >;
  const start = command("start", "runtime.start", {
    runId: "run",
    workspaceId: "build",
    runtime: "fake",
    role: "builder",
    instruction: "Build",
  });
  const events = () =>
    deliveries.flatMap((delivery) => (delivery.kind === "run.events" ? delivery.events : []));
  const until = async (check: () => boolean) => {
    for (let attempt = 0; !check() && attempt < 400; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };
  return { store, workspaces, deliveries, driver, state, command, start, events, until };
}

describe("approvals and messages", { timeout: 30_000 }, () => {
  it("delivers an approval while the run streams and resolves it through the control loop", async () => {
    const f = runFixture(
      new LiveRuntime([
        { type: "approval", kind: "command", summary: "Run: pnpm install", risk: "high" },
        { type: "success", summary: "Installed and built" },
      ]),
    );
    const streaming = f.driver.execute(f.start);
    // The approval reaches the backend immediately, before the run pauses.
    await f.until(() => f.events().some((event) => event.type === "approval.requested"));
    expect(f.deliveries.some((delivery) => delivery.kind === "command.complete")).toBe(false);
    f.state.pending = [
      f.command("message", "runtime.send", { runId: "run", message: "Use the lockfile" }),
      f.command("approve", "runtime.approval", {
        runId: "run",
        approvalId: "run:fake-0",
        decision: "approve",
      }),
    ];
    await f.driver.control();
    await streaming;
    expect(f.state.pending).toEqual([]);
    expect(f.events().map((event) => event.type)).toEqual([
      "run.started",
      "approval.requested",
      "run.activity",
      "approval.resolved",
      "run.completed",
    ]);
    expect(f.deliveries.filter((delivery) => delivery.kind === "command.complete")).toEqual([
      { kind: "command.complete", commandId: "message" },
      { kind: "command.complete", commandId: "approve" },
      { kind: "command.complete", commandId: "start" },
    ]);
    expect(f.deliveries.find((delivery) => delivery.kind === "run.complete")).toMatchObject({
      runId: "run",
      summary: "Installed and built",
    });
    expect(f.store.getWorkspaceLease("build")).toBeUndefined();
  });

  it("uploads proof images before completion and keeps them out of the candidate", async () => {
    const proofRoot = mkdtempSync(join(tmpdir(), "zam-proof-"));
    cleanup.push(() => rmSync(proofRoot, { recursive: true, force: true }));
    const f = runFixture(
      new FakeRuntime([
        { type: "waiting", reason: "Draw it" },
        { type: "success", summary: "New logo" },
      ]),
      { proofRoot },
    );
    await f.driver.execute(f.start);
    const workspace = f.workspaces.inspect("build");
    mkdirSync(join(workspace.path, ".zamolxis-proof"));
    writeFileSync(join(workspace.path, ".zamolxis-proof", "preview.png"), "png-bytes");
    writeFileSync(join(workspace.path, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    f.deliveries.length = 0;
    f.state.pending = [f.command("send", "runtime.send", { runId: "run", message: "go" })];
    await f.driver.control();
    await f.driver.idle();
    const kinds = f.deliveries.map((delivery) => delivery.kind);
    expect(kinds.indexOf("run.proof")).toBeLessThan(kinds.indexOf("run.complete"));
    const proof = f.deliveries.find((delivery) => delivery.kind === "run.proof");
    expect(
      proof?.kind === "run.proof" && proof.files.map((file) => [file.name, file.source]),
    ).toEqual([
      ["preview.png", "proof"],
      ["logo.svg", "changed"],
    ]);
    const complete = f.deliveries.find((delivery) => delivery.kind === "run.complete");
    const head = complete?.kind === "run.complete" ? complete.headSha : "";
    expect(git(workspace.path, ["show", "--name-only", "--format=", head])).toBe("logo.svg");
    expect(complete).toMatchObject({ dirty: false });
  });

  it("continues a waiting run after a message and completes it like a start", async () => {
    const f = runFixture(
      new FakeRuntime([
        { type: "waiting", reason: "Which file?" },
        { type: "success", summary: "Edited README" },
      ]),
    );
    await f.driver.execute(f.start);
    expect(f.deliveries.some((delivery) => delivery.kind === "run.complete")).toBe(false);
    expect(f.store.getWorkspaceLease("build")?.runId).toBe("run");
    const workspace = f.workspaces.inspect("build");
    writeFileSync(join(workspace.path, "README.md"), "edited\n");
    f.deliveries.length = 0;
    f.state.pending = [f.command("send", "runtime.send", { runId: "run", message: "README" })];
    await f.driver.control();
    await f.driver.idle();
    expect(f.events().map((event) => event.type)).toEqual(["run.activity", "run.completed"]);
    const complete = f.deliveries.find((delivery) => delivery.kind === "run.complete");
    expect(complete).toMatchObject({ runId: "run", summary: "Edited README", dirty: false });
    // The builder candidate is committed exactly as after a start.
    expect(complete?.kind === "run.complete" && complete.headSha).not.toBe(workspace.baseSha);
    expect(f.deliveries.at(-1)).toEqual({ kind: "command.complete", commandId: "send" });
    expect(f.store.getWorkspaceLease("build")).toBeUndefined();
  });

  it("continues a run parked on an approval when tick delivers the decision", async () => {
    const f = runFixture(
      new FakeRuntime([
        { type: "approval", kind: "fileChange", summary: "Change files: a.ts", risk: "medium" },
        { type: "success", summary: "Done" },
      ]),
    );
    await f.driver.execute(f.start);
    f.state.pending = [
      f.command("reject", "runtime.approval", {
        runId: "run",
        approvalId: "run:fake-0",
        decision: "reject",
      }),
    ];
    await f.driver.tick();
    expect(f.events().map((event) => [event.type, event.payload])).toContainEqual([
      "approval.resolved",
      { approvalId: "run:fake-0", decision: "rejected", reason: "user" },
    ]);
    expect(f.deliveries.find((delivery) => delivery.kind === "run.complete")).toMatchObject({
      summary: "Done",
    });
    // A second decision once the run ended fails visibly.
    f.state.pending = [
      f.command("again", "runtime.approval", {
        runId: "run",
        approvalId: "run:fake-0",
        decision: "approve",
      }),
    ];
    await f.driver.tick();
    expect(f.deliveries.at(-1)).toEqual({
      kind: "command.failed",
      commandId: "again",
      code: "RUN_NOT_ACTIVE",
    });
  });

  it("rejects pending approvals on stop and fails an unknown approval", async () => {
    const f = runFixture(
      new LiveRuntime([
        { type: "approval", kind: "command", summary: "Run: rm -rf dist", risk: "high" },
        { type: "success", summary: "unused" },
      ]),
    );
    const streaming = f.driver.execute(f.start);
    await f.until(() => f.events().some((event) => event.type === "approval.requested"));
    f.state.pending = [
      f.command("unknown", "runtime.approval", {
        runId: "run",
        approvalId: "run:other",
        decision: "approve",
      }),
      f.command("stop", "runtime.stop", { runId: "run" }),
    ];
    await f.driver.control();
    await streaming;
    expect(f.deliveries).toContainEqual({
      kind: "command.failed",
      commandId: "unknown",
      code: "APPROVAL_NOT_PENDING",
    });
    expect(
      f
        .events()
        .map((event) => [event.type, event.payload])
        .slice(-2),
    ).toEqual([
      ["approval.resolved", { approvalId: "run:fake-0", decision: "rejected", reason: "stopped" }],
      ["run.stopped", { reason: "Stop requested" }],
    ]);
  });

  it("fails an interrupted message instead of blocking the queue", async () => {
    const f = runFixture(new FakeRuntime());
    const send = f.command("lost", "runtime.send", { runId: "run", message: "Hi" });
    f.store.recordCommand(send);
    f.store.markCommandRunning("lost");
    await f.driver.tick();
    expect(f.deliveries).toEqual([
      { kind: "command.failed", commandId: "lost", code: "RUNTIME_COMMAND_INTERRUPTED" },
    ]);
  });
});

it("rejects Supervisor approval requests: nobody can approve a Node-local read-only run", {
  timeout: 30_000,
}, async () => {
  const f = fixture(() => [
    { type: "approval", kind: "command", summary: "Run: curl x", risk: "high" },
    ...json({ decision: "answer", reply: "Answered without it", tasks: [] }),
  ]);
  const { textCommandId } = await f.plan("Question");
  expect(f.deliveries[0]).toMatchObject({ decision: "answer", reply: "Answered without it" });
  const resolved: unknown[] = [];
  for await (const event of f.runtime.subscribe({
    nativeSessionId: `fake:supervisor:${textCommandId}`,
  }))
    if (event.type === "approval.resolved") resolved.push(event.payload);
  expect(resolved).toEqual([
    { approvalId: `supervisor:${textCommandId}:fake-0`, decision: "rejected", reason: "user" },
  ]);
});

describe("Supervisor activity log", { timeout: 30_000 }, () => {
  it("records phases, tools, files read, notes, refused approvals, usage and the decision", async () => {
    const f = fixture(() => [
      { type: "activity", label: "Thinking" },
      { type: "activity", label: "Thinking" },
      {
        type: "tool",
        tool: "command",
        summary: "GITHUB_TOKEN=*** cat convex/schema.ts",
        reads: ["convex/schema.ts"],
      },
      { type: "tool", tool: "command", summary: "pnpm missing · exit code 1", success: false },
      { type: "message", text: "Schema read; checking the API next." },
      { type: "approval", kind: "command", summary: "Run: curl https://example.com", risk: "high" },
      ...json({
        decision: "delegate",
        reply: "Two tasks.",
        tasks: [
          { key: "a", title: "Add field", description: "d" },
          { key: "b", title: "Show field", description: "d", dependencies: ["a"] },
        ],
      }),
    ]);
    const { id, textCommandId } = await f.plan("Add a field", {
      supervisor: { runtime: "fake", model: "m-1", reasoningEffort: "high" },
    });
    expect(f.deliveries[0]).toMatchObject({ kind: "repository.plan", decision: "delegate" });
    expect(f.logs).toHaveLength(1);
    const [log] = f.logs;
    expect(log?.textCommandId).toBe(textCommandId);
    const steps = log?.steps ?? [];
    for (const step of steps) expect(supervisorLogStepProblem(step)).toBeUndefined();
    expect(steps.map((step) => [step.kind, step.label, step.status])).toEqual([
      ["discovery", "Repository discovered", "passed"],
      ["supervisor", "Supervisor finished", "passed"],
      ["phase", "Thinking", "passed"],
      ["tool", "GITHUB_TOKEN=*** cat convex/schema.ts", "passed"],
      ["tool", "pnpm missing · exit code 1", "failed"],
      ["message", "Note", "passed"],
      ["approval", "Approval request refused", "failed"],
      ["supervisor", "Opened 2 tasks", "passed"],
    ]);
    expect(steps[0]?.references).toEqual({ sha: f.head });
    expect(steps[1]?.detail).toBe(
      "Test runtime · model m-1 · reasoning high · reported model model-x\n15 tokens processed (10 in · 5 out)",
    );
    expect(steps[3]?.detail).toBe("Read convex/schema.ts");
    expect(steps[5]?.detail).toBe("Schema read; checking the API next.");
    expect(steps[6]?.detail).toContain("Run: curl https://example.com");
    expect(steps[7]?.detail).toBe("1. Add field\n2. Show field");
    // Stable ids scoped by the plan command: a replayed batch is a no-op on the backend.
    expect(steps.every((step) => step.stepId.startsWith(`${id}:`))).toBe(true);
    expect(new Set(steps.map((step) => step.stepId)).size).toBe(steps.length);
    // The log is delivered before the plan outcome, through the durable outbox.
    expect(f.store.listPendingEvents(100, "control-plane.delivery")).toEqual([]);
  });
  it("logs a stopped or failed Supervisor with its failure code", async () => {
    const failing = fixture(() => [
      { type: "message", text: "Starting with PASSWORD=hunter2" },
      { type: "failure", message: "boom" },
    ]);
    await failing.plan("Question");
    const steps = failing.logs.flatMap((log) => log.steps);
    expect(steps.map((step) => [step.kind, step.label, step.status])).toEqual([
      ["discovery", "Repository discovered", "passed"],
      ["supervisor", "Supervisor failed", "failed"],
      ["message", "Note", "passed"],
      ["message", "Model error", "failed"],
      ["supervisor", "No answer", "failed"],
    ]);
    // The Node redacts again whatever the adapter reported.
    expect(steps[2]?.detail).toBe("Starting with PASSWORD=***");
    // The provider's reason is its own step, so the owner sees why it failed.
    expect(steps[3]?.detail).toBe("boom");
    expect(steps[4]?.detail).toBe("Failure: SUPERVISOR_FAILED");
  });
  it("keeps the log bounded and says how many later steps were not recorded", async () => {
    const tools: FakeStep[] = Array.from({ length: 400 }, (_, index) => ({
      type: "tool",
      tool: "command",
      summary: `rg pattern-${index}`,
    }));
    const f = fixture(() => [...tools, ...json({ decision: "answer", reply: "Done", tasks: [] })]);
    await f.plan("Search everything");
    const steps = f.logs.flatMap((log) => log.steps);
    expect(steps).toHaveLength(SUPERVISOR_LOG_STEPS_LIMIT);
    expect(f.logs.map((log) => log.steps.length)).toEqual([100, 100, 100]);
    expect(steps.at(-1)).toMatchObject({ kind: "supervisor", label: "Answered" });
    expect(steps[1]?.detail).toContain("103 later steps not recorded");
  });
});

describe("Supervisor progress and stop", { timeout: 30_000 }, () => {
  it("describes activities and tool calls in one bounded line", () => {
    const base = {
      eventId: "e",
      sequence: 1,
      runId: "run",
      workspaceId: "w",
      workstationId: "node",
      occurredAt: 0,
    };
    expect(
      supervisorActivity({
        ...base,
        type: "run.activity",
        payload: { label: "  Reading\n convex/schema.ts " },
      } as NormalizedRunEventDto),
    ).toBe("Reading convex/schema.ts");
    expect(
      supervisorActivity({
        ...base,
        type: "tool.started",
        payload: { tool: "shell", summary: `Running rg ${"x".repeat(300)}` },
      } as NormalizedRunEventDto),
    ).toHaveLength(200);
    expect(
      supervisorActivity({
        ...base,
        type: "tool.started",
        payload: { tool: "shell", summary: "" },
      } as NormalizedRunEventDto),
    ).toBe("shell");
    expect(
      supervisorActivity({
        ...base,
        type: "run.usage",
        payload: { totalTokens: 1 },
      } as NormalizedRunEventDto),
    ).toBeUndefined();
  });

  it("reports progress on change, at most once per interval, and never as run events", async () => {
    const clock = { now: 0 };
    // Each event takes 700 ms of (injected) time.
    class SlowRuntime extends RecordingRuntime {
      override async *subscribe(input: { nativeSessionId: string; afterSequence?: number }) {
        for await (const event of super.subscribe(input)) {
          clock.now += 700;
          yield event;
        }
      }
    }
    const scenario = () => [
      { type: "activity" as const, label: "Reading a.ts" },
      { type: "activity" as const, label: "Running rg TODO" },
      { type: "activity" as const, label: "Reading b.ts" },
      { type: "activity" as const, label: "Reading c.ts" },
      ...json({ decision: "answer", reply: "Done.", tasks: [] }),
    ];
    const f = fixture(scenario, {
      runtime: new SlowRuntime(scenario),
      options: { now: () => clock.now, progressIntervalMs: 2000 },
    });
    const { id, textCommandId } = await f.plan("Question");
    // Start at t=0 is sent; a.ts (1400) is throttled; rg (2100) is sent; b.ts (2800) is
    // replaced by c.ts (3500), sent with the usage at 4200; nothing after the outcome.
    expect(f.progress).toEqual([
      { textCommandId },
      { textCommandId, activity: "Running rg TODO" },
      {
        textCommandId,
        activity: "Reading c.ts",
        usage: { modelActual: "model-x", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    ]);
    expect(f.deliveries.map((delivery) => delivery.kind)).toEqual([
      "repository.plan",
      "command.complete",
    ]);
    expect(f.deliveries[1]).toEqual({ kind: "command.complete", commandId: id });
  });

  it("keeps planning when progress cannot be reported", async () => {
    const f = fixture(() => json({ decision: "answer", reply: "Still answered.", tasks: [] }));
    f.transport.reportProgress = async () => {
      throw new Error("offline");
    };
    await f.plan("Question");
    expect(f.deliveries[0]).toMatchObject({ decision: "answer", reply: "Still answered." });
  });

  it("stops a streaming Supervisor through the control loop and fails the plan as stopped", async () => {
    const runtime = new LiveRuntime([{ type: "activity", label: "Reading convex/schema.ts" }]);
    const f = fixture(() => [], { runtime, options: { progressIntervalMs: 0 } });
    const command = f.planCommand("Long question");
    const { textCommandId } = command.payload;
    f.state.pending = [command];
    const ticking = f.driver.tick();
    for (let attempt = 0; attempt < 400; attempt++) {
      if (f.progress.some((report) => report.activity === "Reading convex/schema.ts")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(f.progress.at(-1)).toEqual({ textCommandId, activity: "Reading convex/schema.ts" });
    const stop = f.stopCommand(textCommandId);
    f.state.pending = [...f.state.pending, stop];
    await f.driver.control();
    await ticking;
    expect(f.deliveries).toEqual([
      { kind: "command.complete", commandId: stop.commandId },
      {
        kind: "command.failed",
        commandId: command.commandId,
        code: "SUPERVISOR_STOPPED",
        failure: { agent: "supervisor", runtime: "fake", at: expect.any(Number) },
      },
    ]);
    expect(f.state.pending).toEqual([]);
    // What it did before the stop stays visible.
    const logged = f.logs.flatMap((log) => log.steps);
    expect(logged.map((step) => step.label)).toContain("Reading convex/schema.ts");
    expect(logged.at(-1)).toMatchObject({ label: "Stopped before answering", status: "failed" });
    expect((await runtime.inspect(`fake:supervisor:${textCommandId}`)).state).toBe("stopped");
    expect(f.store.getWorkspaceLease("plan")).toBeUndefined();
    expect(git(f.repo.path, ["rev-parse", "HEAD"])).toBe(f.head);
    expect(git(f.repo.path, ["status", "--porcelain"])).toBe("");
  });

  it("stops a Supervisor whose session is still starting when the stop arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starting = false;
    class SlowStart extends LiveRuntime {
      override async start(input: StartRunInput) {
        starting = true;
        await gate;
        return super.start(input);
      }
    }
    const runtime = new SlowStart([{ type: "activity", label: "Reading" }]);
    const f = fixture(() => [], { runtime });
    const command = f.planCommand("Question");
    f.state.pending = [command];
    const ticking = f.driver.tick();
    for (let attempt = 0; !starting && attempt < 400; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const stop = f.stopCommand(command.payload.textCommandId);
    f.state.pending = [...f.state.pending, stop];
    await f.driver.control();
    release();
    await ticking;
    expect(f.deliveries).toEqual([
      { kind: "command.complete", commandId: stop.commandId },
      {
        kind: "command.failed",
        commandId: command.commandId,
        code: "SUPERVISOR_STOPPED",
        failure: { agent: "supervisor", runtime: "fake", at: expect.any(Number) },
      },
    ]);
    expect(f.store.getWorkspaceLease("plan")).toBeUndefined();
  });

  it("treats a stop after the Supervisor finished as a no-op", async () => {
    const f = fixture(() => json({ decision: "answer", reply: "Already answered.", tasks: [] }));
    const { textCommandId } = await f.plan("Question");
    expect(f.deliveries[0]).toMatchObject({ decision: "answer", reply: "Already answered." });
    const stop = f.stopCommand(textCommandId);
    f.state.pending = [stop];
    f.deliveries.length = 0;
    // The control loop leaves it alone: nothing here is planning that text command.
    await f.driver.control();
    expect(f.deliveries).toEqual([]);
    await f.driver.tick();
    expect(f.deliveries).toEqual([{ kind: "command.complete", commandId: stop.commandId }]);
    expect(f.runtime.started).toHaveLength(1);
  });

  it("completes a stop interrupted by a restart instead of blocking the queue", async () => {
    const f = fixture(() => answer("unused"));
    const stop = f.stopCommand("text-x");
    f.store.recordCommand(stop);
    f.store.markCommandRunning(stop.commandId);
    await f.driver.tick();
    expect(f.deliveries).toEqual([{ kind: "command.complete", commandId: stop.commandId }]);
    expect(f.store.listInterruptedCommands()).toEqual([]);
  });
});

describe("execution trace", { timeout: 30_000 }, () => {
  const start = (
    id: string,
    workspaceId: string,
    role: "builder" | "verifier",
    verificationScripts?: string[],
  ): ExecutionCommand => ({
    commandId: id,
    idempotencyKey: `start:${id}`,
    workstationId: "node",
    type: "runtime.start",
    payload: {
      runId: `run-${id}`,
      workspaceId,
      runtime: "fake",
      role,
      instruction: "Work",
      ...(verificationScripts
        ? { verificationScripts, requiredModalities: ["static", "test"] }
        : {}),
    },
  });
  const traced = (deliveries: readonly Delivery[], runId: string) =>
    deliveries.flatMap((delivery) =>
      delivery.kind === "run.trace" && delivery.runId === runId ? delivery.steps : [],
    );

  it("records a builder and an independent verifier run as ordered, bounded steps", async () => {
    const f = fixture(() => answer("done"));
    const build = f.workspaces.inspect("build");
    writeFileSync(join(build.path, "feature.txt"), "feature\n");
    await f.driver.execute(start("b", "build", "builder"));
    const candidate = f.workspaces.inspect("build").headSha;
    expect(candidate).not.toBe(build.baseSha);
    const builder = traced(f.deliveries, "run-b");
    expect(builder.map((step) => [step.stepId, step.kind, step.status])).toEqual([
      ["b:discovery", "discovery", "passed"],
      ["b:workspace", "workspace", "passed"],
      ["run:run-b:runtime", "runtime", "started"],
      ["run:run-b:runtime", "runtime", "passed"],
      ["b:candidate", "workspace", "passed"],
    ]);
    expect(builder[0]).toMatchObject({
      label: "Repository discovered",
      references: { sha: build.baseSha },
    });
    expect(builder[0]?.detail).toMatch(/^\d+ sources?, \d+ capabilit/);
    expect(builder[4]).toMatchObject({
      label: "Candidate committed",
      references: { sha: candidate },
    });
    // The runtime step keeps its start time when it is settled.
    expect(builder[3]?.startedAt).toBe(builder[2]?.startedAt);
    expect(builder[3]?.finishedAt).toBeGreaterThanOrEqual(builder[3]?.startedAt ?? 0);

    // The verifier checks another workspace's committed snapshot with repository scripts.
    const plan = f.workspaces.inspect("plan").path;
    writeFileSync(
      join(plan, "package.json"),
      JSON.stringify({
        scripts: {
          "check:ok": "node -e \"console.log('all good')\"",
          "check:fail":
            "node -e \"console.log('x'.repeat(3000));console.error('API_TOKEN=supersecretvalue123');process.exit(3)\"",
        },
      }),
    );
    git(plan, ["add", "."]);
    git(plan, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "checks"]);
    const subject = git(plan, ["rev-parse", "HEAD"]);
    f.deliveries.length = 0;
    await f.driver.execute(start("v", "plan", "verifier", ["check:ok", "check:fail", "nope"]));
    const verifier = traced(f.deliveries, "run-v");
    expect(verifier.map((step) => [step.kind, step.status])).toEqual([
      ["discovery", "passed"],
      ["workspace", "passed"],
      ["runtime", "started"],
      ["runtime", "passed"],
      ["verification-check", "passed"],
      ["verification-check", "passed"],
      ["verification-check", "failed"],
      ["verification-check", "failed"],
    ]);
    const checks = verifier.filter((step) => step.kind === "verification-check");
    expect(checks.map((step) => step.label)).toEqual([
      "git diff --check HEAD^ HEAD",
      "npm run check:ok",
      "npm run check:fail",
      "npm run nope",
    ]);
    expect(checks[1]).toMatchObject({
      stepId: "v:check:001",
      references: { script: "check:ok", exitCode: 0, sha: subject },
      detail: expect.stringContaining("all good"),
    });
    expect(checks[2]?.references).toEqual({ script: "check:fail", exitCode: 3, sha: subject });
    expect(checks[2]?.detail?.length).toBeLessThanOrEqual(1000);
    expect(checks[2]?.detail).toContain("API_TOKEN=***");
    expect(checks[2]?.detail).not.toContain("supersecretvalue123");
    expect(checks[3]).toMatchObject({
      references: { script: "nope", sha: subject },
      detail: "Not run: the script is not defined in package.json.",
    });
    for (const step of [...builder, ...verifier]) expect(traceStepProblem(step)).toBeUndefined();
    // Everything left the durable outbox.
    expect(f.store.listPendingEvents()).toEqual([]);
  });

  it("verifies with the repository checks only, starting no runtime, when the run says so", async () => {
    const f = fixture(() => {
      throw new Error("RUNTIME_MUST_NOT_START");
    });
    const plan = f.workspaces.inspect("plan").path;
    writeFileSync(
      join(plan, "package.json"),
      JSON.stringify({ scripts: { test: "node -e \"console.log('checked')\"" } }),
    );
    git(plan, ["add", "."]);
    git(plan, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "checks"]);
    const subject = git(plan, ["rev-parse", "HEAD"]);
    const command = start("c", "plan", "verifier", ["test"]);
    await f.driver.execute({
      ...command,
      payload: { ...command.payload, checksOnly: true },
    } as ExecutionCommand);
    // The Node reports the run's start and end itself; there is no native session.
    const events = f.deliveries.flatMap((delivery) =>
      delivery.kind === "run.events" && delivery.runId === "run-c" ? delivery.events : [],
    );
    expect(events.map((event) => [event.eventId, event.sequence, event.type])).toEqual([
      ["checks:run-c:1", 1, "run.started"],
      ["checks:run-c:2", 2, "run.completed"],
    ]);
    expect(events[1]?.payload).toEqual({ summary: CHECKS_ONLY_SUMMARY });
    expect(f.store.getRuntimeSession("run-c")).toBeUndefined();
    const complete = f.deliveries.find(
      (delivery) => delivery.kind === "run.complete" && delivery.runId === "run-c",
    );
    expect(complete).toMatchObject({
      headSha: subject,
      dirty: false,
      summary: CHECKS_ONLY_SUMMARY,
      evidence: [
        { modality: "static", result: "passed" },
        { modality: "test", result: "passed", summary: "npm run test: passed" },
      ],
    });
    const steps = traced(f.deliveries, "run-c");
    expect(steps.map((step) => [step.kind, step.status])).toEqual([
      ["discovery", "passed"],
      ["workspace", "passed"],
      ["verification-check", "passed"],
      ["verification-check", "passed"],
    ]);
    expect(steps[3]).toMatchObject({
      label: "npm run test",
      references: { script: "test", exitCode: 0, sha: subject },
    });
    for (const step of steps) expect(traceStepProblem(step)).toBeUndefined();
    expect(f.store.listPendingEvents()).toEqual([]);
  });
});
