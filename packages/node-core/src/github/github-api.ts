import {
  EXPIRING_WITHIN_MS,
  GITHUB_LOGIN,
  type GitHubAccess,
  type GitHubRepository,
} from "@zamolxis/application";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface PullRequestRequest {
  readonly repository: GitHubRepository;
  readonly token: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}
/** GitHub as publishing needs it, always with one repository's own token. */
export interface GitHubClient {
  /** Who the token is and whether it may push here. Never throws for a bad token. */
  checkAccess(repository: GitHubRepository, token: string): Promise<GitHubAccess>;
  /** Finds the open pull request for `head`, or opens one. Resolves to its URL. */
  openPullRequest(request: PullRequestRequest): Promise<string>;
}

export interface RestGitHubClientOptions {
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** REST API root for a host: api.github.com, or GitHub Enterprise Server's /api/v3. */
export const githubApiBase = (host: string) =>
  host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;

/**
 * Parses `github-authentication-token-expiration` ("2026-12-31 10:00:00 UTC", also seen
 * with a numeric offset). Undefined when absent or unreadable.
 */
export function parseTokenExpiration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const zone = match[3];
  const offset =
    !zone || ["UTC", "GMT", "Z"].includes(zone) ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${offset}`);
  return Number.isFinite(time) ? time : undefined;
}

class Unreachable extends Error {}

/**
 * GitHub's REST API over fetch. The token goes only into the Authorization header of
 * requests to the repository's own API host; redirects are refused so it is never
 * forwarded. Response bodies and errors are never surfaced (they can echo input).
 */
export class RestGitHubClient implements GitHubClient {
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  constructor(options: RestGitHubClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }
  async #request(
    repository: GitHubRepository,
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }> {
    let response: Response;
    try {
      response = await this.#fetch(`${githubApiBase(repository.host)}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "zamolxis-node",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Unreachable();
    }
    return {
      status: response.status,
      headers: response.headers,
      json: async () => {
        try {
          return (await response.json()) as unknown;
        } catch {
          return undefined;
        }
      },
    };
  }

  async checkAccess(repository: GitHubRepository, token: string): Promise<GitHubAccess> {
    const checkedAt = this.#now();
    try {
      const user = await this.#request(repository, token, "/user");
      if (user.status === 401) return { status: "invalid", checkedAt };
      if (user.status < 200 || user.status >= 300) return { status: "unreachable", checkedAt };
      const body = (await user.json()) as { login?: unknown } | undefined;
      const login =
        typeof body?.login === "string" && GITHUB_LOGIN.test(body.login) ? body.login : undefined;
      const expiresAt = parseTokenExpiration(
        user.headers.get("github-authentication-token-expiration"),
      );
      const who = { ...(login ? { login } : {}), ...(expiresAt ? { expiresAt } : {}), checkedAt };
      if (expiresAt !== undefined && expiresAt <= checkedAt) return { status: "expired", ...who };
      const repo = await this.#request(
        repository,
        token,
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
      );
      if (repo.status === 401) return { status: "invalid", ...who };
      // A fine-grained token that was not given this repository cannot see it.
      if (repo.status === 403 || repo.status === 404) return { status: "no_push", ...who };
      if (repo.status < 200 || repo.status >= 300) return { status: "unreachable", ...who };
      const details = (await repo.json()) as { permissions?: { push?: unknown } } | undefined;
      if (details?.permissions?.push !== true) return { status: "no_push", ...who };
      return {
        status:
          expiresAt !== undefined && expiresAt - checkedAt < EXPIRING_WITHIN_MS ? "expiring" : "ok",
        ...who,
      };
    } catch (error) {
      if (error instanceof Unreachable) return { status: "unreachable", checkedAt };
      throw error;
    }
  }

  async #findOpen(request: PullRequestRequest): Promise<string | undefined> {
    const { owner, repo } = request.repository;
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${request.head}`,
      base: request.base,
      per_page: "1",
    });
    const list = await this.#request(
      request.repository,
      request.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`,
    );
    if (list.status !== 200) throw new Error("GITHUB_PR_LIST_FAILED");
    const items = await list.json();
    const first = Array.isArray(items)
      ? (items[0] as { html_url?: unknown } | undefined)
      : undefined;
    return typeof first?.html_url === "string" ? first.html_url : undefined;
  }

  async openPullRequest(request: PullRequestRequest): Promise<string> {
    // A retry after a lost result finds the pull request opened the first time.
    const existing = await this.#findOpen(request);
    if (existing) return existing;
    const { owner, repo } = request.repository;
    const created = await this.#request(
      request.repository,
      request.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: "POST",
        body: {
          title: request.title,
          head: request.head,
          base: request.base,
          body: request.body,
          maintainer_can_modify: false,
        },
      },
    );
    if (created.status === 201) {
      const body = (await created.json()) as { html_url?: unknown } | undefined;
      if (typeof body?.html_url === "string") return body.html_url;
    }
    // 422 when it already exists (for example opened concurrently): look once more.
    if (created.status === 422) {
      const raced = await this.#findOpen(request);
      if (raced) return raced;
    }
    throw new Error("GITHUB_PR_CREATE_FAILED");
  }
}
