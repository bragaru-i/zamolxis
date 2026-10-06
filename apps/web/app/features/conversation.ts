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
  /** Reported by the Mac while the Supervisor works. */
  progress?: { activity?: string; startedAt: number };
  /** The owner asked to stop the Supervisor and the Mac has not confirmed yet. */
  stopping?: boolean;
  /** The Supervisor stopped before answering. */
  stopped?: boolean;
}

export type AssistantReply =
  | {
      kind: "thinking";
      reply?: string;
      /** What the Supervisor is doing now, and since when (only while it works). */
      activity?: string;
      startedAt?: number;
      /** The Supervisor is still deciding, so it can be stopped. */
      stoppable?: true;
      stopping?: true;
    }
  | { kind: "answer"; reply: string }
  | { kind: "ask"; reply: string }
  | { kind: "plan"; reply?: string; taskCount: number }
  | { kind: "stopped" }
  | { kind: "error"; text: string };

const IN_FLIGHT = ["pending", "claimed", "acknowledged"];

/** What the Zamolxis message under a user message should show. */
export function assistantReply(message: ConversationMessage): AssistantReply {
  const reply = message.reply?.trim() ? message.reply : undefined;
  if (
    message.stopped ||
    (message.planStatus === "failed" && message.planError === "SUPERVISOR_STOPPED")
  ) {
    return { kind: "stopped" };
  }
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
  // No decision yet: the Supervisor is still working and can be stopped.
  const working =
    !message.planned && message.decision === undefined && IN_FLIGHT.includes(message.planStatus);
  return {
    kind: "thinking",
    ...(reply ? { reply } : {}),
    ...(working
      ? {
          stoppable: true as const,
          ...(message.stopping ? { stopping: true as const } : {}),
          ...(message.progress?.activity ? { activity: message.progress.activity } : {}),
          ...(message.progress ? { startedAt: message.progress.startedAt } : {}),
        }
      : {}),
  };
}

/** "12s", "1m 05s", "1h 02m": how long the Supervisor has been working. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The line under "Thinking…": the current activity and the elapsed time. */
export function thinkingDetail(
  state: Extract<AssistantReply, { kind: "thinking" }>,
  fallback: string,
  now: number,
): string {
  const activity = state.stopping ? "Stopping…" : (state.activity ?? fallback);
  return state.startedAt === undefined
    ? activity
    : `${activity} · ${elapsedLabel(now - state.startedAt)}`;
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
