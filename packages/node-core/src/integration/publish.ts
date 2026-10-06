import { execFileSync } from "node:child_process";
import { PUBLISH_BRANCH } from "@zamolxis/application";
import {
  configuredRemoteUrl,
  pushCommit,
  remoteDefaultBranch,
  remoteIdentity,
} from "@zamolxis/git";
import { redactSecrets } from "@zamolxis/runtime-core";
import type { ManagedWorkspace } from "../persistence/local-state";

/** What the backend authorized: the exact trusted commit and where it may go. */
export interface PublishRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly branch: string;
  // The repository's default branch as the backend knows it; detected locally when absent.
  readonly base?: string;
  readonly subjectSha: string;
  readonly title: string;
  readonly body: string;
}
export interface PublishResult {
  readonly remoteBranch: string;
  readonly base: string;
  readonly prUrl?: string;
  readonly compareUrl?: string;
}
export interface PullRequestInput {
  readonly cwd: string;
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly authentication?: GithubCredential;
}
export interface GithubCredential {
  readonly login: string;
  readonly token: string;
}
export interface GithubCredentialProvider {
  get(input: {
    repositoryId: string;
    host: string;
    owner: string;
    repo: string;
  }): Promise<GithubCredential | undefined>;
}
/**
 * Opens (or finds) a pull request with the repository's own credentials. Resolves to the
 * pull request URL, or undefined when no authenticated client is available for the host.
 */
export interface PullRequestOpener {
  open(input: PullRequestInput): Promise<string | undefined>;
}
export interface PublishOptions {
  readonly pullRequests: PullRequestOpener;
  readonly githubCredentials?: GithubCredentialProvider;
  // Hosts treated as GitHub for pull requests and compare links.
  readonly githubHosts?: readonly string[];
}

const BASE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

function githubRepository(
  url: string | undefined,
  hosts: readonly string[],
): { host: string; owner: string; repo: string } | undefined {
  if (!url) return undefined;
  let identity: string;
  try {
    identity = remoteIdentity(url);
  } catch {
    return undefined;
  }
  const [host, owner, repo, ...rest] = identity.split("/");
  if (!host || !owner || !repo || rest.length || !hosts.includes(host)) return undefined;
  if (![owner, repo].every((part) => /^[A-Za-z0-9._-]{1,100}$/.test(part))) return undefined;
  return { host, owner, repo };
}

/**
 * Publishes a trusted integration worktree: pushes its exact HEAD to a Zamolxis branch on
 * `origin` and opens a pull request against the default branch, or returns a compare link.
 * Never merges, never forces and never pushes to the default branch.
 */
export async function publishIntegration(
  workspace: ManagedWorkspace,
  request: PublishRequest,
  options: PublishOptions,
): Promise<PublishResult> {
  if (workspace.kind !== "integration") throw new Error("PUBLISH_NOT_INTEGRATION");
  if (workspace.dirty) throw new Error("PUBLISH_DIRTY");
  if (workspace.headSha !== request.subjectSha) throw new Error("PUBLISH_SHA_MISMATCH");
  const url = configuredRemoteUrl(workspace.path);
  if (!url) throw new Error("PUBLISH_NO_REMOTE");
  const detected = remoteDefaultBranch(workspace.path);
  const base = request.base ?? detected;
  if (!base || !BASE.test(base)) throw new Error("PUBLISH_BASE_UNKNOWN");
  if (request.branch === base || request.branch === detected)
    throw new Error("PUBLISH_DEFAULT_BRANCH");
  if (
    !PUBLISH_BRANCH.test(request.branch) ||
    !request.branch.endsWith(request.subjectSha.slice(0, 7))
  )
    throw new Error("PUBLISH_INVALID_BRANCH");
  const github = githubRepository(url, options.githubHosts ?? ["github.com"]);
  const authentication = github
    ? await options.githubCredentials?.get({ repositoryId: workspace.repositoryId, ...github })
    : undefined;
  if (github && options.githubCredentials && !authentication)
    throw new Error("PUBLISH_GITHUB_AUTH_REQUIRED");
  try {
    pushCommit(
      workspace.path,
      request.subjectSha,
      request.branch,
      "origin",
      authentication
        ? { username: authentication.login, password: authentication.token }
        : undefined,
    );
  } catch {
    throw new Error("PUBLISH_PUSH_FAILED");
  }
  if (!github) return { remoteBranch: request.branch, base };
  const compareUrl = `https://${github.host}/${github.owner}/${github.repo}/compare/${base}...${request.branch}`;
  let prUrl: string | undefined;
  try {
    prUrl = await options.pullRequests.open({
      cwd: workspace.path,
      ...github,
      base,
      head: request.branch,
      // Titles and bodies leave the Mac: redact anything that looks like a secret.
      title: redactSecrets(request.title).slice(0, 256),
      body: redactSecrets(request.body).slice(0, 60_000),
      ...(authentication ? { authentication } : {}),
    });
  } catch {
    throw new Error("PUBLISH_PR_FAILED");
  }
  if (prUrl !== undefined && !prUrl.startsWith(`https://${github.host}/`))
    throw new Error("PUBLISH_PR_FAILED");
  return { remoteBranch: request.branch, base, compareUrl, ...(prUrl ? { prUrl } : {}) };
}

function gh(args: readonly string[], input?: string, authentication?: GithubCredential): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      ...(authentication ? { GH_TOKEN: authentication.token } : {}),
    },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Uses the GitHub CLI already installed and signed in on this Mac. Resolves undefined when
 * gh is missing or not authenticated for the host, so the caller falls back to a link.
 */
export const ghPullRequestOpener: PullRequestOpener = {
  async open(input) {
    if (!input.authentication) {
      try {
        gh(["auth", "status", "--hostname", input.host]);
      } catch {
        return undefined;
      }
    }
    const repository = `${input.host}/${input.owner}/${input.repo}`;
    // A retry after a lost result finds the pull request opened the first time.
    const existing = gh(
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        input.head,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        '.[0].url // ""',
      ],
      undefined,
      input.authentication,
    );
    if (existing) return existing;
    const output = gh(
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--base",
        input.base,
        "--head",
        input.head,
        "--title",
        input.title,
        "--body-file",
        "-",
      ],
      input.body,
      input.authentication,
    );
    return output.split("\n").filter(Boolean).at(-1);
  },
};
