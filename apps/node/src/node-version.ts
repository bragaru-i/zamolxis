import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Characters the backend accepts for a reported Node version. */
export const NODE_VERSION_LIMIT = 64;

/**
 * The code this Node runs: the short commit of the checkout its module lives in, with
 * "+dirty" when that checkout has uncommitted changes to tracked files, or "unknown"
 * outside a Git checkout. Reported with every heartbeat so Settings → Computers can show
 * whether a computer was restarted on the current main (runbook, "Updating the Node").
 */
export function nodeVersion(from = dirname(fileURLToPath(import.meta.url))): string {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", from, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  try {
    const sha = git(["rev-parse", "--short=12", "HEAD"]);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return "unknown";
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
    return (dirty ? `${sha}+dirty` : sha).slice(0, NODE_VERSION_LIMIT);
  } catch {
    return "unknown";
  }
}
