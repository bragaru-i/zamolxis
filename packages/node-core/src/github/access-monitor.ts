import { createHash } from "node:crypto";
import type { GitHubAccess, GitHubRepository } from "@zamolxis/application";
import type { GitHubClient } from "./github-api";
import type { RepositoryTokenStore } from "./token-store";

export interface MonitoredRepository {
  readonly repositoryId: string;
  readonly github: GitHubRepository;
}
export interface GitHubAccessMonitorOptions {
  readonly now?: () => number;
  /** A token that did not change is checked with GitHub at most this often. */
  readonly recheckMs?: number;
  /** How often the Keychain is read to notice a new, replaced or removed token. */
  readonly readEveryMs?: number;
  /** After GitHub could not be reached, the next attempt waits this long. */
  readonly retryMs?: number;
}
interface State {
  fingerprint?: string | null;
  readAt: number;
  checkedAt: number;
  reported?: GitHubAccess["status"];
}

/**
 * Keeps the control plane informed of each repository's GitHub publishing access on this
 * Mac (status, login, expiry; never the token). GitHub is asked at most every 30 minutes
 * per repository, and right after the token in the Keychain changes. Never throws.
 */
export class GitHubAccessMonitor {
  readonly #state = new Map<string, State>();
  readonly #now: () => number;
  readonly #recheckMs: number;
  readonly #readEveryMs: number;
  readonly #retryMs: number;
  #busy = false;
  constructor(
    private readonly repositories: readonly MonitoredRepository[],
    private readonly tokens: RepositoryTokenStore,
    private readonly github: Pick<GitHubClient, "checkAccess">,
    private readonly report: (repositoryId: string, access: GitHubAccess) => Promise<void>,
    options: GitHubAccessMonitorOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#recheckMs = options.recheckMs ?? 30 * 60_000;
    this.#readEveryMs = options.readEveryMs ?? 60_000;
    this.#retryMs = options.retryMs ?? 5 * 60_000;
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const repository of this.repositories) await this.#check(repository);
    } finally {
      this.#busy = false;
    }
  }

  async #check({ repositoryId, github }: MonitoredRepository) {
    const now = this.#now();
    const state = this.#state.get(repositoryId) ?? { readAt: -Infinity, checkedAt: -Infinity };
    this.#state.set(repositoryId, state);
    const due = now - state.checkedAt >= this.#recheckMs;
    if (!due && now - state.readAt < this.#readEveryMs) return;
    let token: string | undefined;
    try {
      token = this.tokens.read(github);
    } catch {
      // A locked Keychain says nothing about the token; try again later.
      return;
    }
    state.readAt = now;
    // Only a digest is kept, to notice that the token changed.
    const fingerprint = token ? createHash("sha256").update(token).digest("hex") : null;
    if (!due && fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;
    let access: GitHubAccess;
    try {
      access = token
        ? await this.github.checkAccess(github, token)
        : { status: "missing", checkedAt: now };
    } catch {
      access = { status: "unreachable", checkedAt: now };
    }
    if (access.status === "unreachable") {
      // Retry sooner; a known status stays shown rather than flipping on a network blip.
      state.checkedAt = now - this.#recheckMs + this.#retryMs;
      if (state.reported && state.reported !== "unreachable") return;
    } else state.checkedAt = now;
    try {
      await this.report(repositoryId, access);
      state.reported = access.status;
    } catch {
      // Report again on the next tick.
      state.checkedAt = -Infinity;
    }
  }
}
