import { execFileSync } from "node:child_process";
import type { GitHubRepository } from "@zamolxis/application";

/**
 * Per-repository GitHub tokens for publishing, kept only on this Mac. Keyed by the
 * repository's GitHub identity `<host>/<owner>/<repo>` (lowercase, from its origin
 * remote), so every checkout of the same repository on this Mac shares one token and a
 * renamed local folder keeps it. The real store is the login Keychain; tests inject the
 * in-memory store and never touch a Keychain.
 */
export interface RepositoryTokenStore {
  read(repository: GitHubRepository): string | undefined;
  write(repository: GitHubRepository, token: string): void;
  remove(repository: GitHubRepository): void;
}

export const GITHUB_TOKEN_SERVICE = "app.zamolxis.github-token";
// Fine-grained (github_pat_…) and classic/app (ghp_, gho_, ghu_, ghs_, ghr_) tokens.
const TOKEN = /^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,250}$/;
const ACCOUNT = /^[a-z0-9.-]{1,253}(?::\d{1,5})?\/[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/;

export const isGitHubToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN.test(value);

/** The Keychain account for a repository: `<host>/<owner>/<repo>`, lowercase. */
export function tokenAccount(repository: GitHubRepository): string {
  const account = `${repository.host}/${repository.owner}/${repository.repo}`.toLowerCase();
  if (!ACCOUNT.test(account)) throw new Error("INVALID_TOKEN_ACCOUNT");
  return account;
}

export interface SecurityResult {
  status: number;
  stdout: string;
}
/** Runs /usr/bin/security; `input` is written to its stdin. */
export type SecurityRunner = (args: string[], input?: string) => SecurityResult;
const ITEM_NOT_FOUND = 44;

export const runSecurity: SecurityRunner = (args, input) => {
  try {
    const stdout = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { status: 0, stdout };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    // Never forward stdout/stderr: they could contain the token.
    return { status: typeof status === "number" ? status : -1, stdout: "" };
  }
};

/**
 * Generic password items in the login Keychain: service `app.zamolxis.github-token`,
 * account `<host>/<owner>/<repo>`.
 *
 * Writing sends the command to `security -i` (interactive mode reading commands from
 * stdin), so the token never appears on a command line or in process listings. Reading
 * uses `find-generic-password -w`, which prints it on stdout to this process only. As
 * with the device credential, the item trusts /usr/bin/security, so the launchd Node
 * reads it without a dialog while the login Keychain is unlocked; any process running as
 * this user could do the same.
 */
export class KeychainRepositoryTokenStore implements RepositoryTokenStore {
  constructor(
    private readonly run: SecurityRunner = runSecurity,
    private readonly platform: string = process.platform,
  ) {}
  private requireMac() {
    if (this.platform !== "darwin") throw new Error("KEYCHAIN_REQUIRES_MACOS");
  }
  read(repository: GitHubRepository) {
    this.requireMac();
    const result = this.run([
      "find-generic-password",
      "-s",
      GITHUB_TOKEN_SERVICE,
      "-a",
      tokenAccount(repository),
      "-w",
    ]);
    if (result.status === ITEM_NOT_FOUND) return undefined;
    if (result.status !== 0) throw new Error("KEYCHAIN_UNAVAILABLE");
    const token = result.stdout.trim();
    // An unusable value is treated as missing; it is never echoed.
    return isGitHubToken(token) ? token : undefined;
  }
  write(repository: GitHubRepository, token: string) {
    this.requireMac();
    if (!isGitHubToken(token)) throw new Error("INVALID_GITHUB_TOKEN");
    // Account and token are validated to [a-z0-9._:/-] and [A-Za-z0-9_]: no quoting needed.
    const result = this.run(
      ["-i"],
      `add-generic-password -U -s ${GITHUB_TOKEN_SERVICE} -a ${tokenAccount(repository)} -l Zamolxis -w ${token}\n`,
    );
    if (result.status !== 0) throw new Error("KEYCHAIN_UNAVAILABLE");
  }
  remove(repository: GitHubRepository) {
    this.requireMac();
    const result = this.run([
      "delete-generic-password",
      "-s",
      GITHUB_TOKEN_SERVICE,
      "-a",
      tokenAccount(repository),
    ]);
    if (result.status !== 0 && result.status !== ITEM_NOT_FOUND)
      throw new Error("KEYCHAIN_UNAVAILABLE");
  }
}

export class MemoryRepositoryTokenStore implements RepositoryTokenStore {
  readonly items = new Map<string, string>();
  read(repository: GitHubRepository) {
    return this.items.get(tokenAccount(repository));
  }
  write(repository: GitHubRepository, token: string) {
    if (!isGitHubToken(token)) throw new Error("INVALID_GITHUB_TOKEN");
    this.items.set(tokenAccount(repository), token);
  }
  remove(repository: GitHubRepository) {
    this.items.delete(tokenAccount(repository));
  }
}

/** No tokens at all: publishing to GitHub fails with PUBLISH_GITHUB_TOKEN_MISSING. */
export const NO_REPOSITORY_TOKENS: RepositoryTokenStore = {
  read: () => undefined,
  write: () => {
    throw new Error("TOKEN_STORE_READ_ONLY");
  },
  remove: () => undefined,
};
