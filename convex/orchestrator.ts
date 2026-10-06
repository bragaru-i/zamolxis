import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { fail, load, requireUser } from "./lib/access";
import { explicitlyRequestsWork, requestsContinuation } from "./lib/orchestration";
import { submitText } from "./supervisor";

const MAX_MESSAGES = 100;
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

export const messages = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const conversations = await ctx.db
      .query("orchestratorConversations")
      .withIndex("by_owner_activity", (q) => q.eq("ownerId", owner._id))
      .order("desc")
      .take(2);
    const conversation = conversations.find((row) => !row.archivedAt);
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

const submitArgs = {
  text: v.string(),
  idempotencyKey: v.string(),
  productId: v.optional(v.id("products")),
  repositoryId: v.optional(v.id("repositories")),
};

export const submit = mutation({
  args: submitArgs,
  returns: v.object({
    messageId: v.id("orchestratorMessages"),
    route: v.union(v.literal("answer"), v.literal("create"), v.literal("continue")),
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
        previous.repositoryId !== args.repositoryId
      )
        fail("COMMAND_CONFLICT");
      return {
        messageId: previous._id,
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
    const conversation = await activeConversation(ctx, owner._id, now);
    const opensWork = explicitlyRequestsWork(text);
    let route: "answer" | "create" | "continue" = "answer";
    let workSessionId: Id<"workSessions"> | undefined;
    let reply: string;
    let links: LinkDraft[] = [];

    if (opensWork) {
      if (!product || !repository) fail("WORK_CONTEXT_REQUIRED");
      const recentSession = requestsContinuation(text)
        ? await mostRecentLinkedSession(
            ctx,
            conversation._id,
            owner._id,
            product._id,
            repository._id,
          )
        : undefined;
      route = recentSession ? "continue" : "create";
      workSessionId = await submitText(ctx, {
        productId: product._id,
        repositoryId: repository._id,
        text,
        idempotencyKey: `orch_${args.idempotencyKey}`.slice(0, 128),
        ...(recentSession ? { sessionId: recentSession._id } : {}),
      });
      reply = recentSession
        ? `I sent this to “${recentSession.title}” and reopened it if needed.`
        : "I opened a Work Session and sent your request to its Supervisor.";
    } else {
      const summary = await statusAnswer(ctx, owner._id, product?._id, text);
      reply = summary.reply;
      links = summary.links;
    }

    const messageId = await ctx.db.insert("orchestratorMessages", {
      ownerId: owner._id,
      conversationId: conversation._id,
      idempotencyKey: args.idempotencyKey,
      text,
      ...(product ? { productId: product._id } : {}),
      ...(repository ? { repositoryId: repository._id } : {}),
      route,
      reply,
      ...(workSessionId ? { workSessionId } : {}),
      createdAt: now,
    });
    if (workSessionId) links = [sessionLink(await load(ctx, "workSessions", workSessionId))];
    for (const link of links.slice(0, MAX_LINKS))
      await ctx.db.insert("orchestratorMessageLinks", {
        ownerId: owner._id,
        messageId,
        ...link,
        createdAt: now,
      });
    await ctx.db.patch("orchestratorConversations", conversation._id, {
      lastActivityAt: now,
      updatedAt: now,
    });
    return { messageId, route, ...(workSessionId ? { workSessionId } : {}) };
  },
});

async function activeConversation(ctx: MutationCtx, ownerId: Id<"users">, now: number) {
  const rows = await ctx.db
    .query("orchestratorConversations")
    .withIndex("by_owner_activity", (q) => q.eq("ownerId", ownerId))
    .order("desc")
    .take(2);
  const current = rows.find((row) => !row.archivedAt);
  if (current) return current;
  const id = await ctx.db.insert("orchestratorConversations", {
    ownerId,
    title: "Zamolxis",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return load(ctx, "orchestratorConversations", id);
}

async function mostRecentLinkedSession(
  ctx: MutationCtx,
  conversationId: Id<"orchestratorConversations">,
  ownerId: Id<"users">,
  productId: Id<"products">,
  repositoryId: Id<"repositories">,
) {
  const messages = await ctx.db
    .query("orchestratorMessages")
    .withIndex("by_conversation_time", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(25);
  for (const message of messages) {
    const links = await ctx.db
      .query("orchestratorMessageLinks")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(MAX_LINKS);
    const candidateIds = [
      ...(message.workSessionId ? [message.workSessionId] : []),
      ...links.flatMap((link) => (link.workSessionId ? [link.workSessionId] : [])),
    ];
    for (const sessionId of candidateIds) {
      const session = await ctx.db.get(sessionId);
      if (session?.ownerId !== ownerId || session.productId !== productId) continue;
      const relationship = await ctx.db
        .query("sessionRepositories")
        .withIndex("by_session_repository", (q) =>
          q.eq("workSessionId", session._id).eq("repositoryId", repositoryId),
        )
        .unique();
      if (relationship) return session;
    }
  }
  return undefined;
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
        "The Orchestrator owns this top-level conversation. It answers and summarizes here. Only an explicit request to do work opens or continues a Work Session, whose Supervisor may delegate to Builder, Verifier and Repair agents. You can choose each role’s runtime, model and instructions in Settings → Agents.",
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
        "There are no Work Sessions in this scope yet. I answered here and did not open one. Tell me explicitly to start, fix, build or continue something when you want work delegated.",
      links: [] as LinkDraft[],
    };
  }
  const active = owned.filter((session) =>
    ["planning", "running", "waiting", "needs_input"].includes(session.status),
  );
  const needsInput = owned.filter((session) => session.status === "needs_input");
  const lines = owned.map(
    (session) =>
      `• ${session.title}: ${session.status}; ${session.completedTaskCount}/${session.totalTaskCount} tasks complete${session.activeRunCount ? `; ${session.activeRunCount} active run${session.activeRunCount === 1 ? "" : "s"}` : ""}.`,
  );
  return {
    reply: [
      `${active.length} active Work Session${active.length === 1 ? "" : "s"}; ${needsInput.length} need${needsInput.length === 1 ? "s" : ""} your input; ${approvals.length} pending approval${approvals.length === 1 ? "" : "s"}.`,
      ...lines,
      "I only summarized existing control-plane state; I did not open a new Work Session.",
    ].join("\n"),
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
        label: `Approve: ${approval.action}`.slice(0, 120),
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
          label: `PR: ${task.title}`.slice(0, 120),
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
          label: `Trust: ${task.title}`.slice(0, 120),
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
          label: `${run.role ?? "builder"}: ${titles.get(run.taskId) ?? "Run"}`.slice(0, 120),
          status: run.status,
        });
  }
  return [...links, ...prs, ...tasks, ...runs].slice(0, MAX_LINKS);
}
