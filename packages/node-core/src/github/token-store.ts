import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GitHubRepository } from "@zamolxis/application";

/**
 * Per-repository GitHub tokens for publishing, kept only on this workstation. Keyed by the
 * repository's GitHub identity `<host>/<owner>/<repo>` (lowercase, from its origin
 * remote), so every checkout of the same repository shares one token and a renamed
 * local folder keeps it. Production uses the login Keychain on macOS or a private file
 * on Linux; tests inject the in-memory store.
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

/** Private per-user file store used on Linux, where the macOS Keychain is unavailable. */
export class FileRepositoryTokenStore implements RepositoryTokenStore {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, string> {
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (!stat) return {};
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("LOCAL_TOKEN_STORE_MUST_BE_PRIVATE");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("LOCAL_TOKEN_STORE_MALFORMED");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("LOCAL_TOKEN_STORE_MALFORMED");
    const items = parsed as Record<string, unknown>;
    for (const [name, token] of Object.entries(items)) {
      if (!ACCOUNT.test(name) || !isGitHubToken(token))
        throw new Error("LOCAL_TOKEN_STORE_MALFORMED");
    }
    return items as Record<string, string>;
  }

  private save(items: Record<string, string>) {
    const directory = dirname(this.path);
    const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
    if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory()))
      throw new Error("UNSAFE_TOKEN_DIRECTORY");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  read(repository: GitHubRepository) {
    return this.readAll()[tokenAccount(repository)];
  }
  write(repository: GitHubRepository, token: string) {
    if (!isGitHubToken(token)) throw new Error("INVALID_GITHUB_TOKEN");
    this.save({ ...this.readAll(), [tokenAccount(repository)]: token });
  }
  remove(repository: GitHubRepository) {
    const items = this.readAll();
    const key = tokenAccount(repository);
    if (!(key in items)) return;
    delete items[key];
    this.save(items);
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

/** No tokens at all (a repository can still publish with its chosen gh account). */
export const NO_REPOSITORY_TOKENS: RepositoryTokenStore = {
  read: () => undefined,
  write: () => {
    throw new Error("TOKEN_STORE_READ_ONLY");
  },
  remove: () => undefined,
};

// The GitHub vocabulary the Node's setup needs, so apps depend on node-core alone.
export {
  type GitHubAccess,
  type GitHubAccessStatus,
  type GitHubRepository,
  githubRepositoryFromRemote,
  githubSlug,
  githubTokenUrl,
  type PublishingSource,
} from "@zamolxis/application";
