import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { seedHuman } from "./fixtures/auth";

const modules = {
  "./_generated/server.ts": () => import("../convex/_generated/server"),
  "./agentProfiles.ts": () => import("../convex/agentProfiles"),
  "./orchestrator.ts": () => import("../convex/orchestrator"),
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
  "./traces.ts": () => import("../convex/traces"),
  "./trust.ts": () => import("../convex/trust"),
};

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
    headSha: "base",
  });
  const productId = await t.run(async (ctx) => {
    const repository = await ctx.db.get("repositories", repositoryId);
    if (!repository) throw new Error("Missing repository");
    const id = await ctx.db.insert("products", {
      ownerId: repository.ownerId,
      name: "Product",
      slug: "product",
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.patch("repositories", repositoryId, { productId: id });
    return id;
  });
  return { t, user, other, node, workstationId, productId, repositoryId };
}

it("answers a status question without creating hidden work", async () => {
  const f = await fixture();
  const result = await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "status-1",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(result).toMatchObject({ route: "answer" });
  expect(result).not.toHaveProperty("workSessionId");
  const state = await f.t.run(async (ctx) => ({
    sessions: await ctx.db.query("workSessions").collect(),
    commands: await ctx.db.query("textCommands").collect(),
    conversations: await ctx.db.query("orchestratorConversations").collect(),
  }));
  expect(state.sessions).toHaveLength(0);
  expect(state.commands).toHaveLength(0);
  expect(state.conversations).toHaveLength(1);
  const messages = await f.user.query(api.orchestrator.messages, {});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    route: "answer",
    text: "What is going on?",
    links: [],
  });
  expect(messages[0]?.reply).toContain("I haven't started anything");
  expect(await f.other.query(api.orchestrator.messages, {})).toEqual([]);
});

it("summarizes existing sessions and returns typed navigation links", async () => {
  const f = await fixture();
  const sessionId = await f.t.run(async (ctx) => {
    const product = await ctx.db.get("products", f.productId);
    if (!product) throw new Error("Missing product");
    const id = await ctx.db.insert("workSessions", {
      ownerId: product.ownerId,
      productId: f.productId,
      title: "Alpha readiness",
      goal: "Finish alpha",
      status: "needs_input",
      activeRunCount: 0,
      completedTaskCount: 2,
      totalTaskCount: 3,
      needsInputCount: 1,
      lastActivityAt: 10,
      createdAt: 1,
      updatedAt: 10,
    });
    await ctx.db.insert("sessionRepositories", {
      workSessionId: id,
      repositoryId: f.repositoryId,
      role: "primary",
    });
    return id;
  });
  const first = await f.user.mutation(api.orchestrator.submit, {
    text: "Current project status?",
    idempotencyKey: "status-2",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  const [message] = await f.user.query(api.orchestrator.messages, {});
  if (!message) throw new Error("Missing Orchestrator answer");
  expect(message.reply).toContain("**Alpha readiness**: needs you, 2 of 3 tasks done");
  expect(message.reply).toContain("1 session in progress, 1 needs you.");
  expect(message.reply).not.toContain("needs_input");
  expect(message.links).toEqual([
    expect.objectContaining({
      targetType: "session",
      targetId: sessionId,
      workSessionId: sessionId,
      label: "Alpha readiness",
      status: "needs_input",
    }),
  ]);
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(1);

  const continuation = await f.user.mutation(api.orchestrator.submit, {
    text: "Do it",
    idempotencyKey: "status-follow-up",
    conversationId: first.conversationId,
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(continuation).toMatchObject({ route: "propose" });
  expect(continuation).not.toHaveProperty("workSessionId");
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(1);
});

it("keeps explicit work as a proposal until the owner confirms it", async () => {
  const f = await fixture();
  const first = await f.user.mutation(api.orchestrator.submit, {
    text: "Fix the alpha blocker",
    idempotencyKey: "work-1",
    productId: f.productId,
    repositoryId: f.repositoryId,
  });
  expect(first.route).toBe("propose");
  expect(first).not.toHaveProperty("workSessionId");
  expect(await f.t.run((ctx) => ctx.db.query("workSessions").collect())).toHaveLength(0);
  const opened = await f.user.mutation(api.orchestrator.openProposal, {
    messageId: first.messageId,
    productId: f.productId,
    repositoryId: f.repositoryId,
    workstationId: f.workstationId,
  });
  expect(opened).toBeDefined();
  // The chosen computer is the Session's computer from now on.
  expect(await f.user.query(api.sessions.get, { workSessionId: opened })).toMatchObject({
    workstationId: f.workstationId,
    workstationName: "Node",
  });
  expect(
    await f.user.mutation(api.orchestrator.openProposal, {
      messageId: first.messageId,
      productId: f.productId,
      repositoryId: f.repositoryId,
    }),
  ).toBe(opened);

  const secondArgs = {
    text: "Continue with that",
    idempotencyKey: "work-2",
    conversationId: first.conversationId,
    productId: f.productId,
    repositoryId: f.repositoryId,
  } as const;
  const second = await f.user.mutation(api.orchestrator.submit, secondArgs);
  expect(second).toMatchObject({ route: "propose" });
  expect(second).not.toHaveProperty("workSessionId");
  expect(await f.user.mutation(api.orchestrator.submit, secondArgs)).toEqual(second);

  const state = await f.t.run(async (ctx) => ({
    sessions: await ctx.db.query("workSessions").collect(),
    orchestratorMessages: await ctx.db.query("orchestratorMessages").collect(),
    supervisorMessages: await ctx.db.query("textCommands").collect(),
  }));
  expect(state.sessions).toHaveLength(1);
  expect(state.orchestratorMessages).toHaveLength(2);
  expect(state.supervisorMessages).toHaveLength(1);
  const messages = await f.user.query(api.orchestrator.messages, {});
  expect(messages[0]?.proposalSessionId).toBe(opened);
  expect(messages[1]?.proposalSessionId).toBeUndefined();
});

it("links approvals, pull requests, attention Tasks, trust and active Runs in a status answer", async () => {
  const f = await fixture();
  const seeded = await f.t.run(async (ctx) => {
    const product = await ctx.db.get("products", f.productId);
    const location = await ctx.db.query("repositoryLocations").first();
    if (!product || !location) throw new Error("Missing fixture");
    const now = 10;
    const sessionId = await ctx.db.insert("workSessions", {
      ownerId: product.ownerId,
      productId: f.productId,
      title: "Checkout",
      goal: "Fix checkout",
      status: "running",
      activeRunCount: 1,
      completedTaskCount: 0,
      totalTaskCount: 3,
      needsInputCount: 1,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const task = (title: string, extra: Record<string, unknown>) =>
      ctx.db.insert("tasks", {
        workSessionId: sessionId,
        title,
        description: title,
        kind: "code",
        status: "running",
        runtimePolicyMode: "auto",
        priority: 0,
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
    const blockedTaskId = await task("Pick a payment provider", { phase: "needs_input" });
    const publishedTaskId = await task("Fix totals", {
      phase: "completed",
      status: "completed",
      publishStatus: "published",
      prUrl: "https://github.com/acme/shop/pull/7",
    });
    const unsafeTaskId = await task("Unsafe link", { prUrl: "javascript:alert(1)" });
    const workspaceId = await ctx.db.insert("workspaces", {
      workSessionId: sessionId,
      taskId: blockedTaskId,
      repositoryId: f.repositoryId,
      repositoryLocationId: location._id,
      workstationId: location.workstationId,
      kind: "worktree",
      status: "in_use",
      baseRef: "HEAD",
      dirty: false,
      changedFileCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const run = (taskId: typeof blockedTaskId, status: "running" | "completed") =>
      ctx.db.insert("agentRuns", {
        workSessionId: sessionId,
        taskId,
        workspaceId,
        workstationId: location.workstationId,
        role: "builder",
        runtime: "codex",
        status,
        attempt: 1,
        lastActivityAt: now,
      });
    const activeRunId = await run(blockedTaskId, "running");
    await run(publishedTaskId, "completed");
    const trustId = await ctx.db.insert("trustDecisions", {
      candidateRunId: activeRunId,
      subjectSha: "abc",
      eligible: false,
      reasons: ["verifier failed"],
      createdAt: now,
    });
    await ctx.db.patch("tasks", blockedTaskId, { lastTrustDecisionId: trustId });
    const approvalId = await ctx.db.insert("approvals", {
      ownerId: product.ownerId,
      workSessionId: sessionId,
      runId: activeRunId,
      action: "network access",
      risk: "medium",
      request: {},
      status: "pending",
      requestedAt: now,
    });
    return {
      sessionId,
      blockedTaskId,
      publishedTaskId,
      unsafeTaskId,
      activeRunId,
      trustId,
      approvalId,
    };
  });

  const result = await f.user.mutation(api.orchestrator.submit, {
    text: "What needs me?",
    idempotencyKey: "typed-links",
    productId: f.productId,
  });
  expect(result.route).toBe("answer");
  const [message] = await f.user.query(api.orchestrator.messages, {});
  const links = (message?.links ?? []).map(
    (link: { targetType: string; targetId: string; status?: string; url?: string }) => ({
      targetType: link.targetType,
      targetId: link.targetId,
      status: link.status,
      url: link.url,
    }),
  );
  expect(links).toEqual([
    { targetType: "session", targetId: seeded.sessionId, status: "running", url: undefined },
    { targetType: "approval", targetId: seeded.approvalId, status: "medium", url: undefined },
    {
      targetType: "pull_request",
      targetId: seeded.publishedTaskId,
      status: "published",
      url: "https://github.com/acme/shop/pull/7",
    },
    { targetType: "task", targetId: seeded.blockedTaskId, status: "needs_input", url: undefined },
    { targetType: "trust", targetId: seeded.trustId, status: "not_trusted", url: undefined },
    { targetType: "run", targetId: seeded.activeRunId, status: "running", url: undefined },
  ]);
  for (const link of message?.links ?? []) expect(link.workSessionId).toBe(seeded.sessionId);
  expect(await f.other.query(api.orchestrator.messages, {})).toEqual([]);
  // A status answer stays read-only.
  const counts = await f.t.run(async (ctx) => ({
    sessions: (await ctx.db.query("workSessions").collect()).length,
    runs: (await ctx.db.query("agentRuns").collect()).length,
    commands: (await ctx.db.query("textCommands").collect()).length,
  }));
  expect(counts).toEqual({ sessions: 1, runs: 2, commands: 0 });
});

it("allows a local model for the Orchestrator only", async () => {
  const f = await fixture();
  const local = { runtime: "local", model: "qwen/qwen3-coder-30b", enabled: true };
  for (const role of ["supervisor", "builder", "verifier", "repair"] as const)
    await expect(
      f.user.mutation(api.agentProfiles.upsert, { name: role, role, ...local }),
    ).rejects.toThrow("INVALID_ARGUMENT");
  await expect(
    f.user.mutation(api.agentProfiles.setRuntimeForAllRoles, { runtime: "local" }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  await f.user.mutation(api.agentProfiles.upsert, {
    name: "Orchestrator",
    role: "orchestrator",
    ...local,
  });
});

it("answers with the Orchestrator's backup when no computer offers its own agent", async () => {
  const f = await fixture();
  // A local model first (no computer offers it here), Codex as the backup.
  await f.user.mutation(api.agentProfiles.upsert, {
    name: "Orchestrator",
    role: "orchestrator",
    runtime: "local",
    model: "qwen/qwen3-coder-30b",
    backups: [{ runtime: "codex", model: "gpt-x" }],
    enabled: true,
  });
  const { messageId } = await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "q-backup",
    productId: f.productId,
  });
  const command = await f.t.run(async (ctx) =>
    (await ctx.db.query("commands").collect()).find((row) => row.targetId === messageId),
  );
  expect(command?.payload).toMatchObject({ orchestrator: { runtime: "codex", model: "gpt-x" } });
  const [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message).toMatchObject({ runtime: "codex", modelRequested: "gpt-x" });
});

it("hands a question to the Orchestrator model on an online Node and settles only its reply", async () => {
  const f = await fixture();
  await f.user.mutation(api.agentProfiles.upsert, {
    name: "Orchestrator",
    role: "orchestrator",
    runtime: "codex",
    model: "gpt-x",
    reasoningEffort: "low",
    instructions: "Be brief.",
    enabled: true,
  });
  const { conversationId } = await f.user.mutation(api.orchestrator.submit, {
    text: "First question",
    idempotencyKey: "q-1",
    productId: f.productId,
  });
  const { messageId } = await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "q-2",
    productId: f.productId,
    conversationId,
  });
  const commands = await f.t.run((ctx) =>
    ctx.db
      .query("commands")
      .filter((q) => q.eq(q.field("type"), "orchestrator.answer"))
      .collect(),
  );
  expect(commands).toHaveLength(2);
  const command = commands.find((row) => row.targetId === messageId);
  expect(command).toMatchObject({
    workstationId: f.workstationId,
    targetType: "orchestratorMessage",
    idempotencyKey: `orchestrator:${messageId}`,
    status: "pending",
  });
  expect(command?.payload).toMatchObject({
    orchestratorMessageId: messageId,
    text: "What is going on?",
    orchestrator: {
      runtime: "codex",
      model: "gpt-x",
      reasoningEffort: "low",
      instructions: "Be brief.",
    },
    conversation: [
      { role: "user", text: "First question" },
      { role: "supervisor", text: expect.stringContaining("I haven't started anything") },
    ],
  });
  expect(command?.payload.context).toContain('Scope: Product "Product"');

  const settle = {
    workstationId: f.workstationId,
    orchestratorMessageId: messageId,
    decision: "answer" as const,
    reply: "Nothing is running.",
    usage: { modelActual: "gpt-x-2", totalTokens: 42 },
  };
  // Another owner's Node cannot answer for this owner.
  const otherWorkstation = await f.other.mutation(api.workstations.register, {
    name: "Other",
    nodeAuthSubject: "other-device",
  });
  const otherNode = f.t.withIdentity({
    subject: "other-device",
    tokenIdentifier: "other-device",
    ownerSubject: "bob",
  });
  await expect(
    otherNode.mutation(api.orchestrator.settleAnswer, {
      ...settle,
      workstationId: otherWorkstation,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.node.mutation(api.orchestrator.settleAnswer, { ...settle, decision: "propose" }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  await f.node.mutation(api.orchestrator.settleAnswer, settle);
  await f.node.mutation(api.orchestrator.settleAnswer, { ...settle, reply: "Late duplicate." });
  const messages = await f.user.query(api.orchestrator.messages, {});
  expect(messages.at(-1)).toMatchObject({
    status: "answered",
    answeredBy: "model",
    route: "answer",
    reply: "Nothing is running.",
    modelActual: "gpt-x-2",
    totalTokens: 42,
  });
  await expect(
    f.user.mutation(api.orchestrator.openProposal, {
      messageId,
      productId: f.productId,
      repositoryId: f.repositoryId,
    }),
  ).rejects.toThrow("INVALID_STATE");
});

it("answers deterministically when no Node can run the Orchestrator", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch("workstations", f.workstationId, { status: "offline" });
  });
  const { messageId } = await f.user.mutation(api.orchestrator.submit, {
    text: "What is going on?",
    idempotencyKey: "offline",
  });
  const [message] = await f.user.query(api.orchestrator.messages, {});
  expect(message).toMatchObject({
    _id: messageId,
    status: "answered",
    answeredBy: "deterministic",
  });
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("commands")
        .filter((q) => q.eq(q.field("type"), "orchestrator.answer"))
        .collect(),
    ),
  ).toEqual([]);
});

it("starts a new chat per message unless the chat is named, and lists chats by activity", async () => {
  const f = await fixture();
  const first = await f.user.mutation(api.orchestrator.submit, {
    text: "  What is going on?\nSecond line is not the title.",
    idempotencyKey: "chat-1",
  });
  const followUp = await f.user.mutation(api.orchestrator.submit, {
    text: "And now?",
    idempotencyKey: "chat-1b",
    conversationId: first.conversationId,
  });
  expect(followUp.conversationId).toBe(first.conversationId);
  const second = await f.user.mutation(api.orchestrator.submit, {
    text: `${"Long ".repeat(40)}question`,
    idempotencyKey: "chat-2",
  });
  expect(second.conversationId).not.toBe(first.conversationId);

  const chats = await f.user.query(api.orchestrator.conversations, {});
  expect(chats.map((chat) => chat._id)).toEqual([second.conversationId, first.conversationId]);
  expect(chats[1]?.title).toBe("What is going on?");
  expect(chats[0]?.title).toHaveLength(80);
  expect(chats[0]?.title.endsWith("…")).toBe(true);

  const firstChat = await f.user.query(api.orchestrator.messages, {
    conversationId: first.conversationId,
  });
  expect(firstChat.map((message) => message.text)).toEqual([
    "What is going on?\nSecond line is not the title.",
    "And now?",
  ]);
  // Without a chat the latest one is read, as before.
  expect((await f.user.query(api.orchestrator.messages, {})).map((m) => m.text)).toEqual([
    `${"Long ".repeat(40)}question`,
  ]);

  // A retry of the first message returns the same chat; a retry aimed at another chat conflicts.
  expect(
    await f.user.mutation(api.orchestrator.submit, {
      text: "  What is going on?\nSecond line is not the title.",
      idempotencyKey: "chat-1",
    }),
  ).toEqual(first);
  await expect(
    f.user.mutation(api.orchestrator.submit, {
      text: "  What is going on?\nSecond line is not the title.",
      idempotencyKey: "chat-1",
      conversationId: second.conversationId,
    }),
  ).rejects.toThrow("COMMAND_CONFLICT");

  // Another owner can neither read nor continue this chat.
  expect(await f.other.query(api.orchestrator.conversations, {})).toEqual([]);
  await expect(
    f.other.query(api.orchestrator.messages, { conversationId: first.conversationId }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.other.mutation(api.orchestrator.submit, {
      text: "Mine now",
      idempotencyKey: "bob-1",
      conversationId: first.conversationId,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.other.mutation(api.orchestrator.renameConversation, {
      conversationId: first.conversationId,
      title: "Bob's",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.other.mutation(api.orchestrator.archiveConversation, {
      conversationId: first.conversationId,
    }),
  ).rejects.toThrow("FORBIDDEN");
});

it("renames and deletes chats; a deleted chat keeps its history but takes no new messages", async () => {
  const f = await fixture();
  const { conversationId } = await f.user.mutation(api.orchestrator.submit, {
    text: "Status?",
    idempotencyKey: "chat-3",
  });
  await expect(
    f.user.mutation(api.orchestrator.renameConversation, { conversationId, title: "   " }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  await expect(
    f.user.mutation(api.orchestrator.renameConversation, {
      conversationId,
      title: "x".repeat(81),
    }),
  ).rejects.toThrow("INVALID_ARGUMENT");
  await f.user.mutation(api.orchestrator.renameConversation, {
    conversationId,
    title: "  Alpha   check ",
  });
  expect((await f.user.query(api.orchestrator.conversations, {}))[0]?.title).toBe("Alpha check");

  await f.user.mutation(api.orchestrator.archiveConversation, { conversationId });
  await f.user.mutation(api.orchestrator.archiveConversation, { conversationId });
  expect(await f.user.query(api.orchestrator.conversations, {})).toEqual([]);
  expect(await f.user.query(api.orchestrator.messages, {})).toEqual([]);
  expect(await f.user.query(api.orchestrator.messages, { conversationId })).toHaveLength(1);
  await expect(
    f.user.mutation(api.orchestrator.submit, {
      text: "Still there?",
      idempotencyKey: "chat-3b",
      conversationId,
    }),
  ).rejects.toThrow("INVALID_STATE");
});

it("names a chat created before titles after its first message", async () => {
  const f = await fixture();
  const conversationId = await f.t.run(async (ctx) => {
    const owner = await ctx.db.query("users").first();
    if (!owner) throw new Error("Missing owner");
    const id = await ctx.db.insert("orchestratorConversations", {
      ownerId: owner._id,
      title: "Zamolxis",
      lastActivityAt: 5,
      createdAt: 1,
      updatedAt: 5,
    });
    await ctx.db.insert("orchestratorMessages", {
      ownerId: owner._id,
      conversationId: id,
      idempotencyKey: "legacy-1",
      text: "How does the verifier work?",
      route: "answer",
      reply: "…",
      createdAt: 2,
    });
    return id;
  });
  const chats = await f.user.query(api.orchestrator.conversations, {});
  expect(chats).toEqual([
    expect.objectContaining({ _id: conversationId, title: "How does the verifier work?" }),
  ]);
});
