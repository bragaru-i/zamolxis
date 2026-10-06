import {
  type GitHubAccess,
  type GitHubAccessStatus,
  MemoryRepositoryTokenStore,
} from "@zamolxis/node-core";
import { describe, expect, it } from "vitest";
import {
  describeAccess,
  type GitHubTokenEnvironment,
  githubEntries,
  manageGitHubTokens,
} from "./github-token";

const TOKEN = `github_pat_${"S3tupT0k3n".repeat(8)}`;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ZAMOLXIS = { host: "github.com", owner: "bragaru-i", repo: "zamolxis" };
const repositories = [
  {
    name: "zamolxis",
    path: "/Users/me/zamolxis",
    remoteUrl: "git@github.com:bragaru-i/zamolxis.git",
    repositoryId: "r1",
  },
  {
    name: "site",
    path: "/Users/me/site",
    remoteUrl: "https://github.com/wellcopy/site.git",
    repositoryId: "r2",
  },
  { name: "internal", path: "/Users/me/internal", remoteUrl: "https://gitlab.example/x/y.git" },
];

function harness(
  options: {
    interactive?: boolean;
    passwords?: string[];
    confirms?: boolean[];
    selects?: string[];
    status?: GitHubAccessStatus;
  } = {},
) {
  const logs: string[] = [];
  const opened: string[] = [];
  const reports: Array<{ repositoryId?: string; access: GitHubAccess }> = [];
  const checked: string[] = [];
  const prompts: string[] = [];
  const tokens = new MemoryRepositoryTokenStore();
  // GitHub CLI accounts signed in on this Mac, by login.
  const signedIn = new Map<string, string>();
  const env: GitHubTokenEnvironment = {
    io: {
      log: (message) => logs.push(message),
      confirm: async (message) => {
        prompts.push(message);
        const answer = options.confirms?.shift();
        if (answer === undefined) throw new Error(`unexpected confirm: ${message}`);
        return answer;
      },
      select: async (message, choices) => {
        prompts.push(message);
        const answer = options.selects?.shift();
        if (answer === undefined) throw new Error(`unexpected select: ${message}`);
        return (choices.find((choice) => choice.name.startsWith(answer))?.value ??
          "\0done") as never;
      },
      password: async (message) => {
        prompts.push(message);
        const answer = options.passwords?.shift();
        if (answer === undefined) throw new Error(`unexpected password: ${message}`);
        return answer;
      },
    },
    tokens,
    ghTokens: { read: (_host, login) => signedIn.get(login) },
    github: {
      checkAccess: async (_repository, token) => {
        checked.push(token);
        return {
          status: options.status ?? "ok",
          login: "bragaru-i",
          expiresAt: NOW + 80 * DAY,
          checkedAt: NOW,
        };
      },
    },
    openUrl: (url) => opened.push(url),
    interactive: options.interactive ?? true,
    report: async (entry, access) => {
      reports.push({ ...(entry.repositoryId ? { repositoryId: entry.repositoryId } : {}), access });
    },
    now: () => NOW,
  };
  return { env, logs, opened, reports, checked, prompts, tokens, signedIn };
}

describe("GitHub tokens on the Mac", () => {
  it("lists only repositories with a GitHub origin", () => {
    expect(githubEntries(repositories).map((entry) => entry.github)).toEqual([
      ZAMOLXIS,
      { host: "github.com", owner: "wellcopy", repo: "site" },
    ]);
  });

  it("only reports, never asks, without a terminal (setup --repair)", async () => {
    const h = harness({ interactive: false });
    h.tokens.write(ZAMOLXIS, TOKEN);
    await manageGitHubTokens(repositories, h.env, { offer: "when-needed" });
    expect(h.prompts).toEqual([]);
    expect(h.logs).toEqual([
      "GitHub bragaru-i/zamolxis: publishing as bragaru-i (token, expires in 80 days)",
      "GitHub wellcopy/site: not connected: no token and no GitHub account chosen for this repository yet",
      "To add or replace a token, run pnpm zamolxis github-token in Terminal on this Mac.",
    ]);
    expect(h.reports.map(({ repositoryId, access }) => [repositoryId, access.status])).toEqual([
      ["r1", "ok"],
      ["r2", "missing"],
    ]);
    await expect(manageGitHubTokens(repositories, h.env, { remove: true })).rejects.toThrow(
      "--remove",
    );
    expect(h.tokens.read(ZAMOLXIS)).toBe(TOKEN);
  });

  it("explains the steps, opens the prefilled page and stores a token GitHub accepts", async () => {
    const h = harness({ confirms: [true], passwords: ["not-a-token", ` ${TOKEN} `] });
    await manageGitHubTokens(repositories, h.env, { repository: "bragaru-i/zamolxis" });
    expect(h.opened).toHaveLength(1);
    const url = new URL(h.opened[0] ?? "");
    expect(url.pathname).toBe("/settings/personal-access-tokens/new");
    expect(url.searchParams.get("target_name")).toBe("bragaru-i");
    expect(h.logs.join("\n")).toContain('"Only select repositories" → bragaru-i/zamolxis');
    expect(h.logs.join("\n")).toContain("never sent to Zamolxis or exposed to agents");
    expect(h.checked).toEqual([TOKEN]);
    expect(h.tokens.read(ZAMOLXIS)).toBe(TOKEN);
    expect(h.reports.at(-1)).toMatchObject({ repositoryId: "r1", access: { status: "ok" } });
    // The token itself is never printed.
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("does not store a token that cannot push, and removes one on request", async () => {
    const h = harness({
      status: "no_push",
      confirms: [true, false],
      passwords: [TOKEN],
    });
    await manageGitHubTokens(repositories, h.env, { repository: "zamolxis" });
    expect(h.tokens.read(ZAMOLXIS)).toBeUndefined();
    expect(h.logs.join("\n")).toContain("can't push to this repository");
    h.tokens.write(ZAMOLXIS, TOKEN);
    await manageGitHubTokens(repositories, h.env, {
      repository: "bragaru-i/zamolxis",
      remove: true,
    });
    expect(h.tokens.read(ZAMOLXIS)).toBeUndefined();
    expect(h.reports.at(-1)).toMatchObject({ repositoryId: "r1", access: { status: "missing" } });
    await expect(manageGitHubTokens(repositories, h.env, { repository: "nope" })).rejects.toThrow(
      "bragaru-i/zamolxis, wellcopy/site",
    );
  });

  it("uses the repository's chosen gh account until a token is added, and again after removal", async () => {
    const GH = `gho_${"Gh4cc0unt0".repeat(4)}`;
    const withAccount = repositories.map((repository) =>
      repository.repositoryId === "r1"
        ? {
            ...repository,
            publishingIdentity: {
              provider: "github" as const,
              host: "github.com",
              login: "bragaru-i",
            },
          }
        : repository,
    );
    expect(githubEntries(withAccount)[0]?.account).toBe("bragaru-i");
    const h = harness({ interactive: false });
    await manageGitHubTokens(withAccount, h.env, { repository: "zamolxis" });
    // Not signed in to gh: unavailable, and GitHub is not asked.
    expect(h.logs[0]).toContain("isn't signed in to gh on this Mac");
    expect(h.checked).toEqual([]);
    expect(h.reports.at(-1)?.access).toMatchObject({
      status: "account_unavailable",
      source: "gh_account",
    });
    h.signedIn.set("bragaru-i", GH);
    await manageGitHubTokens(withAccount, h.env, { repository: "zamolxis" });
    expect(h.checked).toEqual([GH]);
    expect(h.logs.at(-1)).toBe("GitHub bragaru-i/zamolxis: publishing as bragaru-i (gh account)");
    // A stored token takes precedence; removing it goes back to the account.
    h.tokens.write(ZAMOLXIS, TOKEN);
    await manageGitHubTokens(withAccount, h.env, { repository: "zamolxis" });
    expect(h.checked.at(-1)).toBe(TOKEN);
    expect(h.reports.at(-1)?.access).toMatchObject({ status: "ok", source: "token" });
    await manageGitHubTokens(withAccount, h.env, { repository: "zamolxis", remove: true });
    expect(h.reports.at(-1)?.access).toMatchObject({ status: "ok", source: "gh_account" });
    expect(h.logs.join("\n")).not.toContain(GH);
  });

  it("lets the owner pick among several repositories", async () => {
    const h = harness({ selects: ["wellcopy/site", "Done"], passwords: [TOKEN] });
    await manageGitHubTokens(repositories, h.env);
    expect(h.tokens.read({ host: "github.com", owner: "wellcopy", repo: "site" })).toBe(TOKEN);
    expect(h.tokens.read(ZAMOLXIS)).toBeUndefined();
  });

  it("describes every status in plain language", () => {
    const at = (status: GitHubAccessStatus, extra: Partial<GitHubAccess> = {}) =>
      describeAccess({ status, checkedAt: NOW, ...extra }, NOW);
    expect(at("ok", { login: "bragaru-i" })).toBe(
      "publishing as bragaru-i (token, no expiry date)",
    );
    expect(at("expiring", { login: "bragaru-i", expiresAt: NOW + DAY })).toContain(
      "(token, expires in 1 day), replace it soon",
    );
    expect(at("ok", { login: "bragaru-i", source: "gh_account" })).toBe(
      "publishing as bragaru-i (gh account)",
    );
    expect(at("account_unavailable", { login: "bragaru-i" })).toContain("gh auth login");
    for (const status of [
      "expired",
      "invalid",
      "no_push",
      "missing",
      "account_unavailable",
      "unreachable",
    ] as const)
      expect(at(status)).not.toMatch(/[A-Z_]{4,}/);
  });
});
