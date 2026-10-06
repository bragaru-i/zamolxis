import { execFileSync } from "node:child_process";

// Same isolation as `git()`, plus no interactive credential prompts: a Node has no terminal.
function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function run(path: string, args: readonly string[], timeout = 30_000): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: environment(),
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

/** Child environment variable carrying a publishing token; never a command-line value. */
export const PUBLISH_TOKEN_ENV = "ZAMOLXIS_PUBLISH_TOKEN";
/** Child environment variable carrying the GitHub login the token belongs to, if known. */
export const PUBLISH_USERNAME_ENV = "ZAMOLXIS_PUBLISH_USERNAME";
// The inline credential helper prints the token from the child's environment, so neither
// argv nor the repository's config ever holds it.
const TOKEN_HELPER = `!f() { test "$1" = get || exit 0; echo "username=\${${PUBLISH_USERNAME_ENV}:-x-access-token}"; echo "password=$${PUBLISH_TOKEN_ENV}"; }; f`;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Git options and environment for a push that uses exactly one token: every other
 * credential helper (system osxkeychain, global, repository) is reset, the system and
 * global configuration are not read (no global `insteadOf` rewriting to SSH, no other
 * account), and Git never prompts. Repository configuration and hooks still apply.
 */
export function tokenPushOptions(
  token: string,
  username?: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (/[\r\n\0]/.test(token)) throw new Error("INVALID_PUSH_TOKEN");
  if (username !== undefined && !LOGIN.test(username)) throw new Error("INVALID_PUSH_USERNAME");
  const env = environment();
  for (const key of ["SSH_ASKPASS", "GCM_INTERACTIVE", PUBLISH_USERNAME_ENV]) delete env[key];
  return {
    args: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${TOKEN_HELPER}`,
      "-c",
      "core.askPass=",
    ],
    env: {
      ...env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ASKPASS: "",
      [PUBLISH_TOKEN_ENV]: token,
      ...(username ? { [PUBLISH_USERNAME_ENV]: username } : {}),
    },
  };
}

export interface PushOptions {
  /** Where to push; defaults to `origin`. */
  readonly target?: string;
  /** A GitHub token: only this credential is used (see tokenPushOptions). */
  readonly token?: string;
  /** The GitHub login the token belongs to (sent as the HTTPS username). */
  readonly username?: string;
}

/**
 * Pushes an exact commit to a new or fast-forwarded branch on the remote. Never forces
 * (no `--force`, no `+` refspec) and runs the repository's own hooks. Without a token it
 * uses the repository's own credentials. Remote output is never surfaced: it can contain
 * URLs or tokens.
 */
export function pushCommit(
  path: string,
  sha: string,
  branch: string,
  options: PushOptions = {},
): void {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("INVALID_PUSH_SHA");
  run(path, ["check-ref-format", "--branch", branch]);
  const target = options.target ?? "origin";
  if (target.startsWith("-")) throw new Error("INVALID_PUSH_TARGET");
  const args = ["push", "--porcelain", target, `${sha}:refs/heads/${branch}`];
  let auth: ReturnType<typeof tokenPushOptions> | undefined;
  try {
    auth =
      options.token === undefined ? undefined : tokenPushOptions(options.token, options.username);
  } catch {
    throw new Error("PUSH_FAILED");
  }
  try {
    // A lost result may leave the exact SHA on the remote while the control plane still
    // considers publication failed. Recognize that state before asking for write access:
    // it is already the requested, SHA-bound publication and must never be force-pushed.
    const remote = auth
      ? execFileSync(
          "git",
          [...auth.args, "-C", path, "ls-remote", target, `refs/heads/${branch}`],
          {
            encoding: "utf8",
            env: auth.env,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
      : run(path, ["ls-remote", target, `refs/heads/${branch}`]);
    if (remote.split(/\s+/)[0] === sha) return;
  } catch {
    // Some repository-local push rewrites apply only to `git push`, not `ls-remote`.
    // Fall through to the authoritative push in that case.
  }
  try {
    if (!auth) run(path, args, 300_000);
    else {
      execFileSync("git", [...auth.args, "-C", path, ...args], {
        encoding: "utf8",
        env: auth.env,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch {
    throw new Error("PUSH_FAILED");
  }
}
