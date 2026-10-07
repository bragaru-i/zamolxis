import { redactSecrets } from "@zamolxis/runtime-core";
import type { CheckEvidence } from "./checks";

/**
 * The reviewer's verdict per acceptance point (#162). A point it reports as not met is
 * failed evidence, so it can only block trust (sending the task to Repair with the
 * reason), never grant it: trust still needs the deterministic checks to pass. A reply
 * without a usable verdict adds nothing, as before.
 */
interface Point {
  readonly point: string;
  // null: the reviewer could not judge it from the repository; it never blocks.
  readonly met: boolean | null;
  readonly where: string;
}
const LIMIT = 4000;

function candidates(raw: string): string[] {
  const found: string[] = [];
  for (const match of raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g))
    if (match[1]) found.push(match[1].trim());
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) found.push(raw.slice(start, end + 1));
  return found;
}

export function parseAcceptance(raw: string | undefined): Point[] | undefined {
  for (const candidate of candidates(raw ?? "")) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { acceptance?: unknown }).acceptance
          : undefined;
      if (!Array.isArray(list) || !list.length) continue;
      const points = list.flatMap((item): Point[] => {
        if (!item || typeof item !== "object") return [];
        const { point, met, where } = item as Record<string, unknown>;
        if (
          typeof point !== "string" ||
          !point.trim() ||
          (typeof met !== "boolean" && met !== null)
        )
          return [];
        return [{ point: point.trim(), met, where: typeof where === "string" ? where.trim() : "" }];
      });
      if (points.length) return points.slice(0, 20);
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

export function acceptanceEvidence(raw: string | undefined): CheckEvidence | undefined {
  const points = parseAcceptance(raw);
  if (!points) return undefined;
  const missing = points.filter((item) => item.met === false);
  const met = points.filter((item) => item.met === true);
  const unknown = points.filter((item) => item.met === null);
  // Nothing judged: no evidence, as for a reply without a verdict.
  if (!missing.length && !met.length) return undefined;
  const line = (item: Point) => `${item.point}${item.where ? ` (${item.where})` : ""}`;
  const unjudged = unknown.length ? `; could not check: ${unknown.map(line).join("; ")}` : "";
  const summary = missing.length
    ? `Not met: ${missing.map(line).join("; ")}${unjudged}`
    : `All ${met.length} checked acceptance point${met.length === 1 ? "" : "s"} met: ${met.map(line).join("; ")}${unjudged}`;
  return {
    modality: "acceptance",
    result: missing.length ? "failed" : "passed",
    summary: redactSecrets(summary).slice(0, LIMIT),
  };
}
