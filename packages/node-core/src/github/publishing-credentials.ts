import { execFileSync } from "node:child_process";
import type { GitHubAccess, GitHubRepository, PublishingSource } from "@zamolxis/application";
import { withoutGitHubTokens } from "@zamolxis/runtime-core";
import type { GitHubClient } from "./github-api";
import { isGitHubToken, type RepositoryTokenStore } from "./token-store";

/** One GitHub repository as this Mac publishes it. */
export interface PublishingTarget {
  readonly repositoryId?: string;
  readonly github: GitHubRepository;
}
/** The GitHub CLI login setup chose for a repository (stored in config, never a token). */
export type PublishingAccountLookup = (target: PublishingTarget) => string | undefined;
/** Reads the saved credential of one signed-in GitHub CLI account. */
export interface GhAccountTokens {
  /** The account's token, or undefined when it is not signed in for the host. */
  read(host: string, login: string): string | undefined;
}

export type ResolvedCredential =
  | {
      readonly kind: "ready";
      readonly source: PublishingSource;
      readonly token: string;
      /** The login the credential must belong to (gh accounts only). */
      readonly login?: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "account_unavailable"; readonly login: string };

/**
 * Which credential publishes a repository, in this order: the repository's own token in
 * this Mac's Keychain, else the GitHub CLI account setup chose for it. There is no other
 * fallback: never the Mac's global Git credentials and never the active `gh` account.
 */
export class PublishingCredentials {
  constructor(
    private readonly options: {
      readonly tokens: RepositoryTokenStore;
      readonly account?: PublishingAccountLookup;
      readonly ghTokens?: GhAccountTokens;
    },
  ) {}

  /** Throws only when the Keychain cannot be read (locked or unavailable). */
  resolve(target: PublishingTarget): ResolvedCredential {
    const token = this.options.tokens.read(target.github);
    if (token) return { kind: "ready", source: "token", token };
    const login = this.options.account?.(target);
    if (!login) return { kind: "missing" };
    let account: string | undefined;
    try {
      account = this.options.ghTokens?.read(target.github.host, login);
    } catch {
      account = undefined;
    }
    return account
      ? { kind: "ready", source: "gh_account", token: account, login }
      : { kind: "account_unavailable", login };
  }
}

/**
 * Checks a resolved credential with GitHub: who it is, whether it may push here, when it
 * expires. A gh account whose credential now belongs to another login is unavailable.
 * Never throws; GitHub being unreachable is a status.
 */
export async function assessCredential(
  credential: ResolvedCredential,
  target: PublishingTarget,
  github: Pick<GitHubClient, "checkAccess">,
  now: () => number = Date.now,
): Promise<GitHubAccess> {
  if (credential.kind === "missing") return { status: "missing", checkedAt: now() };
  if (credential.kind === "account_unavailable")
    return {
      status: "account_unavailable",
      source: "gh_account",
      login: credential.login,
      checkedAt: now(),
    };
  const access = await github
    .checkAccess(target.github, credential.token)
    .catch((): GitHubAccess => ({ status: "unreachable", checkedAt: now() }));
  if (
    credential.login &&
    access.login &&
    access.login.toLowerCase() !== credential.login.toLowerCase()
  )
    return {
      status: "account_unavailable",
      source: credential.source,
      login: credential.login,
      checkedAt: access.checkedAt,
    };
  return {
    ...access,
    source: credential.source,
    ...(credential.login && !access.login ? { login: credential.login } : {}),
  };
}

/** The publishing access of one repository, without changing anything. */
export async function checkPublishing(
  credentials: PublishingCredentials,
  target: PublishingTarget,
  github: Pick<GitHubClient, "checkAccess">,
  now: () => number = Date.now,
): Promise<GitHubAccess> {
  return assessCredential(credentials.resolve(target), target, github, now);
}

/**
 * The GitHub CLI's saved credential for one account (`gh auth token --user`), read for a
 * single publication or check. The global active account is never switched, and any
 * GH_TOKEN/GITHUB_TOKEN in the Node's environment is removed so `gh` reads its own store.
 */
export const ghCliAccountTokens: GhAccountTokens = {
  read(host, login) {
    if (!/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host)) return undefined;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return undefined;
    try {
      const token = execFileSync("gh", ["auth", "token", "--hostname", host, "--user", login], {
        encoding: "utf8",
        env: { ...withoutGitHubTokens(process.env), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return isGitHubToken(token) ? token : undefined;
    } catch {
      return undefined;
    }
  },
};
