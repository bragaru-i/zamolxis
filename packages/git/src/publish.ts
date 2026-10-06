import { execFileSync } from "node:child_process";

// Same isolation as `git()`, plus no interactive credential prompts: a Node has no terminal.
export interface GitCredentials {
  readonly username: string;
  readonly password: string;
}

function environment(credentials?: GitCredentials): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  if (credentials) {
    env.GIT_USERNAME = credentials.username;
    env.GIT_PASSWORD = credentials.password;
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "credential.helper";
    env.GIT_CONFIG_VALUE_0 = "";
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 =
      '!f() { test "$1" = get && printf "%s\\n" "username=$GIT_USERNAME" "password=$GIT_PASSWORD"; }; f';
  }
  return env;
}

function run(
  path: string,
  args: readonly string[],
  timeout = 30_000,
  credentials?: GitCredentials,
): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: environment(credentials),
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** The configured (not insteadOf-rewritten) URL of a remote, or undefined when absent. */
export function configuredRemoteUrl(path: string, remote = "origin"): string | undefined {
  try {
    return run(path, ["config", "--get", `remote.${remote}.url`]) || undefined;
  } catch {
    return undefined;
  }
}

/** The remote's default branch as last fetched (refs/remotes/<remote>/HEAD), if known. */
export function remoteDefaultBranch(path: string, remote = "origin"): string | undefined {
  try {
    const ref = run(path, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    const prefix = `refs/remotes/${remote}/`;
    return ref.startsWith(prefix) ? ref.slice(prefix.length) || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pushes an exact commit to a new or fast-forwarded branch on the remote. Never forces
 * (no `--force`, no `+` refspec) and runs the repository's own hooks and credentials.
 * Remote output is never surfaced: it can contain URLs or tokens.
 */
export function pushCommit(
  path: string,
  sha: string,
  branch: string,
  remote = "origin",
  credentials?: GitCredentials,
): void {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("INVALID_PUSH_SHA");
  run(path, ["check-ref-format", "--branch", branch]);
  try {
    run(path, ["push", "--porcelain", remote, `${sha}:refs/heads/${branch}`], 300_000, credentials);
  } catch {
    throw new Error("PUSH_FAILED");
  }
}
