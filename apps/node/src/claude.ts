import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeEnv } from "@zamolxis/runtime-claude";

type Exec = (file: string, args: readonly string[]) => string;
const exec: Exec = (file, args) =>
  execFileSync(file, [...args], {
    encoding: "utf8",
    timeout: 5000,
    env: claudeEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * The Claude Code executable: `claude` on PATH, else the native installer's location
 * (~/.local/bin/claude), which launchd's PATH may not include. Undefined when neither runs
 * `claude --version`.
 */
export function findClaude(
  run: Exec = exec,
  candidates: readonly string[] = ["claude", join(homedir(), ".local", "bin", "claude")],
): { executable: string; version: string } | undefined {
  for (const executable of candidates) {
    if (executable.includes("/") && !existsSync(executable)) continue;
    try {
      const version = run(executable, ["--version"]).trim().split("\n")[0]?.trim();
      if (version) return { executable, version: version.slice(0, 128) };
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/**
 * True when the CLI is signed in with a Claude subscription (`claude auth status`), the
 * only billing Zamolxis uses: API-key or console logins are not advertised. API key
 * variables are removed from the environment of the check and of every run.
 */
export function claudeSignedIn(executable: string, run: Exec = exec): boolean {
  try {
    const status = JSON.parse(run(executable, ["auth", "status"])) as Record<string, unknown>;
    const method = typeof status.authMethod === "string" ? status.authMethod : "";
    return status.loggedIn === true && (method === "claude.ai" || /oauth/i.test(method));
  } catch {
    return false;
  }
}
