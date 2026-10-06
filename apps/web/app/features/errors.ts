import { ConvexError } from "convex/values";

const MESSAGES: Record<string, string> = {
  NODE_OR_RUNTIME_OFFLINE:
    "Your Mac is offline or its agent is unavailable. Make sure the Zamolxis Node is running and Codex or Claude Code is signed in, then try again.",
  PRODUCT_MISMATCH: "This session can't take new messages. Start a new session instead.",
  LIMIT_EXCEEDED: "This session has reached its task limit. Start a new session.",
  INVALID_ARGUMENT: "That message can't be sent. Keep it under 16,000 characters.",
  INVALID_STATE: "That action isn't available in the session's current state.",
  COMMAND_CONFLICT: "This message was already sent with different details. Refresh and try again.",
  WORK_CONTEXT_REQUIRED: "Choose a product and repository before asking Zamolxis to start work.",
  FORBIDDEN: "You don't have access to this.",
  NOT_FOUND: "This item no longer exists.",
};

export function errorCode(error: unknown): string | undefined {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown } | string;
    if (typeof data === "string") return data;
    if (typeof data?.code === "string") return data.code;
  }
  return undefined;
}

export function explainError(error: unknown, fallback: string): string {
  const code = errorCode(error);
  return (code && MESSAGES[code]) ?? fallback;
}

// Node failure codes stored on commands and tasks, shown in plain language.
const FAILURES: Record<string, string> = {
  STALE_REPOSITORY_CONTEXT: "the project changed while I was looking at it",
  REPOSITORY_DISCOVERY_REQUIRED: "your Mac couldn't open the project",
  INVALID_PLAN: "the plan didn't make sense, so nothing was started",
  LOCAL_OPERATION_FAILED: "something went wrong on your Mac",
  RECONCILIATION_REQUIRED: "your Mac needs a moment to catch up",
  SUPERVISOR_FAILED: "the AI model stopped with an error (it may be out of credits)",
  SUPERVISOR_INCOMPLETE: "the AI model didn't finish",
  SUPERVISOR_INTERRUPTED: "your Mac restarted while I was working",
};

/** A full sentence for a failed reply, with what the owner can do next. */
export function failedReplyText(code: string): string {
  const reason = explainFailure(code);
  return `Sorry, I couldn't answer: ${reason}. Send your message again${
    code.includes("SUPERVISOR_FAILED") ? " in a moment" : ""
  }.`;
}

export function explainFailure(code: string): string {
  const detail = (code.split(": ")[1] ?? code).split(";")[0]?.trim() ?? code;
  return FAILURES[detail] ?? detail.replaceAll("_", " ").toLowerCase();
}
