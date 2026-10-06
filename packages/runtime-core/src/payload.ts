// Bounds shared by runtime adapters for what leaves them in normalized events.
import { RUN_MESSAGE_LIMIT } from "@zamolxis/contracts";
import { boundText, redactSecrets } from "./redaction";

/** Backend limit is 16 KiB of JSON per event payload; keep a margin. */
export const PAYLOAD_LIMIT = 15 * 1024;

/**
 * Keeps a payload under PAYLOAD_LIMIT bytes of JSON: drops trailing list entries first,
 * then shortens text fields. Small payloads are returned unchanged.
 */
export function fitPayload(
  payload: Record<string, unknown>,
  limit = PAYLOAD_LIMIT,
): Record<string, unknown> {
  const size = (value: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(value));
  if (size(payload) <= limit) return payload;
  const copy: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(copy)) {
    if (!Array.isArray(value)) continue;
    const list = [...value];
    copy[key] = list;
    while (list.length > 1 && size(copy) > limit) list.pop();
  }
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value !== "string") continue;
    let text = value;
    while (text.length > 1 && size(copy) > limit) {
      text = boundText(text, Math.floor(text.length * 0.8));
      copy[key] = text;
    }
  }
  return copy;
}

/** Redacted (not flattened) free text, such as the agent's final reply. */
export function redactedText(text: string, limit: number): string {
  return boundText(redactSecrets(text), limit);
}

/** An intermediate agent message: redacted, line breaks kept, bounded to RUN_MESSAGE_LIMIT. */
export function agentNote(text: string): string {
  return redactedText(text, RUN_MESSAGE_LIMIT);
}
