import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./supervisor.ts": () => import("../convex/supervisor"),
  "./profiles.ts": () => import("../convex/profiles"),
  "./workstations.ts": () => import("../convex/workstations"),
  "./repositories.ts": () => import("../convex/repositories"),
  "./sessions.ts": () => import("../convex/sessions"),
  "./tasks.ts": () => import("../convex/tasks"),
  "./workspaces.ts": () => import("../convex/workspaces"),
  "./runs.ts": () => import("../convex/runs"),
  "./events.ts": () => import("../convex/events"),
  "./node.ts": () => import("../convex/node"),
  "./trust.ts": () => import("../convex/trust"),
};

const SHA = "base";
const DIGEST = "a".repeat(64);

async function fixture() {
  const t = convexTest(schema, modules);
  const { user } = await seedHuman(t, "alice");
  const { user: other } = await seedHuman(t, "bob");
  await user.mutation(api.profiles.ensure, {});
  await other.mutation(api.profiles.ensure, {});
  const workstationId = await user.mutation(api.workstations.register, {
    name: "Node",
    nodeAuthSubject: "device",
  });
  const node = t.withIdentity({
    subject: "device",
    tokenIdentifier: "device",
    ownerSubject: "alice",
  });
  await node.mutation(api.node.heartbeat, {
    workstationId,
    instanceId: "instance",
    runtimeCapabilities: [{ runtime: "codex", capabilities: ["start", "stop"] }],
  });
  const repositoryId = await user.mutation(api.repositories.create, { name: "Repo" });
  await node.mutation(api.node.registerLocation, {
    workstationId,
    repositoryId,
    canonicalPath: "/canonical",
    gitCommonDir: "/canonical/.git",
    headSha: SHA,
  });
  const productId = await t.run(async (ctx) => {
    const repository = await ctx.db.get("repositories", repositoryId);
    const productId = await ctx.db.insert("products", {
      ownerId: repository!.ownerId,
      name: "Product",
      slug: "product",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", repositoryId, { productId });
    return productId;
  });
  let counter = 0;
  const submit = (text: string, sessionId?: Id<"workSessions">) =>
    user.mutation(api.supervisor.submit, {
      productId,
      repositoryId,
      text,
      idempotencyKey: `message-${++counter}`,
      ...(sessionId ? { sessionId } : {}),
    });
  // Provision pending workspaces and return the newest pending plan command.
  const provision = async () => {
    for (const command of await node.query(api.node.listPending, { workstationId })) {
      if (command.type !== "workspace.provision") continue;
      await node.mutation(api.node.claim, {
        workstationId,
        commandId: command._id,
        instanceId: "instance",
      });
      await node.mutation(api.node.markReady, {
        workstationId,
        workspaceId: command.targetId as Id<"workspaces">,
        commandId: command._id,
        localPath: `/isolated/${command._id}`,
        baseSha: SHA,
        headSha: SHA,
        branchName: `branch-${command._id}`,
      });
      await node.mutation(api.node.completeCommand, {
        workstationId,
        commandId: command._id,
        instanceId: "instance",
      });
    }
  };
  const planCommand = async () => {
    await provision();
    const pending = (await node.query(api.node.listPending, { workstationId })).filter(
      (command) => command.type === "repository.plan",
    );
    const command = pending[pending.length - 1];
    if (!command) throw new Error("Missing plan command");
    return command;
  };
  const accept = async (extra: Record<string, unknown>, tasks: unknown[] = []) => {
    const command = await planCommand();
    const args = {
      workstationId,
      textCommandId: command.targetId as Id<"textCommands">,
      contextSha: SHA,
      contextDigest: DIGEST,
      tasks,
      ...extra,
    } as Parameters<typeof node.mutation<typeof api.supervisor.acceptPlan>>[1];
    await node.mutation(api.supervisor.acceptPlan, args);
    return { command, args };
  };
  const settlePlan = async (commandId: Id<"commands">) => {
    await node.mutation(api.node.claim, { workstationId, commandId, instanceId: "instance" });
    await node.mutation(api.node.completeCommand, {
      workstationId,
      commandId,
      instanceId: "instance",
    });
  };
  return {
    t,
    user,
    other,
    node,
    workstationId,
    repositoryId,
    productId,
    submit,
    provision,
    planCommand,
    accept,
    settlePlan,
  };
}

const task = (key: string, dependencies: string[] = []) => ({
  key,
  title: `Task ${key}`,
  description: `Do ${key}`,
  dependencies,
  verificationScripts: ["test"],
  requiredModalities: ["test"],
});

it("enqueues repository.plan with the resolved Supervisor and prior conversation", async () => {
  const f = await fixture();
  const sessionId = await f.submit("What does this repository do?");
  const first = await f.planCommand();
  expect(first.payload).toMatchObject({
    text: "What does this repository do?",
    supervisor: { runtime: "codex" },
    conversation: [],
  });
  expect(first.payload.supervisor).toEqual({ runtime: "codex" });
  await f.accept({ decision: "answer", reply: "It is a control plane." });
  await f.settlePlan(first._id);

  await f.user.mutation(api.agentProfiles.upsert, {
    productId: f.productId,
    name: "Supervisor",
    role: "supervisor",
    runtime: "claude",
    model: "opus",
    reasoningEffort: "high",
    enabled: true,
  });
  await f.submit("x".repeat(5000), sessionId);
  const second = await f.planCommand();
  expect(second.payload.supervisor).toEqual({
    runtime: "claude",
    model: "opus",
    reasoningEffort: "high",
  });
  expect(second.payload.conversation).toEqual([
    { role: "user", text: "What does this repository do?" },
    { role: "supervisor", text: "It is a control plane." },
  ]);
  await f.accept({ decision: "ask", reply: "Which part?" });
  await f.settlePlan(second._id);

  await f.submit("Third", sessionId);
  const third = await f.planCommand();
  const conversation = third.payload.conversation as Array<{ role: string; text: string }>;
  expect(conversation).toHaveLength(4);
  expect(conversation[2]).toEqual({ role: "user", text: "x".repeat(4000) });
  expect(conversation[3]).toEqual({ role: "supervisor", text: "Which part?" });
});

it("keeps only the last 20 conversation entries", async () => {
  const f = await fixture();
  const sessionId = await f.submit("m0");
  let command = await f.planCommand();
  await f.accept({ decision: "answer", reply: "r0" });
  await f.settlePlan(command._id);
  for (let i = 1; i <= 11; i++) {
    await f.submit(`m${i}`, sessionId);
    command = await f.planCommand();
    if (i < 11) {
      await f.accept({ decision: "answer", reply: `r${i}` });
      await f.settlePlan(command._id);
    }
  }
  const conversation = command.payload.conversation as Array<{ role: string; text: string }>;
  expect(conversation).toHaveLength(20);
  expect(conversation[0]).toEqual({ role: "user", text: "m1" });
  expect(conversation[19]).toEqual({ role: "supervisor", text: "r10" });
});

it("stores an answer without tasks and idles the Session", async () => {
  const f = await fixture();
  const sessionId = await f.submit("Hello");
  const { args } = await f.accept({
    decision: "answer",
    reply: "Hi, how can I help?",
    usage: {
      modelActual: "gpt-5-codex",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 120,
    },
  });
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toEqual([]);
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("waiting");
  expect(session.needsInputCount).toBe(0);
  expect(session.totalTaskCount).toBe(0);
  const messages = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    text: "Hello",
    planned: true,
    planTaskCount: 0,
    decision: "answer",
    reply: "Hi, how can I help?",
    supervisor: { modelActual: "gpt-5-codex", totalTokens: 120 },
  });
  const stored = await f.t.run((ctx) => ctx.db.get("textCommands", args.textCommandId));
  expect(stored).toMatchObject({
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    totalTokens: 120,
  });
  // Identical replay is idempotent; a different reply or decision conflicts.
  expect(await f.node.mutation(api.supervisor.acceptPlan, args)).toBeNull();
  await expect(
    f.node.mutation(api.supervisor.acceptPlan, { ...args, reply: "Something else" }),
  ).rejects.toThrow("COMMAND_CONFLICT");
  await expect(
    f.node.mutation(api.supervisor.acceptPlan, { ...args, decision: "ask" }),
  ).rejects.toThrow("COMMAND_CONFLICT");
  await expect(
    f.node.mutation(api.supervisor.acceptPlan, {
      workstationId: args.workstationId,
      textCommandId: args.textCommandId,
      contextSha: args.contextSha,
      contextDigest: args.contextDigest,
      decision: "plan",
      tasks: [task("one")],
    }),
  ).rejects.toThrow("COMMAND_CONFLICT");
  await expect(
    f.other.query(api.supervisor.messages, { workSessionId: sessionId }),
  ).rejects.toThrow();
});

it("records a clarifying question as needing input", async () => {
  const f = await fixture();
  const sessionId = await f.submit("Fix it");
  await f.accept({ decision: "ask", reply: "Which bug do you mean?" });
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("waiting");
  expect(session.needsInputCount).toBe(1);
  const [message] = await f.user.query(api.supervisor.messages, { workSessionId: sessionId });
  expect(message).toMatchObject({ decision: "ask", reply: "Which bug do you mean?" });
  expect(message?.supervisor).toBeUndefined();
  // The follow-up answers the question.
  await f.submit("The login bug", sessionId);
  expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).needsInputCount).toBe(
    0,
  );
});

it("creates tasks for an explicit plan decision and for legacy Nodes", async () => {
  const f = await fixture();
  const sessionId = await f.submit("Build two things");
  const { command } = await f.accept({ decision: "plan", reply: "Planning two tasks." }, [
    task("one"),
    task("two", ["one"]),
  ]);
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: sessionId })).toHaveLength(2);
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("running");
  expect(session.totalTaskCount).toBe(2);
  await f.settlePlan(command._id);

  const legacy = await f.submit("Legacy");
  const { args } = await f.accept({}, [task("only")]);
  expect(await f.user.query(api.tasks.listBySession, { workSessionId: legacy })).toHaveLength(1);
  expect((await f.user.query(api.sessions.get, { workSessionId: legacy })).status).toBe("running");
  expect(await f.node.mutation(api.supervisor.acceptPlan, args)).toBeNull();
  // A legacy replay matches an explicit "plan" decision without a reply.
  expect(
    await f.node.mutation(api.supervisor.acceptPlan, { ...args, decision: "plan" }),
  ).toBeNull();
  const [message] = await f.user.query(api.supervisor.messages, { workSessionId: legacy });
  expect(message).toMatchObject({ planned: true, planTaskCount: 1, decision: "plan" });
  expect(message?.reply).toBeUndefined();
});

it("rejects malformed decisions and usage", async () => {
  const f = await fixture();
  await f.submit("Hello");
  const command = await f.planCommand();
  const base = {
    workstationId: f.workstationId,
    textCommandId: command.targetId as Id<"textCommands">,
    contextSha: SHA,
    contextDigest: DIGEST,
  };
  const invalid = [
    { ...base, decision: "answer" as const, reply: "Hi", tasks: [task("one")] },
    { ...base, decision: "ask" as const, tasks: [] },
    { ...base, decision: "answer" as const, reply: "   ", tasks: [] },
    { ...base, decision: "answer" as const, reply: "x".repeat(8001), tasks: [] },
    { ...base, decision: "answer" as const, reply: "Hi", tasks: [], usage: { inputTokens: -1 } },
    { ...base, decision: "answer" as const, reply: "Hi", tasks: [], usage: { totalTokens: 1.5 } },
    {
      ...base,
      decision: "answer" as const,
      reply: "Hi",
      tasks: [],
      usage: { modelActual: "m".repeat(257) },
    },
  ];
  for (const args of invalid)
    await expect(f.node.mutation(api.supervisor.acceptPlan, args)).rejects.toThrow(
      "INVALID_ARGUMENT",
    );
  await expect(
    f.node.mutation(api.supervisor.acceptPlan, { ...base, decision: "plan", tasks: [] }),
  ).rejects.toThrow();
  const stored = await f.t.run((ctx) => ctx.db.get("textCommands", base.textCommandId));
  expect(stored?.planDigest).toBeUndefined();
  expect(stored?.decision).toBeUndefined();
});

it("keeps an active Session running when the Supervisor only answers", async () => {
  const f = await fixture();
  const sessionId = await f.submit("Build");
  const first = await f.accept({}, [task("one")]);
  await f.settlePlan(first.command._id);
  await f.submit("How is it going?", sessionId);
  await f.accept({ decision: "answer", reply: "One task is being built." });
  const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
  expect(session.status).toBe("running");
  expect(session.totalTaskCount).toBe(1);
});

it("reopens a completed or failed Session on follow-up and refuses a cancelled one", async () => {
  const f = await fixture();
  for (const status of ["completed", "failed"] as const) {
    const sessionId = await f.submit(`Start ${status}`);
    const { command } = await f.accept({ decision: "answer", reply: "Done." });
    await f.settlePlan(command._id);
    await f.t.run((ctx) =>
      ctx.db.patch("workSessions", sessionId, { status, completedAt: 5, lastActivityAt: 1 }),
    );
    expect(await f.submit("One more thing", sessionId)).toBe(sessionId);
    const session = await f.user.query(api.sessions.get, { workSessionId: sessionId });
    expect(session.status).toBe("planning");
    expect(session.completedAt).toBeUndefined();
    expect(session.reopenedAt).toBeGreaterThan(0);
    expect(session.lastActivityAt).toBeGreaterThan(1);
    await f.accept({ decision: "answer", reply: "Sure." });
    expect((await f.user.query(api.sessions.get, { workSessionId: sessionId })).status).toBe(
      "waiting",
    );
  }
  const cancelled = await f.submit("Start cancelled");
  await f.user.mutation(api.sessions.cancel, { workSessionId: cancelled });
  await expect(f.submit("Again", cancelled)).rejects.toThrow("PRODUCT_MISMATCH");
});

it("bounds the run summary reported on completion", async () => {
  const f = await fixture();
  await f.submit("Build");
  await f.accept({}, [task("one")]);
  await f.provision();
  await f.node.mutation(api.supervisor.dispatch, { workstationId: f.workstationId });
  const start = (await f.node.query(api.node.listPending, { workstationId: f.workstationId })).find(
    (command) => command.type === "runtime.start",
  );
  if (!start) throw new Error("Missing runtime.start");
  const runId = start.targetId as Id<"agentRuns">;
  await f.node.mutation(api.node.claim, {
    workstationId: f.workstationId,
    commandId: start._id,
    instanceId: "instance",
  });
  await f.node.mutation(api.node.ingestBatch, {
    workstationId: f.workstationId,
    runId,
    events: [
      {
        eventId: "start",
        sequence: 1,
        type: "run.started",
        occurredAt: 1,
        payload: { nativeSessionId: "codex:run" },
      },
      { eventId: "finish", sequence: 2, type: "run.completed", occurredAt: 2, payload: {} },
    ],
  });
  const completion = {
    workstationId: f.workstationId,
    runId,
    headSha: "result",
    dirty: false,
    changedFileCount: 1,
  };
  await expect(
    f.node.mutation(api.node.completeRun, { ...completion, summary: "s".repeat(8001) }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  await f.node.mutation(api.node.completeRun, { ...completion, summary: "Implemented one." });
  const runs = await f.user.query(api.runs.listBySession, {
    workSessionId: (await f.t.run((ctx) => ctx.db.get("agentRuns", runId)))!.workSessionId,
  });
  expect(runs.find((run) => run._id === runId)?.resultSummary).toBe("Implemented one.");
});
