import type { Value } from "convex/values";
import { convexToJson } from "convex/values";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function valueKey(value: unknown): string {
  return JSON.stringify(canonical(convexToJson(value as Value)));
}
