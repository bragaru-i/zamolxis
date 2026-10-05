import { explainFailure } from "./errors";

export type Decision = "answer" | "plan" | "ask";

/** One user message with the Supervisor outcome, as returned by `supervisor.messages`. */
export interface ConversationMessage {
  planned: boolean;
  planTaskCount: number;
  planStatus: string;
  planError?: string;
  decision?: Decision;
  reply?: string;
  supervisor?: { modelActual?: string; totalTokens?: number };
}

export type AssistantReply =
  | { kind: "thinking"; reply?: string }
  | { kind: "answer"; reply: string }
  | { kind: "ask"; reply: string }
  | { kind: "plan"; reply?: string; taskCount: number }
  | { kind: "error"; text: string };

const IN_FLIGHT = ["pending", "claimed", "acknowledged"];

/** What the Zamolxis message under a user message should show. */
export function assistantReply(message: ConversationMessage): AssistantReply {
  const reply = message.reply?.trim() ? message.reply : undefined;
  if (message.planStatus === "failed") {
    return {
      kind: "error",
      text: `I couldn't plan this: ${explainFailure(message.planError ?? "unknown error")}.`,
    };
  }
  if (message.planStatus === "expired") {
    return { kind: "error", text: "Planning didn't start in time. Send the message again." };
  }
  if (message.decision === "answer" && reply) return { kind: "answer", reply };
  if (message.decision === "ask" && reply) return { kind: "ask", reply };
  if (message.planned || (message.decision === "plan" && !IN_FLIGHT.includes(message.planStatus))) {
    return { kind: "plan", taskCount: message.planTaskCount, ...(reply ? { reply } : {}) };
  }
  if (message.decision === "answer" || message.decision === "ask") {
    // A decision without text: nothing useful to show beyond completion.
    return IN_FLIGHT.includes(message.planStatus)
      ? { kind: "thinking" }
      : { kind: "answer", reply: "Done." };
  }
  return { kind: "thinking", ...(reply ? { reply } : {}) };
}

export function plannedLabel(count: number): string {
  return `Planned ${count} ${count === 1 ? "task" : "tasks"}.`;
}

/** "gpt-5 · 1,234 tokens" when usage was reported; undefined otherwise. */
export function usageLine(message: ConversationMessage): string | undefined {
  const tokens = message.supervisor?.totalTokens;
  if (tokens === undefined) return undefined;
  const model = message.supervisor?.modelActual;
  const count = `${tokens.toLocaleString("en-US")} ${tokens === 1 ? "token" : "tokens"}`;
  return model ? `${model} · ${count}` : count;
}

/** Sessions that refuse follow-ups; sending there starts a new session instead. */
export function startsNewSession(status: string | undefined): boolean {
  return status === "cancelled";
}

/** Rough check used before layout is measured (and for server rendering). */
export function likelyLongSummary(text: string): boolean {
  return text.length > 280 || text.split("\n").length > 4;
}
