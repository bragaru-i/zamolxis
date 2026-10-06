import {
  type GitHubAccess,
  githubRepositoryFromRemote,
  PUBLISH_BRANCH,
} from "@zamolxis/application";
import { configuredRemoteUrl, pushCommit, remoteDefaultBranch } from "@zamolxis/git";
import { redactSecrets } from "@zamolxis/runtime-core";
import { type GitHubClient, RestGitHubClient } from "../github/github-api";
import { assessCredential, type PublishingCredentials } from "../github/publishing-credentials";
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
  // Each repository's own token, else its chosen gh account; the computer's global Git
  // credentials and active gh account are never used.
  readonly credentials: PublishingCredentials;
  readonly github?: GitHubClient;
  // Hosts treated as GitHub for tokens, pull requests and compare links.
  readonly githubHosts?: readonly string[];
}

// Why a repository cannot publish, as failure codes.
const ACCESS_FAILURES: Partial<Record<GitHubAccess["status"], string>> = {
  missing: "PUBLISH_GITHUB_NOT_CONNECTED",
  account_unavailable: "PUBLISH_GITHUB_AUTH_REQUIRED",
  invalid: "PUBLISH_GITHUB_TOKEN_INVALID",
  expired: "PUBLISH_GITHUB_TOKEN_EXPIRED",
  no_push: "PUBLISH_GITHUB_NO_PUSH",
  unreachable: "PUBLISH_GITHUB_UNREACHABLE",
};
function refusal(access: GitHubAccess): string | undefined {
  // A gh account's credential that GitHub rejects needs the account signed in again.
  if (
    access.source === "gh_account" &&
    (access.status === "invalid" || access.status === "expired")
  )
    return "PUBLISH_GITHUB_AUTH_REQUIRED";
  return ACCESS_FAILURES[access.status];
}

const BASE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Publishes a trusted integration worktree: pushes its exact HEAD to a Zamolxis branch on
 * `origin` and, for GitHub, opens a pull request against the default branch with the
 * repository's own token or, without one, its chosen gh account. Never merges, never forces and never pushes to the default branch.
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
  // The repository's own token, else its chosen gh account; nothing else ever publishes.
  const target = { repositoryId: workspace.repositoryId, github };
  let credential: ReturnType<PublishingCredentials["resolve"]>;
  try {
    credential = options.credentials.resolve(target);
  } catch {
    throw new Error("PUBLISH_GITHUB_TOKEN_UNREADABLE");
  }
  const client = options.github ?? new RestGitHubClient();
  const access = await assessCredential(credential, target, client);
  const refused = refusal(access);
  if (refused || credential.kind !== "ready")
    throw new Error(refused ?? "PUBLISH_GITHUB_NOT_CONNECTED");
  const { token } = credential;
  try {
    // Over HTTPS, whatever transport origin uses, so the token is the only credential.
    pushCommit(workspace.path, request.subjectSha, request.branch, {
      target: `https://${github.host}/${github.owner}/${github.repo}.git`,
      token,
      ...(access.login ? { username: access.login } : {}),
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
      // Titles and bodies leave the computer: redact anything that looks like a secret.
      title: redactSecrets(request.title).slice(0, 256),
      body: redactSecrets(request.body).slice(0, 60_000),
    });
  } catch {
    throw new Error("PUBLISH_PR_FAILED");
  }
  if (!prUrl.startsWith(`https://${github.host}/`)) throw new Error("PUBLISH_PR_FAILED");
  return { remoteBranch: request.branch, base, compareUrl, prUrl };
}
