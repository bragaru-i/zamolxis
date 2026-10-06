import { execFileSync } from "node:child_process";

const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * For RedactOptions.keep: true only for a full commit SHA that exists in the repository at
 * `cwd` (`git cat-file -t` says "commit"). A 40-hex credential is not a commit there, so it
 * stays hidden. Answers are cached per value; a failing Git answers false.
 */
export function knownCommit(cwd: string): (run: string) => boolean {
  const cache = new Map<string, boolean>();
  return (run) => {
    if (!HEX_SHA.test(run)) return false;
    const cached = cache.get(run);
    if (cached !== undefined) return cached;
    let commit = false;
    try {
      commit =
        execFileSync("git", ["-C", cwd, "cat-file", "-t", run], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        }).trim() === "commit";
    } catch {
      commit = false;
    }
    cache.set(run, commit);
    return commit;
  };
}
