// Turns Claude Code tool calls into short, redacted, bounded activity. Tool output, file
// contents and agent text are never copied; only the command line, a path or the tool name.
import { isAbsolute, relative, resolve } from "node:path";
import type { ApprovalKind, ApprovalRisk } from "@zamolxis/contracts";
import { TOOL_READ_PATH_LIMIT } from "@zamolxis/contracts";
import {
  approvalSummary,
  boundText,
  classifyCommandRisk,
  insideWorkspace,
  maxRisk,
  redactSecrets,
  SUMMARY_LIMIT,
  safeSummary,
} from "@zamolxis/runtime-core";

// Room left for a failure suffix (" · failed", " · declined").
const SUBJECT_LIMIT = 400;
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** The path a file tool names (`file_path`, or `notebook_path` for notebooks). */
export function toolPath(input: Record<string, unknown>): string | undefined {
  return str(input.file_path) ?? str(input.notebook_path);
}
/** Workspace-relative when inside the workspace, absolute otherwise. */
function shown(path: string, cwd: string): { path: string; inside: boolean } {
  const absolute = resolve(cwd, path);
  const local = relative(cwd, absolute);
  const inside = !!local && local !== ".." && !local.startsWith("../") && !isAbsolute(local);
  return { path: inside ? local : absolute, inside: inside || absolute === cwd };
}

export interface ToolActivity {
  readonly tool: string;
  readonly summary: string;
  readonly reads?: string[];
}
/** The start of a tool call. Bash is a "command" (shown as its command line). */
export function describeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): ToolActivity {
  if (name === "Bash") {
    const command = str(input.command);
    return { tool: "command", summary: command ? safeSummary(command, SUBJECT_LIMIT) : "Command" };
  }
  const path = toolPath(input);
  if (name === "Read" && path) {
    const read = shown(path, cwd).path;
    return {
      tool: "Read",
      summary: safeSummary(`Read ${read}`, SUBJECT_LIMIT),
      reads: [safeSummary(read, TOOL_READ_PATH_LIMIT)],
    };
  }
  if (FILE_TOOLS.has(name) && path)
    return { tool: name, summary: safeSummary(`${name} ${shown(path, cwd).path}`, SUBJECT_LIMIT) };
  return {
    tool: safeSummary(name, 64) || "tool",
    summary: safeSummary(name, SUBJECT_LIMIT) || "Tool",
  };
}
/** The completion of a tool call: the start summary, with a reason when it failed. */
export function completedSummary(summary: string, success: boolean, declined: boolean): string {
  if (success) return summary;
  return boundText(`${summary} · ${declined ? "declined" : "failed"}`, SUMMARY_LIMIT);
}

/** Workspace-relative paths a successful file tool changed; outside paths are excluded. */
export function changedPath(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { path: string; inside: boolean } | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  const path = toolPath(input);
  return path ? shown(path, cwd) : undefined;
}

export interface HeldOperation {
  readonly kind: ApprovalKind;
  readonly summary: string;
  readonly risk: ApprovalRisk;
}
// Approval text is redacted; the risk is classified from the original command.
function redactedSummary(parts: readonly (string | undefined)[]): string {
  return approvalSummary(parts.map((part) => (part ? redactSecrets(part) : part)));
}
/**
 * Describes a `can_use_tool` permission request for a human. Risk is conservative and for
 * display only: every request still needs an explicit decision.
 */
export function describePermission(
  request: Record<string, unknown>,
  workspace: string,
): HeldOperation {
  const tool = str(request.tool_name) ?? "tool";
  const input =
    request.input && typeof request.input === "object" && !Array.isArray(request.input)
      ? (request.input as Record<string, unknown>)
      : {};
  const reason = str(request.decision_reason)?.slice(0, 500);
  const blocked = str(request.blocked_path);
  const outside = blocked ? !insideWorkspace(resolve(workspace, blocked), workspace) : false;
  if (tool === "Bash") {
    const command = str(input.command)?.slice(0, 1800);
    const unsandboxed = input.dangerouslyDisableSandbox === true;
    return {
      kind: "command",
      summary: redactedSummary([
        `Run: ${command ?? "(command not shown)"}`,
        unsandboxed ? "Outside the sandbox" : undefined,
        blocked && outside ? `Touches: ${blocked}` : undefined,
        reason ? `Reason: ${reason}` : undefined,
      ]),
      risk: command
        ? maxRisk(
            classifyCommandRisk({ command, workspace }),
            unsandboxed ? "high" : "low",
            outside ? "critical" : "low",
          )
        : "high",
    };
  }
  if (tool === "SandboxNetworkAccess") {
    const host = str(input.host)?.slice(0, 200);
    return {
      kind: "command",
      summary: redactedSummary([`Network access to ${host ?? "(host not shown)"}`]),
      risk: "high",
    };
  }
  const path = toolPath(input);
  if (FILE_TOOLS.has(tool)) {
    const target = path ? shown(path, workspace) : undefined;
    return {
      kind: "fileChange",
      summary: redactedSummary([
        target ? `Change files: ${target.path}` : "Change files",
        target && !target.inside ? "Outside the workspace" : undefined,
        reason ? `Reason: ${reason}` : undefined,
      ]),
      risk: target?.inside ? "medium" : "critical",
    };
  }
  const description = str(request.description)?.slice(0, 1500);
  return {
    kind: "tool",
    summary: redactedSummary([
      `Use ${tool}${description ? `: ${description}` : ""}`,
      path ? `Path: ${path}` : undefined,
      reason ? `Reason: ${reason}` : undefined,
    ]),
    risk: path && !insideWorkspace(resolve(workspace, path), workspace) ? "critical" : "high",
  };
}
