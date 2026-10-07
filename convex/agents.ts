import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { fail, requireUser } from "./lib/access";
import { agentBackup } from "./lib/agentBackup";
import { instructionsDigest, normalizeInstructions, runtimeAllowedFor } from "./lib/agentProfiles";
import { offeredModels } from "./lib/workflowPresets";

/**
 * The owner's saved agents ("My agents"): a name and 1-3 models in order. A workflow says
 * which agent does each job; the job's profile copies the agent's settings, so resolution and
 * run snapshots stay as they are.
 */
const NAME_LIMIT = 64;
const MAX_CHAIN = 3;
const MAX_AGENTS = 30;
export const JOBS = ["orchestrator", "supervisor", "builder", "verifier", "repair"] as const;
type Job = (typeof JOBS)[number];
const job = v.union(...JOBS.map((value) => v.literal(value)));

type Chain = Doc<"agentDefinitions">["chain"];

/** The jobs an agent may do: every model of its chain must be allowed for the job. */
export function jobsFor(chain: Chain, checksOnly: boolean): Job[] {
  if (checksOnly) return ["verifier"];
  return JOBS.filter((role) => chain.every((entry) => runtimeAllowedFor(role, entry.runtime)));
}

function cleanChain(chain: Chain): Chain {
  const cleaned = chain.map((entry) => ({
    runtime: entry.runtime.trim(),
    ...(entry.model?.trim() ? { model: entry.model.trim() } : {}),
    ...(entry.reasoningEffort?.trim() ? { reasoningEffort: entry.reasoningEffort.trim() } : {}),
  }));
  if (
    !cleaned.length ||
    cleaned.length > MAX_CHAIN ||
    cleaned.some(
      (entry) =>
        !entry.runtime ||
        entry.runtime.length > 64 ||
        (entry.model?.length ?? 0) > 256 ||
        (entry.reasoningEffort?.length ?? 0) > 32,
    )
  )
    fail("INVALID_ARGUMENT");
  return cleaned;
}

async function ownAgent(ctx: QueryCtx, ownerId: Id<"users">, agentId: Id<"agentDefinitions">) {
  const agent = await ctx.db.get(agentId);
  if (!agent || agent.ownerId !== ownerId || agent.archivedAt !== undefined) fail("NOT_FOUND");
  return agent;
}

async function ownerProfiles(ctx: QueryCtx, ownerId: Id<"users">) {
  const rows = await ctx.db
    .query("agentProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(201);
  if (rows.length > 200) fail("LIMIT_EXCEEDED");
  return rows;
}

/** A job's profile settings taken from an agent. */
function profileSettings(agent: Doc<"agentDefinitions">) {
  const [first, ...backups] = agent.chain;
  if (!first) fail("INVALID_STATE");
  return {
    runtime: first.runtime,
    model: first.model,
    reasoningEffort: first.reasoningEffort,
    backups: backups.length ? backups : undefined,
    verification: agent.checksOnly ? ("checks_only" as const) : undefined,
    instructions: agent.instructions,
    instructionsDigest: agent.instructionsDigest,
  };
}

/** The same settings for a new profile, without empty optional fields. */
function insertSettings(agent: Doc<"agentDefinitions">) {
  const [first, ...backups] = agent.chain;
  if (!first) fail("INVALID_STATE");
  return {
    runtime: first.runtime,
    ...(first.model ? { model: first.model } : {}),
    ...(first.reasoningEffort ? { reasoningEffort: first.reasoningEffort } : {}),
    ...(backups.length ? { backups } : {}),
    ...(agent.checksOnly ? { verification: "checks_only" as const } : {}),
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.instructionsDigest ? { instructionsDigest: agent.instructionsDigest } : {}),
  };
}

export const list = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const agents = await ctx.db
      .query("agentDefinitions")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(MAX_AGENTS + 1);
    const profiles = await ownerProfiles(ctx, owner._id);
    return agents
      .filter((agent) => agent.archivedAt === undefined)
      .map((agent) => ({
        _id: agent._id,
        name: agent.name,
        chain: agent.chain,
        checksOnly: agent.checksOnly === true,
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
        jobs: jobsFor(agent.chain, agent.checksOnly === true),
        usedBy: profiles.filter((profile) => profile.agentId === agent._id && profile.enabled)
          .length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

// Codex's own default (GPT-6.1-Sol) uses the plan fastest; starters name its affordable model.
const CODEX = { runtime: "codex", model: "luna" };

// A starter agent: model hints are matched to what the owner's computers report; agents
// with nothing a computer offers are left out.
const STARTERS: Array<{
  name: string;
  chain: Array<{ runtime: string; model?: string }>;
  checksOnly?: true;
}> = [
  { name: "Local chat", chain: [{ runtime: "local", model: "qwen" }, CODEX] },
  {
    name: "Local planner",
    chain: [
      { runtime: "codex-local", model: "qwen" },
      { runtime: "claude", model: "haiku" },
      CODEX,
    ],
  },
  { name: "Claude Opus", chain: [{ runtime: "claude", model: "opus" }, CODEX] },
  { name: "Claude Sonnet", chain: [{ runtime: "claude", model: "sonnet" }, CODEX] },
  { name: "Claude Haiku", chain: [{ runtime: "claude", model: "haiku" }, CODEX] },
  { name: "Codex", chain: [CODEX] },
  { name: "Checks only (no AI)", chain: [{ runtime: "codex" }], checksOnly: true },
];

export function starterChains(offered: Map<string, string[]>) {
  return STARTERS.map((starter) => ({
    name: starter.name,
    ...(starter.checksOnly ? { checksOnly: true as const } : {}),
    chain: starter.chain
      .filter((entry) => offered.has(entry.runtime))
      .map((entry) => {
        const hint = entry.model?.toLowerCase();
        const model = hint
          ? offered.get(entry.runtime)?.find((id) => id.toLowerCase().includes(hint))
          : undefined;
        // A Claude hint without a reported model still names the family Claude accepts.
        const name = model ?? (entry.runtime === "claude" ? entry.model : undefined);
        return { runtime: entry.runtime, ...(name ? { model: name } : {}) };
      }),
  })).filter((starter) => starter.chain.length > 0);
}

/** Creates the starter agents once, for an owner who has none yet. */
export const ensureStarter = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const owner = await requireUser(ctx);
    const existing = await ctx.db
      .query("agentDefinitions")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .first();
    if (existing) return 0;
    const now = Date.now();
    const starters = starterChains(await offeredModels(ctx, owner._id));
    for (const starter of starters)
      await ctx.db.insert("agentDefinitions", {
        ownerId: owner._id,
        name: starter.name,
        chain: starter.chain,
        ...(starter.checksOnly ? { checksOnly: true } : {}),
        createdAt: now,
        updatedAt: now,
      });
    return starters.length;
  },
});

/**
 * Creates or edits an agent. An edit updates every job using it; it is refused when the
 * new models are not allowed for one of those jobs (e.g. a local model as a Builder).
 */
export const save = mutation({
  args: {
    agentId: v.optional(v.id("agentDefinitions")),
    name: v.string(),
    chain: v.array(agentBackup),
    checksOnly: v.optional(v.boolean()),
    // Omitted keeps the stored instructions; an empty string clears them.
    instructions: v.optional(v.string()),
  },
  returns: v.id("agentDefinitions"),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const name = args.name.trim();
    if (!name || name.length > NAME_LIMIT) fail("INVALID_ARGUMENT");
    const chain = cleanChain(args.chain);
    const checksOnly = args.checksOnly === true;
    const jobs = jobsFor(chain, checksOnly);
    if (!jobs.length) fail("INVALID_ARGUMENT");
    const instructions =
      args.instructions === undefined ? undefined : normalizeInstructions(args.instructions);
    const digest = instructions ? await instructionsDigest(instructions) : undefined;
    const now = Date.now();
    if (!args.agentId) {
      const count = (
        await ctx.db
          .query("agentDefinitions")
          .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
          .take(MAX_AGENTS + 1)
      ).filter((agent) => agent.archivedAt === undefined).length;
      if (count >= MAX_AGENTS) fail("LIMIT_EXCEEDED");
      return ctx.db.insert("agentDefinitions", {
        ownerId: owner._id,
        name,
        chain,
        ...(checksOnly ? { checksOnly } : {}),
        ...(instructions && digest ? { instructions, instructionsDigest: digest } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    const agent = await ownAgent(ctx, owner._id, args.agentId);
    const users = (await ownerProfiles(ctx, owner._id)).filter(
      (profile) => profile.agentId === agent._id,
    );
    if (users.some((profile) => profile.enabled && !jobs.includes(profile.role as Job)))
      fail(
        "AGENT_NOT_ALLOWED_FOR_JOB",
        "A workflow uses this agent for a job it could no longer do",
      );
    await ctx.db.patch(agent._id, {
      name,
      chain,
      checksOnly: checksOnly || undefined,
      ...(args.instructions !== undefined ? { instructions, instructionsDigest: digest } : {}),
      updatedAt: now,
    });
    const updated = await ownAgent(ctx, owner._id, agent._id);
    for (const profile of users)
      await ctx.db.patch(profile._id, {
        ...profileSettings(updated),
        revision: profile.revision + 1,
        updatedAt: now,
      });
    return agent._id;
  },
});

/** Deletes an agent; the jobs that used it keep their settings. */
export const remove = mutation({
  args: { agentId: v.id("agentDefinitions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const agent = await ownAgent(ctx, owner._id, args.agentId);
    const now = Date.now();
    for (const profile of await ownerProfiles(ctx, owner._id))
      if (profile.agentId === agent._id)
        await ctx.db.patch(profile._id, { agentId: undefined, updatedAt: now });
    await ctx.db.patch(agent._id, { archivedAt: now, updatedAt: now });
    return null;
  },
});

async function assignTo(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  scope: { productId?: Id<"products">; workflowId?: Id<"agentWorkflows"> },
  role: Job,
  agent: Doc<"agentDefinitions">,
) {
  if (!jobsFor(agent.chain, agent.checksOnly === true).includes(role))
    fail("AGENT_NOT_ALLOWED_FOR_JOB");
  const rows = (await ownerProfiles(ctx, ownerId)).filter(
    (row) =>
      row.role === role &&
      (scope.workflowId
        ? row.workflowId === scope.workflowId
        : row.productId === scope.productId && !row.workflowId),
  );
  const now = Date.now();
  const target =
    rows.find((row) => row.enabled) ?? [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (target) {
    await ctx.db.patch(target._id, {
      ...profileSettings(agent),
      agentId: agent._id,
      name: agent.name,
      enabled: true,
      revision: target.revision + 1,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("agentProfiles", {
    ownerId,
    ...(scope.productId ? { productId: scope.productId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...insertSettings(agent),
    agentId: agent._id,
    name: agent.name,
    role,
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Makes an agent do a job in a product's Default (no workflow) or one of its workflows.
 * Running and past runs keep their snapshot.
 */
export const assign = mutation({
  args: {
    // A workflow, else a product's own settings, else the Default (no product).
    productId: v.optional(v.id("products")),
    workflowId: v.optional(v.id("agentWorkflows")),
    role: job,
    agentId: v.id("agentDefinitions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    if (args.productId) {
      const product = await ctx.db.get(args.productId);
      if (!product || product.ownerId !== owner._id || product.archivedAt) fail("PRODUCT_MISMATCH");
    }
    if (args.workflowId) {
      const workflow = await ctx.db.get(args.workflowId);
      if (!workflow || workflow.ownerId !== owner._id || workflow.archivedAt !== undefined)
        fail("WORKFLOW_MISMATCH");
    }
    const agent = await ownAgent(ctx, owner._id, args.agentId);
    await assignTo(
      ctx,
      owner._id,
      args.workflowId
        ? { workflowId: args.workflowId }
        : args.productId
          ? { productId: args.productId }
          : {},
      args.role,
      agent,
    );
    return null;
  },
});

/**
 * A workflow's job goes back to the Default: its profile is turned off (kept, so runs that
 * started with it keep their link). Running and past runs keep their snapshot.
 */
export const unassign = mutation({
  args: { workflowId: v.id("agentWorkflows"), role: job },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const workflow = await ctx.db.get(args.workflowId);
    if (!workflow || workflow.ownerId !== owner._id || workflow.archivedAt !== undefined)
      fail("WORKFLOW_MISMATCH");
    const now = Date.now();
    for (const row of await ownerProfiles(ctx, owner._id))
      if (row.workflowId === workflow._id && row.role === args.role && row.enabled)
        await ctx.db.patch(row._id, { enabled: false, revision: row.revision + 1, updatedAt: now });
    return null;
  },
});

/**
 * Names a model wherever the owner's agents and jobs use a runtime without one (its own
 * default), e.g. Codex's GPT-6-Luna instead of its default GPT-6.1-Sol. Returns how many
 * agents and jobs changed. Running and past runs keep their snapshot.
 */
export const setUnnamedModel = mutation({
  args: { runtime: v.string(), model: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const owner = await requireUser(ctx);
    const model = args.model.trim();
    if (!model || model.length > 256) fail("INVALID_ARGUMENT");
    const offered = (await offeredModels(ctx, owner._id)).get(args.runtime) ?? [];
    if (!offered.includes(model)) fail("INVALID_ARGUMENT", "No computer offers that model");
    const name = <T extends { runtime: string; model?: string }>(entry: T): T =>
      entry.runtime === args.runtime && !entry.model ? { ...entry, model } : entry;
    const now = Date.now();
    let changed = 0;
    const agents = await ctx.db
      .query("agentDefinitions")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
      .take(MAX_AGENTS + 1);
    for (const agent of agents) {
      if (agent.archivedAt !== undefined) continue;
      const chain = agent.chain.map(name);
      if (chain.every((entry, index) => entry === agent.chain[index])) continue;
      await ctx.db.patch(agent._id, { chain, updatedAt: now });
      changed++;
    }
    for (const profile of await ownerProfiles(ctx, owner._id)) {
      const firstChanged = profile.runtime === args.runtime && !profile.model;
      const backups = profile.backups?.map(name);
      const backupsChanged = backups?.some((entry, index) => entry !== profile.backups?.[index]);
      if (!firstChanged && !backupsChanged) continue;
      await ctx.db.patch(profile._id, {
        ...(firstChanged ? { model } : {}),
        ...(backupsChanged ? { backups } : {}),
        revision: profile.revision + 1,
        updatedAt: now,
      });
      changed++;
    }
    return changed;
  },
});
