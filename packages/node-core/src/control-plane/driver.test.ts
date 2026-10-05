import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRunEventDto } from "@zamolxis/contracts";
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

function fixture(scenario: (input: StartRunInput) => readonly FakeStep[]) {
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
  const runtime = new RecordingRuntime(scenario);
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const manager = new RuntimeManager(store, workspaces, runtimes, "node" as never, () => true);
  const deliveries: Delivery[] = [];
  let pending: ExecutionCommand[] = [];
  const transport: ControlPlaneTransport = {
    listPending: async () => pending,
    claim: async () => {},
    acknowledge: async () => {},
    reconcile: async () => {},
    deliver: async (delivery) => {
      deliveries.push(delivery);
      if (delivery.kind === "command.complete" || delivery.kind === "command.failed")
        pending = pending.filter((command) => command.commandId !== delivery.commandId);
    },
  };
  const driver = new ControlPlaneDriver(store, workspaces, runtimes, manager, transport, "node");
  driver.setRepositoryDiscovery(new RepositoryDiscovery(workspaces));
  for (const workspaceId of ["plan", "build"])
    workspaces.provision({ workspaceId, repositoryLocationId: "location", baseRef: "main" });
  let counter = 0;
  const plan = async (
    text: string,
    extra: Partial<Extract<ExecutionCommand, { type: "repository.plan" }>["payload"]> = {},
  ) => {
    const id = `command-${++counter}`;
    pending = [
      {
        commandId: id,
        idempotencyKey: id,
        workstationId: "node",
        type: "repository.plan",
        payload: { textCommandId: `text-${counter}`, workspaceId: "plan", text, ...extra },
      },
    ];
    deliveries.length = 0;
    await driver.tick();
    return { id, textCommandId: `text-${counter}` };
  };
  return { repo, head, store, workspaces, runtime, deliveries, driver, plan, transport };
}
const answer = (text: string): FakeStep[] => [{ type: "success", summary: text }];
const json = (value: unknown): FakeStep[] => answer(JSON.stringify(value));

describe("repository.plan through a Supervisor run", { timeout: 30_000 }, () => {
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

  it("delivers a validated plan with repository default checks", async () => {
    const f = fixture(() =>
      answer(
        `I will do this:\n\`\`\`json\n${JSON.stringify({
          decision: "plan",
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
    expect(delivery.decision).toBe("plan");
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
      decision: "plan",
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
      { kind: "command.failed", commandId: first.id, code: "SUPERVISOR_FAILED" },
    ]);
    expect(failing.store.getWorkspaceLease("plan")).toBeUndefined();

    const waiting = fixture(() => [{ type: "waiting", reason: "Needs approval" }]);
    const second = await waiting.plan("Question");
    expect(waiting.deliveries).toEqual([
      { kind: "command.failed", commandId: second.id, code: "SUPERVISOR_INCOMPLETE" },
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
