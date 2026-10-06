import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function git(path: string, args: readonly string[]): string {
  const env = { ...process.env };
  // Git environment overrides must not redirect operations away from the verified cwd.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export interface RepositorySnapshot {
  readonly path: string;
  readonly gitCommonDir: string;
  readonly headSha: string;
  readonly branch?: string;
  readonly remoteIdentity?: string;
  readonly dirty: boolean;
  readonly status: string;
}

export function remoteIdentity(remote: string): string {
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
  let url: URL;
  if (!remote.includes("://") && scp) url = new URL(`ssh://${scp[1]}/${scp[2]}`);
  else url = new URL(remote);
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("UNSUPPORTED_REMOTE_IDENTITY");
  }
  // Transport and credentials are not part of repository identity or persisted metadata.
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
}

export function inspectRepository(path: string): RepositorySnapshot {
  const canonicalPath = realpathSync.native(path);
  const topLevel = realpathSync.native(git(canonicalPath, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== canonicalPath) throw new Error("REPOSITORY_ROOT_REQUIRED");
  const gitCommonDir = realpathSync.native(
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const headSha = git(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(path, ["status", "--porcelain=v1", "-z"]);
  const remotes = git(path, ["remote"]).split("\n");
  const remote = remotes.includes("origin")
    ? remoteIdentity(git(path, ["remote", "get-url", "origin"]))
    : undefined;
  return {
    path: topLevel,
    gitCommonDir,
    headSha,
    ...(branch === "HEAD" ? {} : { branch }),
    ...(remote === undefined ? {} : { remoteIdentity: remote }),
    dirty: status.length > 0,
    status,
  };
}

export function repositoryFiles(path: string): string[] {
  return [
    ...new Set(
      git(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}
