import { v } from "convex/values";

/**
 * Who failed and why, as reported by the Node for a Supervisor or Orchestrator turn: the
 * agent, its runtime and model (requested and reported), the provider's redacted reason and
 * when it failed. Shown to the owner next to the failed reply.
 */
export const failureDetail = v.object({
  agent: v.union(v.literal("supervisor"), v.literal("orchestrator")),
  runtime: v.string(),
  model: v.optional(v.string()),
  modelActual: v.optional(v.string()),
  reason: v.optional(v.string()),
  at: v.number(),
});
/** A failed agent run: the runtime's code and reason and when it failed. */
export const runFailure = v.object({
  code: v.optional(v.string()),
  reason: v.optional(v.string()),
  at: v.number(),
});

const bounded = (value: string | undefined, limit: number) =>
  value === undefined ? undefined : value.slice(0, limit);

/** Bounds every field: a Node is trusted for its own failures, not for their size. */
export function boundFailure<
  T extends { runtime: string; model?: string; modelActual?: string; reason?: string },
>(failure: T): T {
  const model = bounded(failure.model, 256);
  const modelActual = bounded(failure.modelActual, 256);
  const reason = bounded(failure.reason, 400);
  return {
    ...failure,
    runtime: failure.runtime.slice(0, 64),
    ...(model !== undefined ? { model } : {}),
    ...(modelActual !== undefined ? { modelActual } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}
