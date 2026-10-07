import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutGitHubTokens } from "@zamolxis/runtime-core";

/**
 * Builders and Repairs run offline, so a new dependency in a `package.json` comes without
 * its lockfile entry, and the Verifier's lockfile-exact install then fails. Before the
 * candidate commit the Node (which has the network) updates the lockfile only: no
 * packages are installed and no lifecycle scripts run. The Verifier still checks the
 * exact commit, lockfile included.
 */
const LOCKFILE_ONLY: Record<string, { readonly lockfile: string; readonly args: string[] }> = {
  pnpm: { lockfile: "pnpm-lock.yaml", args: ["install", "--lockfile-only", "--ignore-scripts"] },
  npm: {
    lockfile: "package-lock.json",
    args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
  },
};
const TIMEOUT = 300_000;
const OUTPUT = 4000;

export interface LockfileUpdate {
  readonly command: string;
  readonly result: "passed" | "failed";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly output: string;
}

function run(cwd: string, executable: string, args: string[]) {
  return new Promise<{ ok: boolean; output: string }>((resolve) =>
    execFile(
      executable,
      args,
      { cwd, env: withoutGitHubTokens(), timeout: TIMEOUT, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, output: [stdout, stderr].filter(Boolean).join("\n") }),
    ),
  );
}

/** Changed `package.json` files in the worktree (uncommitted), relative to its root. */
export function changedManifests(porcelain: string): string[] {
  return porcelain
    .split("\0")
    .map((entry) => entry.slice(3))
    .filter((path) => path === "package.json" || path.endsWith("/package.json"));
}

/**
 * Updates the lockfile when the worktree changed a `package.json`, uncommitted or since
 * `base` (where the task started: a Repair after a Builder may change nothing itself);
 * absent when nothing needed it (no manifest change, no supported lockfile).
 */
export async function updateLockfile(
  cwd: string,
  base?: string,
): Promise<LockfileUpdate | undefined> {
  const status = await run(cwd, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const committed =
    base && /^[a-f0-9]{40,64}$/.test(base)
      ? await run(cwd, "git", ["diff", "--name-only", "-z", base, "HEAD"])
      : undefined;
  const changed =
    (status.ok && changedManifests(status.output).length > 0) ||
    (committed?.ok === true &&
      committed.output
        .split("\0")
        .some((path) => path === "package.json" || path.endsWith("/package.json")));
  if (!changed) return undefined;
  let manager = "npm";
  try {
    const path = join(cwd, "package.json");
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("pnpm@"))
      manager = "pnpm";
  } catch {
    return undefined;
  }
  const plan = LOCKFILE_ONLY[manager];
  if (!plan || !existsSync(join(cwd, plan.lockfile))) return undefined;
  const startedAt = Date.now();
  const result = await run(cwd, manager, plan.args);
  return {
    command: [manager, ...plan.args].join(" "),
    result: result.ok ? "passed" : "failed",
    startedAt,
    finishedAt: Date.now(),
    output: result.output.slice(-OUTPUT),
  };
}
