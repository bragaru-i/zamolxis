import { ConvexError } from "convex/values";

const MESSAGES: Record<string, string> = {
  NODE_OR_RUNTIME_OFFLINE:
    "Your Mac is offline or Codex is unavailable. Make sure the Zamolxis Node is running, then try again.",
  PRODUCT_MISMATCH: "This session can't take new messages. Start a new session instead.",
  LIMIT_EXCEEDED: "This session has reached its task limit. Start a new session.",
  INVALID_ARGUMENT: "That message can't be sent. Keep it under 16,000 characters.",
  INVALID_STATE: "That action isn't available in the session's current state.",
  COMMAND_CONFLICT: "This message was already sent with different details. Refresh and try again.",
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
  STALE_REPOSITORY_CONTEXT: "the repository changed while planning",
  REPOSITORY_DISCOVERY_REQUIRED: "the Mac couldn't read the repository",
  INVALID_PLAN: "the plan was invalid",
  LOCAL_OPERATION_FAILED: "a local operation failed on your Mac",
  RECONCILIATION_REQUIRED: "the Mac needs to reconcile its state",
};

export function explainFailure(code: string): string {
  const detail = (code.split(": ")[1] ?? code).split(";")[0]?.trim() ?? code;
  return FAILURES[detail] ?? detail.replaceAll("_", " ").toLowerCase();
}
