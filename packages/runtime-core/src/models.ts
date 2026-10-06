/** A model a runtime offers, with the reasoning efforts it supports. */
export interface RuntimeModelDto {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}
export const RUNTIME_MODEL_LIMITS = {
  models: 50,
  id: 256,
  displayName: 128,
  description: 300,
  efforts: 10,
  effort: 64,
} as const;
function clean(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}
/**
 * Normalizes and bounds a runtime's model list: entries without a usable id are dropped,
 * ids are deduplicated (first wins), text is trimmed and truncated, and at most
 * RUNTIME_MODEL_LIMITS.models entries are kept. An id longer than its limit is dropped
 * rather than truncated, since a truncated id would name a different model.
 */
export function boundRuntimeModels(models: readonly unknown[]): RuntimeModelDto[] {
  const result: RuntimeModelDto[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (result.length >= RUNTIME_MODEL_LIMITS.models) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || id.length > RUNTIME_MODEL_LIMITS.id || seen.has(id)) continue;
    seen.add(id);
    const efforts = Array.isArray(raw.efforts)
      ? [
          ...new Set(
            raw.efforts
              .map((effort) => clean(effort, RUNTIME_MODEL_LIMITS.effort))
              .filter((effort): effort is string => effort !== undefined),
          ),
        ].slice(0, RUNTIME_MODEL_LIMITS.efforts)
      : [];
    const description = clean(raw.description, RUNTIME_MODEL_LIMITS.description);
    const defaultEffort = clean(raw.defaultEffort, RUNTIME_MODEL_LIMITS.effort);
    result.push({
      id,
      displayName:
        clean(raw.displayName, RUNTIME_MODEL_LIMITS.displayName) ??
        id.slice(0, RUNTIME_MODEL_LIMITS.displayName),
      ...(description ? { description } : {}),
      ...(raw.isDefault === true ? { isDefault: true } : {}),
      ...(efforts.length ? { efforts } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return result;
}
