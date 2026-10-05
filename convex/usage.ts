import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { ownSession, requireUser } from "./lib/access";

// Owner-scoped token usage (#48). Only provider-reported values are summed: missing
// telemetry stays missing (never inferred), and cost is returned only when a provider
// reported one. Supervisor usage lives on textCommands; agent usage on agentRuns.

export type UsageRole = "supervisor" | "builder" | "verifier" | "repair";

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Items (runs or Supervisor turns) counted. */
  items: number;
  /** Items that reported a total token count. */
  reported: number;
  /** Provider-reported cost; absent when no item reported one. */
  costUsd?: number;
}

interface UsageItem {
  role: UsageRole;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const PERIODS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
// Bounds keep one query well under Convex read limits (50 * (200 + 50) documents).
const SUMMARY_SESSIONS = 50;
const SUMMARY_RUNS = 200;
const SUMMARY_COMMANDS = 50;
const SESSION_RUNS = 1000;
const SESSION_COMMANDS = 100;

function empty(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    items: 0,
    reported: 0,
  };
}

function add(totals: UsageTotals, item: UsageItem) {
  totals.items += 1;
  totals.inputTokens += item.inputTokens ?? 0;
  totals.cachedInputTokens += item.cachedInputTokens ?? 0;
  totals.outputTokens += item.outputTokens ?? 0;
  if (item.totalTokens !== undefined) {
    totals.totalTokens += item.totalTokens;
    totals.reported += 1;
  }
  if (item.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + item.costUsd;
}

function fromRun(run: Doc<"agentRuns">): UsageItem {
  return {
    role: run.role ?? "builder",
    ...(run.modelActual !== undefined ? { model: run.modelActual } : {}),
    ...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
    ...(run.cachedInputTokens !== undefined ? { cachedInputTokens: run.cachedInputTokens } : {}),
    ...(run.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
    ...(run.totalTokens !== undefined ? { totalTokens: run.totalTokens } : {}),
    // Stored only when the provider reports a cost; never estimated here.
    ...(run.estimatedCostUsd !== undefined ? { costUsd: run.estimatedCostUsd } : {}),
  };
}

function fromCommand(command: Doc<"textCommands">): UsageItem | undefined {
  // Legacy messages without a Supervisor decision had no Supervisor turn.
  if (command.decision === undefined && command.totalTokens === undefined) return undefined;
  return {
    role: "supervisor",
    ...(command.modelActual !== undefined ? { model: command.modelActual } : {}),
    ...(command.inputTokens !== undefined ? { inputTokens: command.inputTokens } : {}),
    ...(command.cachedInputTokens !== undefined
      ? { cachedInputTokens: command.cachedInputTokens }
      : {}),
    ...(command.outputTokens !== undefined ? { outputTokens: command.outputTokens } : {}),
    ...(command.totalTokens !== undefined ? { totalTokens: command.totalTokens } : {}),
  };
}

const ROLE_ORDER: UsageRole[] = ["supervisor", "builder", "verifier", "repair"];

function summarize(items: UsageItem[]) {
  const total = empty();
  const roles = new Map<UsageRole, UsageTotals>();
  const models = new Map<string, UsageTotals>();
  for (const item of items) {
    add(total, item);
    const role = roles.get(item.role) ?? empty();
    add(role, item);
    roles.set(item.role, role);
    // "" groups items whose provider did not report the model.
    const key = item.model ?? "";
    const model = models.get(key) ?? empty();
    add(model, item);
    models.set(key, model);
  }
  return {
    total,
    byRole: ROLE_ORDER.filter((role) => roles.has(role)).map((role) => ({
      role,
      ...(roles.get(role) as UsageTotals),
    })),
    byModel: [...models.entries()]
      .map(([model, totals]) => ({ ...(model ? { model } : {}), ...totals }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

async function sessionItems(
  ctx: QueryCtx,
  workSessionId: Id<"workSessions">,
  since: number,
  runLimit: number,
  commandLimit: number,
) {
  const runs = await ctx.db
    .query("agentRuns")
    .withIndex("by_session_activity", (q) =>
      q.eq("workSessionId", workSessionId).gte("lastActivityAt", since),
    )
    .take(runLimit + 1);
  const commands = await ctx.db
    .query("textCommands")
    .withIndex("by_session", (q) =>
      q.eq("workSessionId", workSessionId).gte("_creationTime", since),
    )
    .take(commandLimit + 1);
  const items: UsageItem[] = runs.slice(0, runLimit).map(fromRun);
  for (const command of commands.slice(0, commandLimit)) {
    const item = fromCommand(command);
    if (item) items.push(item);
  }
  return { items, truncated: runs.length > runLimit || commands.length > commandLimit };
}

/** Usage of one Session: Supervisor turns plus agent runs, by role and by model. */
export const session = query({
  args: { workSessionId: v.id("workSessions") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await ownSession(ctx, args.workSessionId);
    const { items, truncated } = await sessionItems(
      ctx,
      args.workSessionId,
      0,
      SESSION_RUNS,
      SESSION_COMMANDS,
    );
    return { ...summarize(items), truncated };
  },
});

/**
 * Owner totals for a recent period. Counts Supervisor turns created in the period and
 * runs active in it (a run's full reported usage counts once it was active), across the
 * most recently active Sessions. `truncated` reports when a bound was reached.
 */
export const summary = query({
  args: { period: v.union(v.literal("24h"), v.literal("7d"), v.literal("30d")) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const since = Date.now() - PERIODS[args.period];
    const sessions = await ctx.db
      .query("workSessions")
      .withIndex("by_owner_activity", (q) =>
        q.eq("ownerId", owner._id).gte("lastActivityAt", since),
      )
      .order("desc")
      .take(SUMMARY_SESSIONS + 1);
    let truncated = sessions.length > SUMMARY_SESSIONS;
    const all: UsageItem[] = [];
    const perSession = [];
    for (const row of sessions.slice(0, SUMMARY_SESSIONS)) {
      const result = await sessionItems(ctx, row._id, since, SUMMARY_RUNS, SUMMARY_COMMANDS);
      truncated ||= result.truncated;
      if (!result.items.length) continue;
      all.push(...result.items);
      const { total } = summarize(result.items);
      perSession.push({ _id: row._id, title: row.title, status: row.status, ...total });
    }
    return {
      period: args.period,
      since,
      sessionCount: perSession.length,
      ...summarize(all),
      topSessions: perSession.sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5),
      truncated,
    };
  },
});
