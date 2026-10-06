import { createHash } from "node:crypto";
import type { GitHubAccess, GitHubRepository } from "@zamolxis/application";
import type { GitHubClient } from "./github-api";
import {
  assessCredential,
  type PublishingCredentials,
  type ResolvedCredential,
} from "./publishing-credentials";

export interface MonitoredRepository {
  readonly repositoryId: string;
  readonly github: GitHubRepository;
}
export interface GitHubAccessMonitorOptions {
  readonly now?: () => number;
  /** A token that did not change is checked with GitHub at most this often. */
  readonly recheckMs?: number;
  /** How often the credential is re-read to notice a new, replaced or removed one. */
  readonly readEveryMs?: number;
  /** After GitHub could not be reached, the next attempt waits this long. */
  readonly retryMs?: number;
}
interface State {
  fingerprint?: string;
  readAt: number;
  checkedAt: number;
  reported?: GitHubAccess["status"];
}

/** A digest of which credential publishes, to notice a change without keeping it. */
function fingerprint(credential: ResolvedCredential): string {
  if (credential.kind === "missing") return "missing";
  if (credential.kind === "account_unavailable") return `unavailable:${credential.login}`;
  return createHash("sha256")
    .update(`${credential.source}\0${credential.login ?? ""}\0${credential.token}`)
    .digest("hex");
}

/**
 * Keeps the control plane informed of each repository's GitHub publishing access on this
 * computer (status, source, login, expiry; never a credential). GitHub is asked at most every
 * 30 minutes per repository, and right after the credential changes (a token added,
 * replaced or removed, or the chosen gh account signed in or out). Never throws.
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
    private readonly credentials: PublishingCredentials,
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
    let credential: ResolvedCredential;
    try {
      credential = this.credentials.resolve({ repositoryId, github });
    } catch {
      // A locked Keychain says nothing about the token; try again later.
      return;
    }
    state.readAt = now;
    // Only a digest is kept, to notice that the credential changed.
    const digest = fingerprint(credential);
    if (!due && digest === state.fingerprint) return;
    state.fingerprint = digest;
    let access: GitHubAccess;
    try {
      access = await assessCredential(credential, { repositoryId, github }, this.github, this.#now);
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
