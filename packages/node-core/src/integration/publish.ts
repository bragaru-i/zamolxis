import {
  type GitHubAccess,
  githubRepositoryFromRemote,
  PUBLISH_BRANCH,
} from "@zamolxis/application";
import { configuredRemoteUrl, pushCommit, remoteDefaultBranch } from "@zamolxis/git";
import { redactSecrets } from "@zamolxis/runtime-core";
import { type GitHubClient, RestGitHubClient } from "../github/github-api";
import type { RepositoryTokenStore } from "../github/token-store";
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
export interface PublishOptions {
  // This Mac's per-repository GitHub tokens; the global Git/gh identity is never used.
  readonly tokens: RepositoryTokenStore;
  readonly github?: GitHubClient;
  // Hosts treated as GitHub for tokens, pull requests and compare links.
  readonly githubHosts?: readonly string[];
}

// Why a repository's token cannot publish, as failure codes.
const ACCESS_FAILURES: Partial<Record<GitHubAccess["status"], string>> = {
  missing: "PUBLISH_GITHUB_TOKEN_MISSING",
  invalid: "PUBLISH_GITHUB_TOKEN_INVALID",
  expired: "PUBLISH_GITHUB_TOKEN_EXPIRED",
  no_push: "PUBLISH_GITHUB_NO_PUSH",
  unreachable: "PUBLISH_GITHUB_UNREACHABLE",
};

const BASE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Publishes a trusted integration worktree: pushes its exact HEAD to a Zamolxis branch on
 * `origin` and, for GitHub, opens a pull request against the default branch with the
 * repository's own token. Never merges, never forces and never pushes to the default branch.
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
  const github = githubRepositoryFromRemote(url, options.githubHosts ?? ["github.com"]);
  if (!github) {
    // Not a GitHub remote: pushed with the repository's own Git credentials, no links.
    try {
      pushCommit(workspace.path, request.subjectSha, request.branch);
    } catch {
      throw new Error("PUBLISH_PUSH_FAILED");
    }
    return { remoteBranch: request.branch, base };
  }
  // Only this repository's own token publishes; there is no fallback to the Mac's
  // global Git credentials or GitHub CLI account.
  let token: string | undefined;
  try {
    token = options.tokens.read(github);
  } catch {
    throw new Error("PUBLISH_GITHUB_TOKEN_UNREADABLE");
  }
  if (!token) throw new Error("PUBLISH_GITHUB_TOKEN_MISSING");
  const client = options.github ?? new RestGitHubClient();
  const access = await client
    .checkAccess(github, token)
    .catch((): GitHubAccess => ({ status: "unreachable", checkedAt: Date.now() }));
  const refused = ACCESS_FAILURES[access.status];
  if (refused) throw new Error(refused);
  try {
    // Over HTTPS, whatever transport origin uses, so the token is the only credential.
    pushCommit(workspace.path, request.subjectSha, request.branch, {
      target: `https://${github.host}/${github.owner}/${github.repo}.git`,
      token,
    });
  } catch {
    throw new Error("PUBLISH_PUSH_FAILED");
  }
  const compareUrl = `https://${github.host}/${github.owner}/${github.repo}/compare/${base}...${request.branch}`;
  let prUrl: string;
  try {
    prUrl = await client.openPullRequest({
      repository: github,
      token,
      base,
      head: request.branch,
      // Titles and bodies leave the Mac: redact anything that looks like a secret.
      title: redactSecrets(request.title).slice(0, 256),
      body: redactSecrets(request.body).slice(0, 60_000),
    });
  } catch {
    throw new Error("PUBLISH_PR_FAILED");
  }
  if (!prUrl.startsWith(`https://${github.host}/`)) throw new Error("PUBLISH_PR_FAILED");
  return { remoteBranch: request.branch, base, compareUrl, prUrl };
}
