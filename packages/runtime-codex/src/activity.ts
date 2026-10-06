// Turns Codex app-server thread items (codex-cli 0.160.0 `ThreadItem`) into short, redacted,
// bounded activity for normalized events. Output, arguments, results and agent text are
// never copied; only the command line, tool identity or a fixed label.
import { isAbsolute, relative, resolve } from "node:path";
import { TOOL_READ_PATH_LIMIT, TOOL_READS_LIMIT } from "@zamolxis/contracts";
import { boundText, SUMMARY_LIMIT, safeSummary } from "@zamolxis/runtime-core";

// Shared with other adapters; re-exported for existing importers.
export { agentNote, fitPayload, PAYLOAD_LIMIT, redactedText } from "@zamolxis/runtime-core";

// Room left for a failure suffix (" · exit code 127", " · failed: <reason>").
const SUBJECT_LIMIT = 400;
const REASON_LIMIT = 80;

export type ItemActivity =
  | { kind: "tool"; tool: string; summary: string; success?: boolean }
  | { kind: "activity"; label: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Codex runs commands as `/bin/zsh -lc "<command>"`; show the command itself.
const SHELL_WRAPPER =
  /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^']|'\\'')*)')\s*$/;
export function displayCommand(command: string): string {
  const match = SHELL_WRAPPER.exec(command);
  if (match?.[1]) return match[1].replace(/\\(["\\$`])/g, "$1");
  if (match?.[2]) return match[2].replace(/'\\''/g, "'");
  return command.trim();
}

function subject(text: string): string {
  return safeSummary(text, SUBJECT_LIMIT);
}
function withReason(summary: string, reason: string | undefined): string {
  return boundText(reason ? `${summary} · ${reason}` : summary, SUMMARY_LIMIT);
}
function failureReason(error: unknown): string {
  const message = str(obj(error)?.message) ?? str(error);
  return message ? `failed: ${safeSummary(message, REASON_LIMIT)}` : "failed";
}

function webSearch(item: Record<string, unknown>): string {
  const action = obj(item.action);
  if (action?.type === "openPage" && str(action.url)) return `Open ${str(action.url)}`;
  if (action?.type === "findInPage" && str(action.pattern))
    return `Find "${str(action.pattern)}"${str(action.url) ? ` in ${str(action.url)}` : ""}`;
  const queries = Array.isArray(action?.queries) ? action.queries.filter(str) : [];
  const query =
    str(item.query) ?? str(action?.query) ?? (queries.length ? queries.join(" | ") : "");
  return query ? `Search "${query}"` : "Web search";
}

const COLLAB_LABEL: Record<string, string> = {
  spawnAgent: "Start sub-agent",
  sendInput: "Message sub-agent",
  sendMessage: "Message sub-agent",
  followupTask: "Follow-up for sub-agent",
  resumeAgent: "Resume sub-agent",
  wait: "Wait for sub-agents",
  closeAgent: "Close sub-agent",
  interruptAgent: "Interrupt sub-agent",
  listAgents: "List sub-agents",
};
// Items that only mark what the agent is doing; their text is never uploaded.
const ACTIVITY_LABEL: Record<string, string> = {
  reasoning: "Thinking",
  agentMessage: "Writing reply",
  plan: "Planning",
  contextCompaction: "Compacting context",
  enteredReviewMode: "Reviewing",
  imageView: "Viewing an image",
  imageGeneration: "Generating an image",
  sleep: "Waiting",
};

/**
 * Describes one item notification. Tools produce a start and a completion (with success and
 * a short failure reason); agent items produce a label when they start. Unknown or
 * user-originated items produce nothing.
 */
export function describeItem(
  item: Record<string, unknown>,
  done: boolean,
): ItemActivity | undefined {
  const status = item.status;
  switch (item.type) {
    case "commandExecution": {
      const command = str(item.command);
      const summary = command ? subject(displayCommand(command)) : "Command";
      if (!done) return { kind: "tool", tool: "command", summary };
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
      const success = status === "completed" && exitCode === 0;
      const reason = success
        ? undefined
        : status === "declined"
          ? "declined"
          : exitCode !== undefined && exitCode !== 0
            ? `exit code ${exitCode}`
            : "failed";
      return { kind: "tool", tool: "command", summary: withReason(summary, reason), success };
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const server = str(item.server) ?? str(item.namespace);
      const name = str(item.tool) ?? "tool";
      const summary = subject(server ? `${server}/${name}` : name);
      const tool = item.type === "mcpToolCall" ? "mcp" : "tool";
      if (!done) return { kind: "tool", tool, summary };
      const success = status === "completed" && item.success !== false && !item.error;
      return {
        kind: "tool",
        tool,
        summary: withReason(summary, success ? undefined : failureReason(item.error)),
        success,
      };
    }
    case "webSearch": {
      const summary = subject(webSearch(item));
      return done
        ? { kind: "tool", tool: "web", summary, success: true }
        : { kind: "tool", tool: "web", summary };
    }
    case "collabAgentToolCall": {
      const summary = subject(COLLAB_LABEL[String(item.tool)] ?? "Sub-agent");
      if (!done) return { kind: "tool", tool: "agent", summary };
      const success = status !== "failed";
      return {
        kind: "tool",
        tool: "agent",
        summary: withReason(summary, success ? undefined : "failed"),
        success,
      };
    }
    default: {
      const label = ACTIVITY_LABEL[String(item.type)];
      return label && !done ? { kind: "activity", label } : undefined;
    }
  }
}

/**
 * Files a command reads, from Codex's best-effort parse of the command line
 * (`commandActions` entries of type "read"). Workspace paths are shown relative to it;
 * every path is redacted and bounded. Undefined when the command reads nothing known.
 */
export function readPaths(item: Record<string, unknown>, cwd: string): string[] | undefined {
  if (item.type !== "commandExecution" || !Array.isArray(item.commandActions)) return undefined;
  const base = str(item.cwd) ?? cwd;
  const paths = new Set<string>();
  for (const value of item.commandActions) {
    const action = obj(value);
    const path = action?.type === "read" ? str(action.path) : undefined;
    if (!path) continue;
    const absolute = resolve(base, path);
    const local = relative(cwd, absolute);
    const inside = local && local !== ".." && !local.startsWith("../") && !isAbsolute(local);
    paths.add(safeSummary(inside ? local : absolute, TOOL_READ_PATH_LIMIT));
    if (paths.size >= TOOL_READS_LIMIT) break;
  }
  return paths.size ? [...paths] : undefined;
}
