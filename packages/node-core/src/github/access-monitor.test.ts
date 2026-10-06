import type { GitHubAccess, GitHubAccessStatus } from "@zamolxis/application";
import { describe, expect, it } from "vitest";
import { GitHubAccessMonitor } from "./access-monitor";
import { PublishingCredentials } from "./publishing-credentials";
import { MemoryRepositoryTokenStore } from "./token-store";

const REPO = { host: "github.com", owner: "bragaru-i", repo: "zamolxis" };
const TOKEN = `github_pat_${"M0n1t0r123".repeat(8)}`;
const OTHER = `github_pat_${"R3pl4c3d00".repeat(8)}`;
const GH = `gho_${"Gh4cc0unt0".repeat(4)}`;
const MINUTE = 60_000;

function harness() {
  let now = 1_000_000;
  const tokens = new MemoryRepositoryTokenStore();
  const checks: string[] = [];
  const reports: GitHubAccess[] = [];
  let status: GitHubAccessStatus = "ok";
  let failReport = false;
  // The gh account setup chose for r1, and the accounts signed in to gh on this Mac.
  let account: string | undefined;
  const signedIn = new Map<string, string>();
  const credentials = new PublishingCredentials({
    tokens,
    account: ({ repositoryId }) => (repositoryId === "r1" ? account : undefined),
    ghTokens: { read: (_host, login) => signedIn.get(login) },
  });
  const monitor = new GitHubAccessMonitor(
    [{ repositoryId: "r1", github: REPO }],
    credentials,
    {
      checkAccess: async (_repository, token) => {
        checks.push(token);
        return { status, login: "bragaru-i", checkedAt: now };
      },
    },
    async (_id, access) => {
      if (failReport) throw new Error("offline");
      reports.push(access);
    },
    { now: () => now },
  );
  return {
    monitor,
    tokens,
    signedIn,
    setAccount: (login: string | undefined) => {
      account = login;
    },
    checks,
    reports,
    advance: (ms: number) => {
      now += ms;
    },
    setStatus: (next: GitHubAccessStatus) => {
      status = next;
    },
    setFailReport: (next: boolean) => {
      failReport = next;
    },
  };
}

describe("GitHub access monitor", () => {
  it("reports missing tokens without calling GitHub, then checks a new token right away", async () => {
    const h = harness();
    await h.monitor.tick();
    expect(h.reports.map(({ status }) => status)).toEqual(["missing"]);
    expect(h.checks).toEqual([]);
    h.tokens.write(REPO, TOKEN);
    h.advance(30_000);
    await h.monitor.tick();
    // The Keychain is read at most once a minute.
    expect(h.checks).toEqual([]);
    h.advance(31_000);
    await h.monitor.tick();
    expect(h.checks).toEqual([TOKEN]);
    expect(h.reports.at(-1)).toMatchObject({ status: "ok", source: "token", login: "bragaru-i" });
  });

  it("reports the chosen gh account without a token, and the token once one is added", async () => {
    const h = harness();
    h.setAccount("bragaru-i");
    await h.monitor.tick();
    // The account is not signed in to gh: unavailable, GitHub is not asked.
    expect(h.reports.at(-1)).toMatchObject({
      status: "account_unavailable",
      source: "gh_account",
      login: "bragaru-i",
    });
    expect(h.checks).toEqual([]);
    h.signedIn.set("bragaru-i", GH);
    h.advance(MINUTE);
    await h.monitor.tick();
    expect(h.checks).toEqual([GH]);
    expect(h.reports.at(-1)).toMatchObject({ status: "ok", source: "gh_account" });
    // A token for the repository takes precedence over the account.
    h.tokens.write(REPO, TOKEN);
    h.advance(MINUTE);
    await h.monitor.tick();
    expect(h.checks).toEqual([GH, TOKEN]);
    expect(h.reports.at(-1)).toMatchObject({ status: "ok", source: "token" });
  });

  it("treats a gh credential that now belongs to another login as unavailable", async () => {
    const h = harness();
    h.setAccount("someone-else");
    h.signedIn.set("someone-else", GH);
    await h.monitor.tick();
    expect(h.reports.at(-1)).toMatchObject({
      status: "account_unavailable",
      login: "someone-else",
    });
  });

  it("asks GitHub at most every 30 minutes for an unchanged token, and again after a change", async () => {
    const h = harness();
    h.tokens.write(REPO, TOKEN);
    await h.monitor.tick();
    for (let i = 0; i < 10; i++) {
      h.advance(2 * MINUTE);
      await h.monitor.tick();
    }
    expect(h.checks).toHaveLength(1);
    h.tokens.write(REPO, OTHER);
    h.advance(2 * MINUTE);
    await h.monitor.tick();
    expect(h.checks).toEqual([TOKEN, OTHER]);
    h.advance(30 * MINUTE);
    await h.monitor.tick();
    expect(h.checks).toHaveLength(3);
    h.tokens.remove(REPO);
    h.advance(2 * MINUTE);
    await h.monitor.tick();
    expect(h.reports.at(-1)?.status).toBe("missing");
  });

  it("keeps a known status through a network failure and retries a failed report", async () => {
    const h = harness();
    h.tokens.write(REPO, TOKEN);
    await h.monitor.tick();
    h.setStatus("unreachable");
    h.advance(30 * MINUTE);
    await h.monitor.tick();
    expect(h.reports.map(({ status }) => status)).toEqual(["ok"]);
    h.setStatus("invalid");
    h.advance(5 * MINUTE);
    await h.monitor.tick();
    expect(h.reports.map(({ status }) => status)).toEqual(["ok", "invalid"]);
    h.setFailReport(true);
    h.setStatus("ok");
    h.advance(30 * MINUTE);
    await h.monitor.tick();
    h.setFailReport(false);
    h.advance(15_000);
    await h.monitor.tick();
    expect(h.reports.map(({ status }) => status)).toEqual(["ok", "invalid", "ok"]);
  });

  it("does nothing while the Keychain is locked", async () => {
    const h = harness();
    const locked = new GitHubAccessMonitor(
      [{ repositoryId: "r1", github: REPO }],
      new PublishingCredentials({
        tokens: {
          read: () => {
            throw new Error("KEYCHAIN_UNAVAILABLE");
          },
          write: () => undefined,
          remove: () => undefined,
        },
      }),
      { checkAccess: async () => ({ status: "ok", checkedAt: 0 }) },
      async (_id, access) => {
        h.reports.push(access);
      },
    );
    await locked.tick();
    expect(h.reports).toEqual([]);
  });
});
