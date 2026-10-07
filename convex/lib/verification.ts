import { v } from "convex/values";

/**
 * How the Verifier role verifies a candidate. "review" runs a reviewer model in the
 * verifier worktree before the Node's deterministic checks; "checks_only" runs no model:
 * the repository's own checks are the whole evidence. Trust is decided from the checks
 * either way, so checks-only verification is cheaper, not weaker (#114).
 */
export const VERIFICATION_MODES = ["review", "checks_only"] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export const verification = v.union(v.literal("review"), v.literal("checks_only"));
