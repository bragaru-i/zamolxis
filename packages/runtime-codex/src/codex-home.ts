import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** Rollouts older than this are removed when the Node starts (default 30 days). */
export const ROLLOUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CodexHomeOptions {
  /** The user's Codex login (`auth.json`), copied in on every start. */
  readonly authSource: string;
  readonly retentionMs?: number;
  readonly now?: () => number;
}

/**
 * The Node-owned `config.toml`, rewritten on every start. Zamolxis agents get a shell, file
 * edits and the repository's AGENTS.md; everything Codex adds to the fixed prompt for
 * interactive use is turned off because Builders and Verifiers never use it and it is
 * resent on every model call (#114): sub-agent orchestration, skills and plugin
 * suggestions, apps, goals, memories, hooks, browser and computer use, image generation,
 * realtime and web search (the sandbox has no network anyway). Trust, approvals and the
 * sandbox come from each turn's request, never from this file.
 */
export const CODEX_CONFIG = [
  "# Written by Zamolxis on every Node start; edits are lost. Keep agent prompts lean (#114).",
  'web_search = "disabled"',
  "",
  "[features]",
  "multi_agent = false",
  "goals = false",
  "plugins = false",
  "apps = false",
  "tool_suggest = false",
  "skill_search = false",
  "recommended_plugins = false",
  "browser_use = false",
  "computer_use = false",
  "image_generation = false",
  "memories = false",
  "hooks = false",
  "realtime_conversation = false",
  "",
  "[agents]",
  "enabled = false",
  "",
  "[skills]",
  "# Smallest allowed budget for the skills catalog: Zamolxis agents use no skills.",
  "max_context_tokens = 1",
  "",
].join("\n");

/**
 * Prepares the Node's own CODEX_HOME. It persists across Node restarts because Codex keeps
 * each thread's rollout there (`sessions/YYYY/MM/DD/rollout-*.jsonl`) and `thread/resume`
 * needs it to reattach a run. Only the login is reused from the user's Codex home: user
 * config, plugins and MCP servers are not execution grants; the Node writes its own lean
 * `config.toml` (CODEX_CONFIG) instead. Old rollouts are pruned.
 */
export function prepareCodexHome(home: string, options: CodexHomeOptions): void {
  if (!isAbsolute(home)) throw new Error("CODEX_HOME_NOT_ABSOLUTE");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(home);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("UNSAFE_CODEX_HOME");
  chmodSync(home, 0o700);
  const auth = join(home, "auth.json");
  const config = join(home, "config.toml");
  for (const path of [auth, config]) {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error("UNSAFE_CODEX_HOME");
  }
  copyFileSync(options.authSource, auth);
  chmodSync(auth, 0o600);
  writeFileSync(config, CODEX_CONFIG, { mode: 0o600 });
  chmodSync(config, 0o600);
  pruneRollouts(
    join(home, "sessions"),
    (options.now?.() ?? Date.now()) - (options.retentionMs ?? ROLLOUT_RETENTION_MS),
  );
}

/** Removes the copied login (rollouts stay for the next start). */
export function releaseCodexHome(home: string): void {
  rmSync(join(home, "auth.json"), { force: true });
}

// Rollout files are at most four levels deep (YYYY/MM/DD/file); symlinks are never followed.
function pruneRollouts(directory: string, before: number, depth = 0): void {
  if (depth > 3) return;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(directory, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) pruneRollouts(path, before, depth + 1);
    else if (stat.isFile() && /^rollout-.*\.jsonl$/.test(name) && stat.mtimeMs < before)
      rmSync(path, { force: true });
  }
}
