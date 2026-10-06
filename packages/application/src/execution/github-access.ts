/**
 * GitHub access for publishing, per repository on the Mac that publishes. The credential
 * is, in this order: the repository's own token in that Mac's login Keychain, else the
 * GitHub CLI account setup chose for the repository (its token read from `gh` for one
 * publication). Only the Node uses it, only to push a trusted branch and open its pull
 * request. What leaves the Mac is this status, never the credential.
 */
export const GITHUB_ACCESS_STATUSES = [
  "ok",
  // Works, but expires within EXPIRING_WITHIN_MS.
  "expiring",
  "expired",
  // GitHub rejected the token (revoked, mistyped or expired without a known date).
  "invalid",
  // The token works but cannot push to this repository (not selected, or read-only).
  "no_push",
  // Neither a token nor a GitHub CLI account is set up for this repository.
  "missing",
  // The GitHub CLI account chosen for this repository is not signed in on this Mac, or
  // its credential now belongs to another login.
  "account_unavailable",
  // GitHub could not be reached; says nothing about the token.
  "unreachable",
] as const;
export type GitHubAccessStatus = (typeof GITHUB_ACCESS_STATUSES)[number];
export const PUBLISHING_SOURCES = ["token", "gh_account"] as const;
/** Which credential publishes: the repository's own token, or its chosen `gh` account. */
export type PublishingSource = (typeof PUBLISHING_SOURCES)[number];
export interface GitHubAccess {
  readonly status: GitHubAccessStatus;
  readonly source?: PublishingSource;
  readonly login?: string;
  readonly expiresAt?: number;
  readonly checkedAt: number;
}
export const EXPIRING_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;
// GitHub logins: alphanumerics and single hyphens, at most 39 characters.
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GitHubRepository {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}
const PART = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The GitHub repository a remote URL points at (https, ssh or scp-like), or undefined
 * for other hosts and malformed URLs. Credentials in the URL are ignored.
 */
export function githubRepositoryFromRemote(
  remote: string | undefined,
  hosts: readonly string[] = ["github.com"],
): GitHubRepository | undefined {
  if (!remote) return undefined;
  try {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote);
    const url =
      !remote.includes("://") && scp ? new URL(`ssh://${scp[1]}/${scp[2]}`) : new URL(remote);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash)
      return undefined;
    const host = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
    const [owner, repo, ...rest] = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "")
      .split("/");
    if (!owner || !repo || rest.length || !hosts.includes(host)) return undefined;
    if (![owner, repo].every((part) => PART.test(part) && part !== "." && part !== ".."))
      return undefined;
    return { host, owner, repo };
  } catch {
    return undefined;
  }
}

/** `owner/repo`, as GitHub shows it. */
export const githubSlug = (repository: GitHubRepository) =>
  `${repository.owner}/${repository.repo}`;

/**
 * GitHub's "new fine-grained personal access token" page, prefilled with a name, a
 * description, the resource owner, a 90-day expiry and exactly the permissions publishing
 * needs (Contents and Pull requests: read and write; Metadata read is implied). The
 * repository itself cannot be prefilled: the owner picks "Only select repositories" and
 * this repository.
 */
export function githubTokenUrl(repository: GitHubRepository): string {
  const params = new URLSearchParams({
    name: `Zamolxis ${repository.repo}`.slice(0, 40),
    description: `Zamolxis publishing (push a trusted branch and open its pull request) for ${githubSlug(repository)}`,
    target_name: repository.owner,
    expires_in: "90",
    contents: "write",
    pull_requests: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}
