import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { fail, load, requireNode, requireUser } from "./lib/access";
import { digest } from "./pairing";

async function reactivate(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
  workstationId: Id<"workstations">,
) {
  const location = await ctx.db
    .query("repositoryLocations")
    .withIndex("by_repository_workstation", (q) =>
      q.eq("repositoryId", repositoryId).eq("workstationId", workstationId),
    )
    .unique();
  if (location?.status !== "removed") return;
  // "missing" until the Node registers the location again and finds it intact.
  await ctx.db.patch("repositoryLocations", location._id, {
    status: "missing",
    removedAt: undefined,
    updatedAt: Date.now(),
  });
}
export const registerRepositories = mutation({
  args: {
    workstationId: v.id("workstations"),
    repositories: v.array(v.object({ name: v.string(), remoteUrl: v.string() })),
    // The owner re-granted these repositories in setup: locations removed earlier on
    // this Mac become eligible again once the Node verifies them (#45).
    reactivate: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      repositoryId: v.id("repositories"),
      productId: v.id("products"),
      remoteUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const node = await requireNode(ctx, args.workstationId);
    if (args.repositories.length > 32) fail("INVALID_ARGUMENT");
    const result = [];
    for (const item of args.repositories) {
      if (
        !item.name.trim() ||
        item.name.length > 100 ||
        !item.remoteUrl ||
        item.remoteUrl.length > 2048
      )
        fail("INVALID_ARGUMENT");
      const previous = await ctx.db
        .query("repositories")
        .withIndex("by_owner_remote", (q) =>
          q.eq("ownerId", node.ownerId).eq("remoteUrl", item.remoteUrl),
        )
        .unique();
      if (previous && args.reactivate) await reactivate(ctx, previous._id, node._id);
      if (previous?.productId) {
        const product = await load(ctx, "products", previous.productId);
        if (product.ownerId !== node.ownerId || product.archivedAt) fail("FORBIDDEN");
        result.push({
          repositoryId: previous._id,
          productId: product._id,
          remoteUrl: item.remoteUrl,
        });
        continue;
      }
      const slug = `repo-${(await digest(item.remoteUrl)).slice(0, 32)}`;
      const product = await ctx.db
        .query("products")
        .withIndex("by_owner_slug", (q) => q.eq("ownerId", node.ownerId).eq("slug", slug))
        .unique();
      const now = Date.now();
      const productId =
        product?._id ??
        (await ctx.db.insert("products", {
          ownerId: node.ownerId,
          name: item.name,
          slug,
          createdAt: now,
          updatedAt: now,
        }));
      if (product?.archivedAt) fail("FORBIDDEN");
      const repositoryId =
        previous?._id ??
        (await ctx.db.insert("repositories", {
          ownerId: node.ownerId,
          productId,
          ...item,
          createdAt: now,
          updatedAt: now,
        }));
      if (previous) await ctx.db.patch("repositories", repositoryId, { productId, updatedAt: now });
      result.push({ repositoryId, productId, remoteUrl: item.remoteUrl });
    }
    return result;
  },
});

// Onboarding progress (#45): how far the owner got from signing in to the first session,
// derived only from stored state (pairing, credential, heartbeat, runtimes, repository
// locations, sessions). Nothing is assumed or simulated.
export const ONLINE_WINDOW_MS = 45_000;
export type OnboardingState = "done" | "in_progress" | "needs_you" | "failed" | "upcoming";
type StepId = "signin" | "access" | "pair" | "repositories" | "service" | "runtime" | "session";
export interface OnboardingStep {
  id: StepId;
  title: string;
  state: OnboardingState;
  detail: string;
  /**
   * A query result does not age by itself. After this time the Mac has stopped reporting
   * heartbeats and the client shows `stale` instead.
   */
  staleAfter?: number;
  stale?: { state: OnboardingState; detail: string };
}
const TITLES: Record<StepId, string> = {
  signin: "Sign in",
  access: "Access approved",
  pair: "Pair your Mac",
  repositories: "Choose repositories",
  service: "Start Zamolxis on your Mac",
  runtime: "Agent runtime ready",
  session: "Start your first session",
};
const REPAIR = "Open Terminal on your Mac and run `pnpm zamolxis setup --repair`.";
const state = v.union(
  v.literal("done"),
  v.literal("in_progress"),
  v.literal("needs_you"),
  v.literal("failed"),
  v.literal("upcoming"),
);

function step(
  id: StepId,
  value: OnboardingState,
  detail = "",
  extra: Pick<OnboardingStep, "staleAfter" | "stale"> = {},
): OnboardingStep {
  return { id, title: TITLES[id], state: value, detail, ...extra };
}
function repositories(count: number) {
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}

/** The signed-in owner's onboarding checklist, in order. */
export const progress = query({
  args: {},
  returns: v.object({
    complete: v.boolean(),
    steps: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        state,
        detail: v.string(),
        staleAfter: v.optional(v.number()),
        stale: v.optional(v.object({ state, detail: v.string() })),
      }),
    ),
  }),
  handler: async (ctx) => {
    // Reaching this point proves the first two steps: a valid sign-in with granted access.
    const owner = await requireUser(ctx);
    const now = Date.now();
    const online = (device: Doc<"workstations">) =>
      device.status === "online" && (device.lastHeartbeatAt ?? 0) > now - ONLINE_WINDOW_MS;
    // The Mac that got furthest: online, then most recently heard from, then newest.
    const mac = (
      await ctx.db
        .query("workstations")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
        .take(50)
    )
      .filter((device) => device.status !== "revoked")
      .sort(
        (a, b) =>
          Number(online(b)) - Number(online(a)) ||
          (b.lastHeartbeatAt ?? 0) - (a.lastHeartbeatAt ?? 0) ||
          b.registeredAt - a.registeredAt,
      )[0];
    const session = await ctx.db
      .query("workSessions")
      .withIndex("by_owner_activity", (q) => q.eq("ownerId", owner._id))
      .first();
    const registered = (
      await ctx.db
        .query("repositories")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner._id))
        .take(101)
    ).filter((repository) => repository.productId).length;
    const steps = [
      step("signin", "done", "You are signed in."),
      step("access", "done", "Your account has access."),
    ];
    if (!mac) {
      steps.push(
        step(
          "pair",
          "needs_you",
          "Run `pnpm zamolxis setup` on your Mac, then scan the QR code it shows with this phone and approve the Mac.",
        ),
        step("repositories", "upcoming"),
        step("service", "upcoming"),
        step("runtime", "upcoming"),
      );
    } else {
      const name = mac.name;
      const credential = await ctx.db
        .query("deviceCredentials")
        .withIndex("by_workstation", (q) => q.eq("workstationId", mac._id))
        .first();
      const heard = mac.lastHeartbeatAt !== undefined;
      // Approval creates the workstation; setup then activates its device credential.
      const paired = credential !== null || heard;
      steps.push(
        paired
          ? step("pair", "done", `${name} is paired.`)
          : step(
              "pair",
              "in_progress",
              `You approved ${name}. Setup on your Mac is finishing pairing; keep it open.`,
            ),
      );
      const locations = await ctx.db
        .query("repositoryLocations")
        .withIndex("by_workstation", (q) => q.eq("workstationId", mac._id))
        .take(101);
      const available = locations.filter((item) => item.status === "available").length;
      const allRemoved =
        locations.length > 0 && locations.every((item) => item.status === "removed");
      steps.push(
        available
          ? step("repositories", "done", `${repositories(available)} ready on ${name}.`)
          : !paired
            ? step("repositories", "upcoming")
            : allRemoved || (heard && !registered)
              ? step(
                  "repositories",
                  "needs_you",
                  "No repository is enabled on this Mac. Run `pnpm zamolxis setup` on your Mac and choose Add or remove repositories.",
                )
              : locations.length
                ? step(
                    "repositories",
                    "failed",
                    `${name} could not open its repositories. Check that they still exist on the Mac, then run \`pnpm zamolxis setup --repair\`.`,
                  )
                : step(
                    "repositories",
                    "in_progress",
                    registered
                      ? `${repositories(registered)} registered. ${name} checks them when Zamolxis starts.`
                      : "Choose at least one Git repository in setup on your Mac.",
                  ),
      );
      const offline = { state: "failed" as const, detail: `${name} is offline. ${REPAIR}` };
      steps.push(
        !paired
          ? step("service", "upcoming")
          : !heard
            ? step(
                "service",
                "in_progress",
                `Setup installs the background service and waits for the first heartbeat from ${name}. If nothing happens within a minute: ${REPAIR}`,
              )
            : online(mac)
              ? step("service", "done", `${name} is online.`, {
                  staleAfter: (mac.lastHeartbeatAt ?? 0) + ONLINE_WINDOW_MS,
                  stale: offline,
                })
              : step("service", offline.state, offline.detail),
      );
      const runtimes = heard
        ? await ctx.db
            .query("runtimeInstallations")
            .withIndex("by_workstation", (q) => q.eq("workstationId", mac._id))
            .take(33)
        : [];
      if (runtimes.length > 32) fail("LIMIT_EXCEEDED");
      const runtime = runtimes.find(
        (item) => item.status === "available" && item.capabilities.includes("start"),
      );
      steps.push(
        !heard
          ? step("runtime", "upcoming")
          : runtime
            ? step("runtime", "done", `${runtime.version ?? runtime.runtime} is ready on ${name}.`)
            : step(
                "runtime",
                "failed",
                `No agent runtime is available on ${name}. Install and sign in to Codex or Claude Code, then run \`pnpm zamolxis setup --repair\`.`,
              ),
      );
    }
    const ready = steps.every((item) => item.state === "done");
    steps.push(
      session
        ? step("session", "done", "You started your first session.")
        : ready
          ? step("session", "needs_you", "Describe what you want to build in the box below.")
          : step("session", "upcoming"),
    );
    return { complete: session !== null, steps };
  },
});
