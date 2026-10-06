// Claude Code CLI (2.1.287) stream-json protocol, as observed with `claude -p
// --input-format stream-json --output-format stream-json --verbose`:
//
// stdin frames (one JSON object per line):
//   {type:"user", message:{role:"user", content:"<text>"}, parent_tool_use_id:null, session_id:""}
//     A user turn. Sent while a turn runs, it is injected into that same turn (one result).
//   {type:"control_request", request_id, request:{subtype:"initialize"}}
//     Handshake; required before the CLI sends `can_use_tool`. Its response lists `models`
//     ({value, resolvedModel, displayName, description, supportedEffortLevels}).
//   {type:"control_request", request_id, request:{subtype:"interrupt"}}
//     Ends the running turn: held permission requests get `control_cancel_request`, the
//     turn ends with a `result` of subtype "error_during_execution".
//   {type:"control_response", response:{subtype:"success", request_id, response:{behavior:
//     "allow", updatedInput} | {behavior:"deny", message}}}  Answers `can_use_tool`.
//
// stdout frames:
//   system/init {session_id, cwd (real path), model, tools, permissionMode} after the first
//     user message; assistant {message:{model, content:[text|thinking|tool_use]}} (one
//     content block per frame); user {message:{content:[tool_result{tool_use_id,is_error}]}};
//   result {subtype:"success"|"error_*", is_error, result, usage{input_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens, output_tokens}, total_cost_usd}
//     ends the turn (usage covers the whole turn);
//   control_request {request_id, request:{subtype:"can_use_tool", tool_name, input,
//     description?, decision_reason?, blocked_path?, tool_use_id}} (only with
//     `--permission-prompt-tool stdio`; without it, prompts are denied silently);
//   control_cancel_request {request_id}: the CLI withdrew a held request;
//   control_response {response:{subtype, request_id, response}} for our requests.
//
// Sessions persist as ~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl.
// `--resume <id>` reattaches from any cwd (the CLI does not bind a session to its
// directory), so the adapter checks the transcript location itself. With stdin closed the
// CLI finishes its current turn before exiting: a session whose process may still be
// alive is never resumed.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentRole, boundRuntimeModels, type RuntimeModelDto } from "@zamolxis/runtime-core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// Verifier and Supervisor inspect the repository; they never edit it.
export function readOnlyRole(role: AgentRole | undefined): boolean {
  return role === "verifier" || role === "supervisor";
}

/**
 * Tools a read-only run may use: reading and searching files, and the shell commands
 * Claude Code itself classifies as read-only (anything else is denied by `dontAsk`).
 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;
/** Tools a Builder or Repair run may use. No web, MCP, sub-agent, scheduling or skill tools. */
export const WRITE_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
] as const;
/**
 * Builder/Repair settings: commands run in Claude Code's OS sandbox (writes confined to the
 * workspace, network asks) without a prompt each; anything that leaves it (network, writes
 * outside the workspace, unsandboxed commands) is a permission request to the human.
 */
export const WRITE_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
});

export interface ClaudeArgsInput {
  readonly role?: AgentRole;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** A new session with this id (`--session-id`), or an existing one (`--resume`). */
  readonly sessionId?: string;
  readonly resume?: string;
}
/** Arguments for one CLI process of a run. Never a bypass permission mode. */
export function claudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Permission prompts go to this host over the control protocol.
    "--permission-prompts",
    "host",
    "--permission-prompt-tool",
    "stdio",
    // User and repository settings (allow rules, hooks, plugins) and MCP servers are not
    // execution grants; only the CLI's login is reused.
    "--setting-sources",
    "",
    "--strict-mcp-config",
  ];
  if (readOnlyRole(input.role)) {
    // dontAsk: anything not read-only is denied without a prompt.
    args.push("--permission-mode", "dontAsk", "--tools", READ_ONLY_TOOLS.join(","));
  } else {
    // acceptEdits: file edits inside the workspace need no prompt, like Codex's
    // workspace-write sandbox; edits elsewhere still ask.
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--tools",
      WRITE_TOOLS.join(","),
      "--settings",
      WRITE_SETTINGS,
    );
  }
  // The Supervisor is Node-local and never resumed: nothing to keep.
  if (input.role === "supervisor") args.push("--no-session-persistence");
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
  if (input.resume) args.push("--resume", input.resume);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  return args;
}

/** The arguments for a process that only answers `initialize` (model listing). */
export function catalogArgs(): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
}

export function userMessage(text: string): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}
export function controlRequest(
  requestId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "control_request", request_id: requestId, request };
}
export function controlSuccess(
  requestId: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}
export function controlError(requestId: string, error: string): Record<string, unknown> {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}

/** Real path when it exists; the CLI reports its cwd resolved. */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Where Claude Code keeps sessions: CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
// Claude Code names a project directory after its cwd with every non-alphanumeric
// character replaced by "-", shortened (with a suffix) beyond 200 characters.
const PROJECT_NAME_LIMIT = 200;
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
/** True when the session's transcript exists under the workspace's project directory. */
export function sessionTranscriptExists(
  cwd: string,
  sessionId: string,
  configDir = claudeConfigDir(),
): boolean {
  if (!isSessionId(sessionId)) return false;
  const projects = join(configDir, "projects");
  const name = projectDirName(realPath(cwd));
  if (existsSync(join(projects, name, `${sessionId}.jsonl`))) return true;
  if (name.length <= PROJECT_NAME_LIMIT) return false;
  const prefix = name.slice(0, PROJECT_NAME_LIMIT);
  try {
    return readdirSync(projects).some(
      (entry) =>
        entry.startsWith(prefix) && existsSync(join(projects, entry, `${sessionId}.jsonl`)),
    );
  } catch {
    return false;
  }
}
/**
 * True when any process on this machine names the session in its arguments (`--session-id`
 * or `--resume`): a CLI that outlived a previous Node process may still be working on it.
 * Conservative: an unreadable process list counts as running.
 */
export function sessionProcessRunning(sessionId: string): boolean {
  try {
    const list = execFileSync("ps", ["-axww", "-o", "args="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return list.split("\n").some((line) => line.includes(sessionId) && /claude/.test(line));
  } catch {
    return true;
  }
}

/**
 * Maps the `initialize` response's model list. "default" names the CLI's default model:
 * it is reported under its resolved id and marked default; an alias whose resolved model
 * is already listed is dropped. Ids are what `--model` accepts.
 */
export function mapModels(models: unknown): RuntimeModelDto[] {
  if (!Array.isArray(models)) throw new Error("CLAUDE_INVALID_RESPONSE");
  const entries = models.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  const listed = new Set<string>();
  const mapped: unknown[] = [];
  const efforts = (entry: Record<string, unknown>) =>
    entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels
      : undefined;
  const fallback = entries.find((entry) => str(entry.value) === "default");
  const defaultId = fallback ? str(fallback.resolvedModel) : "";
  if (fallback && defaultId) {
    // Its display name comes from the alias for the same model when there is one.
    const named = entries.find(
      (entry) => entry !== fallback && str(entry.resolvedModel) === defaultId,
    );
    mapped.push({
      id: defaultId,
      displayName: str(named?.displayName) || str(fallback.displayName) || defaultId,
      description: named?.description ?? fallback.description,
      isDefault: true,
      efforts: efforts(fallback),
    });
    listed.add(defaultId);
  }
  for (const entry of entries) {
    const value = str(entry.value);
    if (!value || entry === fallback) continue;
    const resolved = str(entry.resolvedModel);
    // Full ids are kept as they are; an alias is listed under its resolved id.
    const id = value.startsWith("claude-") ? value : resolved || value;
    if (listed.has(id) || (resolved && listed.has(resolved))) continue;
    listed.add(id);
    if (resolved) listed.add(resolved);
    mapped.push({
      id,
      displayName: entry.displayName,
      description: entry.description,
      efforts: efforts(entry),
    });
  }
  return boundRuntimeModels(mapped);
}

/**
 * Usage of a turn from a `result` frame. Input tokens count everything the model read
 * (new, cache-written and cache-read input); cached input is the cache-read part, so
 * cached <= input like Codex reports. Undefined unless every counter is a safe integer.
 */
export function turnUsage(
  usage: unknown,
): { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const raw = usage as Record<string, unknown>;
  const count = (value: unknown) =>
    value === undefined
      ? 0
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : Number.NaN;
  const input = count(raw.input_tokens);
  const written = count(raw.cache_creation_input_tokens);
  const read = count(raw.cache_read_input_tokens);
  const output = count(raw.output_tokens);
  if ([input, written, read, output].some(Number.isNaN)) return undefined;
  if (typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number")
    return undefined;
  return { inputTokens: input + written + read, cachedInputTokens: read, outputTokens: output };
}
