import { type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, load, requireNode, requireUser } from "./lib/access";
import { agentChain, firstAvailable, resolveAgentProfile } from "./lib/agentProfiles";
import { enqueue } from "./lib/commands";
import type { failureDetail } from "./lib/failure";
import { explicitlyRequestsWork } from "./lib/orchestration";
import { assertUsage, submitText, usageArgs } from "./supervisor";

const MAX_MESSAGES = 100;
const MAX_CONVERSATIONS = 100;
// Chats created before titles were derived from the first message carry this title.
const DEFAULT_TITLE = "Zamolxis";
const TITLE_LIMIT = 80;
const RUN_VERB: Record<string, string> = {
  builder: "Building",
  verifier: "Checking",
  repair: "Fixing",
};
// Session status in the owner's words, as the app shows it.
const OWNER_STATUS: Record<string, string> = {
  planning: "thinking",
  running: "working",
  waiting: "idle",
  needs_input: "needs you",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};
const HISTORY_MESSAGES = 10;
const HISTORY_TEXT_LIMIT = 4000;
const CONTEXT_LIMIT = 16000;
const REPLY_LIMIT = 8000;
const PROPOSAL_LIMIT = 4000;
const HEARTBEAT_FRESH_MS = 45_000;
const route = v.union(
  v.literal("answer"),
  v.literal("ask"),
  v.literal("propose"),
  v.literal("create"),
  v.literal("continue"),
);
const MAX_LINKS = 24;
const ACTIVE_RUN = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
  "needs_approval",
  "stopping",
]);
const ATTENTION_PHASE = new Set(["needs_input", "trust_failed", "ready_for_integration", "failed"]);

type LinkTarget = Doc<"orchestratorMessageLinks">["targetType"];
interface LinkDraft {
  targetType: LinkTarget;
  targetId: string;
  workSessionId: Id<"workSessions">;
  label: string;
  status?: string;
  url?: string;
}

function sessionLink(session: Doc<"workSessions">): LinkDraft {
  return {
    targetType: "session",
    targetId: session._id,
    workSessionId: session._id,
    label: session.title,
    status: session.status,
  };
}

/** The first line of the first message, compacted; what the chat list shows. */
export function conversationTitle(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
  const compact = line.replace(/\s+/g, " ").trim();
  if (!compact) return DEFAULT_TITLE;
  return compact.length > TITLE_LIMIT ? `${compact.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : compact;
}

async function ownedConversation(
  ctx: QueryCtx,
  ownerId: Id<"users">,
  conversationId: Id<"orchestratorConversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.ownerId !== ownerId) fail("FORBIDDEN");
  return conversation;
}

// Chats from before titles existed are named after their first message on read.
async function displayTitle(ctx: QueryCtx, conversation: Doc<"orchestratorConversations">) {
  if (conversation.title !== DEFAULT_TITLE) return conversation.title;
  const first = await ctx.db
    .query("orchestratorMessages")
    .withIndex("by_conversation_time", (q) => q.eq("conversationId", conversation._id))
    .order("asc")
    .first();
  return first ? conversationTitle(first.text) : conversation.title;
}

/** The owner's chats, most recent activity first. Deleted (archived) chats are left out. */
export const conversations = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("orchestratorConversations"),
      title: v.string(),
      lastActivityAt: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const rows = await ctx.db
      .query("orchestratorConversations")
      .withIndex("by_owner_activity", (q) => q.eq("ownerId", owner._id))
      .order("desc")
      .take(MAX_CONVERSATIONS);
    return Promise.all(
      rows
        .filter((row) => !row.archivedAt)
        .map(async (row) => ({
          _id: row._id,
          title: await displayTitle(ctx, row),
          lastActivityAt: row.lastActivityAt,
          createdAt: row.createdAt,
        })),
    );
  },
});

/** Messages of one chat; without `conversationId`, the most recently active chat. */
export const messages = query({
  args: { conversationId: v.optional(v.id("orchestratorConversations")) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    let conversation: Doc<"orchestratorConversations"> | undefined;
    if (args.conversationId) {
      conversation = await ownedConversation(ctx, owner._id, args.conversationId);
    } else {
      const conversations = await ctx.db
        .query("orchestratorConversations")
        .withIndex("by_owner_activity", (q) => q.eq("ownerId", owner._id))
        .order("desc")
        .take(2);
      conversation = conversations.find((row) => !row.archivedAt);
    }
    if (!conversation) return [];
    const rows = await ctx.db
      .query("orchestratorMessages")
      .withIndex("by_conversation_time", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(MAX_MESSAGES);
    return Promise.all(
      rows.reverse().map(async (row) => ({
        ...row,
        links: await ctx.db
          .query("orchestratorMessageLinks")
          .withIndex("by_message", (q) => q.eq("messageId", row._id))
          .take(MAX_LINKS),
      })),
    );
  },
});

export const renameConversation = mutation({
  args: { conversationId: v.id("orchestratorConversations"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const conversation = await ownedConversation(ctx, owner._id, args.conversationId);
    const title = args.title.replace(/\s+/g, " ").trim();
    if (!title || title.length > TITLE_LIMIT) fail("INVALID_ARGUMENT");
    await ctx.db.patch("orchestratorConversations", conversation._id, {
      title,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Deleting a chat hides it and closes it to new messages; its history is kept. */
export const archiveConversation = mutation({
  args: { conversationId: v.id("orchestratorConversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const conversation = await ownedConversation(ctx, owner._id, args.conversationId);
    if (conversation.archivedAt) return null;
    const now = Date.now();
    await ctx.db.patch("orchestratorConversations", conversation._id, {
      archivedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

const submitArgs = {
  text: v.string(),
  idempotencyKey: v.string(),
  // Absent: the message starts a new chat.
  conversationId: v.optional(v.id("orchestratorConversations")),
  productId: v.optional(v.id("products")),
  repositoryId: v.optional(v.id("repositories")),
};

export const submit = mutation({
  args: submitArgs,
  returns: v.object({
    messageId: v.id("orchestratorMessages"),
    conversationId: v.id("orchestratorConversations"),
    route,
    workSessionId: v.optional(v.id("workSessions")),
  }),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const text = args.text.trim();
    if (!text || text.length > 16000 || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.idempotencyKey))
      fail("INVALID_ARGUMENT");

    const previous = await ctx.db
      .query("orchestratorMessages")
      .withIndex("by_owner_key", (q) =>
        q.eq("ownerId", owner._id).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (previous) {
      if (
        previous.text !== text ||
        previous.productId !== args.productId ||
        previous.repositoryId !== args.repositoryId ||
        (args.conversationId !== undefined && previous.conversationId !== args.conversationId)
      )
        fail("COMMAND_CONFLICT");
      return {
        messageId: previous._id,
        conversationId: previous.conversationId,
        route: previous.route,
        ...(previous.workSessionId ? { workSessionId: previous.workSessionId } : {}),
      };
    }

    const product = args.productId ? await load(ctx, "products", args.productId) : undefined;
    const repository = args.repositoryId
      ? await load(ctx, "repositories", args.repositoryId)
      : undefined;
    if (
      (product && (product.ownerId !== owner._id || product.archivedAt)) ||
      (repository &&
        (repository.ownerId !== owner._id ||
          (product !== undefined && repository.productId !== product._id)))
    )
      fail("PRODUCT_MISMATCH");

    const now = Date.now();
    const conversation = args.conversationId
      ? await openConversation(ctx, owner._id, args.conversationId)
      : await createConversation(ctx, owner._id, text, now);
    const proposesWork = explicitlyRequestsWork(text);
    const route: "answer" | "propose" = proposesWork ? "propose" : "answer";
    let reply: string;
    let proposal: string | undefined;
    let links: LinkDraft[] = [];
    let model: Awaited<ReturnType<typeof orchestratorTarget>> | undefined;

    if (proposesWork) {
      proposal = text;
      reply =
        "I prepared this as a proposal. Review the target and request before opening a Work Session; nothing has started.";
      model = await orchestratorTarget(ctx, owner._id, product?._id);
    } else {
      const summary = await statusAnswer(ctx, owner._id, product?._id, text);
      reply = summary.reply;
      links = summary.links;
      model = await orchestratorTarget(ctx, owner._id, product?._id);
    }
    const history = model ? await conversationHistory(ctx, conversation._id) : [];

    const messageId = await ctx.db.insert("orchestratorMessages", {
      ownerId: owner._id,
      conversationId: conversation._id,
      idempotencyKey: args.idempotencyKey,
      text,
      ...(product ? { productId: product._id } : {}),
      ...(repository ? { repositoryId: repository._id } : {}),
      route,
      reply,
      ...(proposal ? { proposal } : {}),
      status: model ? "thinking" : "answered",
      ...(model
        ? {
            runtime: model.choice.runtime,
            ...(model.choice.model ? { modelRequested: model.choice.model } : {}),
          }
        : { answeredBy: "deterministic" as const }),
      createdAt: now,
    });
    for (const link of links.slice(0, MAX_LINKS))
      await ctx.db.insert("orchestratorMessageLinks", {
        ownerId: owner._id,
        messageId,
        ...link,
        createdAt: now,
      });
    if (model) {
      await enqueue(
        ctx,
        model.workstationId,
        "orchestrator.answer",
        "orchestratorMessage",
        messageId,
        {
          orchestratorMessageId: messageId,
          text,
          context: controlPlaneContext(product?.name, reply, links),
          conversation: history,
          orchestrator: {
            runtime: model.choice.runtime,
            ...(model.choice.model ? { model: model.choice.model } : {}),
            ...(model.choice.reasoningEffort
              ? { reasoningEffort: model.choice.reasoningEffort }
              : {}),
            ...(model.profile?.instructions ? { instructions: model.profile.instructions } : {}),
          },
        },
        `orchestrator:${messageId}`,
      );
    }
    await ctx.db.patch("orchestratorConversations", conversation._id, {
      lastActivityAt: now,
      updatedAt: now,
    });
    return { messageId, conversationId: conversation._id, route };
  },
});

// A deleted chat does not take new messages.
async function openConversation(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  conversationId: Id<"orchestratorConversations">,
) {
  const conversation = await ownedConversation(ctx, ownerId, conversationId);
  if (conversation.archivedAt) fail("INVALID_STATE");
  return conversation;
}

async function createConversation(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  text: string,
  now: number,
) {
  const id = await ctx.db.insert("orchestratorConversations", {
    ownerId,
    title: conversationTitle(text),
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return load(ctx, "orchestratorConversations", id);
}

async function statusAnswer(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
  text: string,
) {
  if (
    /\b(?:how does|how do|explain|what is the)\b.{0,50}\b(?:orchestrat|supervisor|builder|verifier|repair|agent|model)\w*/i.test(
      text,
    ) ||
    /\b(?:choose|select|configure|change|set)\w*\b.{0,40}\b(?:agent|model|runtime)\w*/i.test(text)
  ) {
    return {
      reply:
        "I'm your main assistant here: ask me anything and I'll answer from what's going on. Nothing starts until you ask me to do something, like “fix the checkout bug”. Then I open a session where agents build the change and another agent checks it. You can pick which model each agent uses in Settings → Agents.",
      links: [] as LinkDraft[],
    };
  }
  const sessions = productId
    ? await ctx.db
        .query("workSessions")
        .withIndex("by_product_activity", (q) => q.eq("productId", productId))
        .order("desc")
        .take(12)
    : await ctx.db
        .query("workSessions")
        .withIndex("by_owner_activity", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .take(12);
  const owned = sessions.filter((session) => session.ownerId === ownerId).slice(0, 5);
  const pendingApprovals = await ctx.db
    .query("approvals")
    .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", "pending"))
    .take(100);
  const approvals = productId
    ? (
        await Promise.all(
          pendingApprovals.map(async (approval) => ({
            approval,
            session: await ctx.db.get(approval.workSessionId),
          })),
        )
      ).filter(({ session }) => session?.ownerId === ownerId && session.productId === productId)
    : pendingApprovals.map((approval) => ({ approval }));
  if (!owned.length) {
    return {
      reply:
        "Nothing is going on yet, and I haven't started anything. When you want something done, just tell me, for example “add a dark mode” or “fix the login bug”.",
      links: [] as LinkDraft[],
    };
  }
  const active = owned.filter((session) =>
    ["planning", "running", "waiting", "needs_input"].includes(session.status),
  );
  const needsInput = owned.filter((session) => session.status === "needs_input");
  const lines = owned.map((session) => {
    const details = [
      OWNER_STATUS[session.status] ?? session.status,
      session.totalTaskCount
        ? `${session.completedTaskCount} of ${session.totalTaskCount} task${session.totalTaskCount === 1 ? "" : "s"} done`
        : undefined,
      session.activeRunCount
        ? `${session.activeRunCount} agent${session.activeRunCount === 1 ? "" : "s"} working`
        : undefined,
    ].filter(Boolean);
    return `- **${session.title}**: ${details.join(", ")}`;
  });
  const headline = [
    active.length
      ? `${active.length} session${active.length === 1 ? "" : "s"} in progress`
      : "Nothing is in progress",
    needsInput.length
      ? `${needsInput.length} need${needsInput.length === 1 ? "s" : ""} you`
      : undefined,
    approvals.length
      ? `${approvals.length} approval${approvals.length === 1 ? "" : "s"} waiting for you`
      : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    reply: [`${headline}.`, "", ...lines].join("\n"),
    links: await workLinks(ctx, owned, approvals),
  };
}

// Typed navigation for a status answer, most actionable first: Sessions, pending
// approvals, pull requests, Tasks that need the owner, then active Runs.
async function workLinks(
  ctx: MutationCtx,
  sessions: Doc<"workSessions">[],
  approvals: { approval: Doc<"approvals"> }[],
) {
  const scope = new Set<string>(sessions.map((session) => session._id));
  const links: LinkDraft[] = sessions.map(sessionLink);
  for (const { approval } of approvals)
    if (scope.has(approval.workSessionId))
      links.push({
        targetType: "approval",
        targetId: approval._id,
        workSessionId: approval.workSessionId,
        label: `Needs your OK: ${approval.action}`.slice(0, 120),
        status: approval.risk,
      });
  const prs: LinkDraft[] = [];
  const tasks: LinkDraft[] = [];
  const runs: LinkDraft[] = [];
  for (const session of sessions) {
    const sessionTasks = await ctx.db
      .query("tasks")
      .withIndex("by_session", (q) => q.eq("workSessionId", session._id))
      .take(100);
    const titles = new Map(sessionTasks.map((task) => [task._id, task.title]));
    for (const task of sessionTasks) {
      if (task.prUrl && /^https:\/\//.test(task.prUrl))
        prs.push({
          targetType: "pull_request",
          targetId: task._id,
          workSessionId: session._id,
          label: `Pull request: ${task.title}`.slice(0, 120),
          ...(task.publishStatus ? { status: task.publishStatus } : {}),
          url: task.prUrl,
        });
      if (!task.phase || !ATTENTION_PHASE.has(task.phase)) continue;
      tasks.push({
        targetType: "task",
        targetId: task._id,
        workSessionId: session._id,
        label: task.title,
        status: task.phase,
      });
      const trustId = task.trustDecisionId ?? task.lastTrustDecisionId;
      const trust = trustId ? await ctx.db.get(trustId) : null;
      if (trust)
        tasks.push({
          targetType: "trust",
          targetId: trust._id,
          workSessionId: session._id,
          label: `Check result: ${task.title}`.slice(0, 120),
          status: trust.eligible ? "trusted" : "not_trusted",
        });
    }
    const recentRuns = await ctx.db
      .query("agentRuns")
      .withIndex("by_session_activity", (q) => q.eq("workSessionId", session._id))
      .order("desc")
      .take(20);
    for (const run of recentRuns)
      if (ACTIVE_RUN.has(run.status))
        runs.push({
          targetType: "run",
          targetId: run._id,
          workSessionId: session._id,
          label: `${RUN_VERB[run.role ?? "builder"]}: ${titles.get(run.taskId) ?? "a task"}`.slice(
            0,
            120,
          ),
          status: run.status,
        });
  }
  return [...links, ...prs, ...tasks, ...runs].slice(0, MAX_LINKS);
}

// The Orchestrator model runs on one of the owner's online Nodes: the first agent of the
// Orchestrator's chain (its own, then its backups) that such a Node has. Without one the
// deterministic answer stands.
async function orchestratorTarget(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  productId: Id<"products"> | undefined,
) {
  const effective = await resolveAgentProfile(ctx, ownerId, productId, "orchestrator");
  const devices = (
    await ctx.db
      .query("workstations")
      .withIndex("by_owner_status", (q) => q.eq("ownerId", ownerId).eq("status", "online"))
      .take(10)
  ).filter((device) => (device.lastHeartbeatAt ?? 0) > Date.now() - HEARTBEAT_FRESH_MS);
  for (const choice of agentChain(effective.profile, effective.runtime))
    for (const device of devices)
      if (await firstAvailable(ctx, device._id, [choice]))
        return { workstationId: device._id, choice, profile: effective.profile };
  return undefined;
}

async function conversationHistory(
  ctx: MutationCtx,
  conversationId: Id<"orchestratorConversations">,
) {
  const rows = await ctx.db
    .query("orchestratorMessages")
    .withIndex("by_conversation_time", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(HISTORY_MESSAGES);
  return rows.reverse().flatMap((row) => [
    { role: "user" as const, text: row.text.slice(0, HISTORY_TEXT_LIMIT) },
    { role: "supervisor" as const, text: row.reply.slice(0, HISTORY_TEXT_LIMIT) },
  ]);
}

// What the model may rely on: the backend's own summary and the links it will show.
function controlPlaneContext(productName: string | undefined, reply: string, links: LinkDraft[]) {
  return [
    `Scope: ${productName ? `Product "${productName}"` : "all of the owner's Products"}`,
    "Summary:",
    reply,
    "Linked items shown to the owner under your reply (type · label · status):",
    ...(links.length
      ? links.map(
          (link) => `- ${link.targetType} · ${link.label}${link.status ? ` · ${link.status}` : ""}`,
        )
      : ["(none)"]),
  ]
    .join("\n")
    .slice(0, CONTEXT_LIMIT);
}

async function orchestratorCommand(ctx: MutationCtx, messageId: Id<"orchestratorMessages">) {
  return ctx.db
    .query("commands")
    .withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", `orchestrator:${messageId}`))
    .unique();
}

export const settleAnswer = mutation({
  args: {
    workstationId: v.id("workstations"),
    orchestratorMessageId: v.id("orchestratorMessages"),
    decision: v.union(v.literal("answer"), v.literal("ask"), v.literal("propose")),
    reply: v.string(),
    proposal: v.optional(v.string()),
    usage: v.optional(usageArgs),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await requireNode(ctx, args.workstationId);
    const message = await load(ctx, "orchestratorMessages", args.orchestratorMessageId);
    const command = await orchestratorCommand(ctx, message._id);
    if (!command || command.workstationId !== device._id || message.ownerId !== device.ownerId)
      fail("FORBIDDEN");
    if (!args.reply.trim() || args.reply.length > REPLY_LIMIT) fail("INVALID_ARGUMENT");
    if (
      (args.decision === "propose") !== (args.proposal !== undefined) ||
      (args.proposal !== undefined &&
        (!args.proposal.trim() || args.proposal.length > PROPOSAL_LIMIT))
    )
      fail("INVALID_ARGUMENT");
    const usage = args.usage ?? {};
    assertUsage(usage);
    // A late or repeated delivery never replaces an answer already settled.
    if (message.status !== "thinking") return null;
    await ctx.db.patch("orchestratorMessages", message._id, {
      status: "answered",
      answeredBy: "model",
      route: args.decision,
      reply: args.reply,
      ...(args.proposal !== undefined ? { proposal: args.proposal } : {}),
      ...usage,
    });
    return null;
  },
});

// The owner's click is what authorizes a proposal: it becomes an explicit request in a new
// Session through the same path as any explicit work.
export const openProposal = mutation({
  args: {
    messageId: v.id("orchestratorMessages"),
    productId: v.id("products"),
    repositoryId: v.id("repositories"),
    // "Run on": the computer the new Session must use (see supervisor.submit).
    workstationId: v.optional(v.id("workstations")),
  },
  returns: v.id("workSessions"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const message = await load(ctx, "orchestratorMessages", args.messageId);
    if (message.ownerId !== owner._id) fail("FORBIDDEN");
    if (message.proposalSessionId) return message.proposalSessionId;
    if (message.route !== "propose" || !message.proposal) fail("INVALID_STATE");
    const workSessionId = await submitText(ctx, {
      productId: args.productId,
      repositoryId: args.repositoryId,
      text: `Open this work: ${message.proposal}`,
      idempotencyKey: `orchprop_${message._id}`.slice(0, 128),
      ...(args.workstationId ? { workstationId: args.workstationId } : {}),
    });
    await ctx.db.patch("orchestratorMessages", message._id, { proposalSessionId: workSessionId });
    const session = await load(ctx, "workSessions", workSessionId);
    await ctx.db.insert("orchestratorMessageLinks", {
      ownerId: owner._id,
      messageId: message._id,
      ...sessionLink(session),
      createdAt: Date.now(),
    });
    return workSessionId;
  },
});

/** The Node could not produce a model reply: the deterministic answer stands. */
export async function settleFailedAnswer(
  ctx: MutationCtx,
  targetId: string,
  code: string,
  failure?: Infer<typeof failureDetail>,
) {
  const id = ctx.db.normalizeId("orchestratorMessages", targetId);
  if (!id) return;
  const message = await ctx.db.get(id);
  if (message?.status === "thinking")
    await ctx.db.patch("orchestratorMessages", id, {
      status: "answered",
      answeredBy: "deterministic",
      modelError: code.slice(0, 64),
      ...(failure ? { failure } : {}),
    });
}
