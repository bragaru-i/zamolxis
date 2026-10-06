import { describe, expect, it } from "vitest";
import { type Fetch, parseTokenExpiration, RestGitHubClient } from "./github-api";

const TOKEN = `github_pat_${"Q1w2E3r4T5".repeat(8)}`;
const REPO = { host: "github.com", owner: "bragaru-i", repo: "zamolxis" };
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body?: unknown;
  redirect?: RequestRedirect;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "network";
function fake(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    });
    const key = `${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`;
    const route = routes[key];
    const reply = Array.isArray(route) ? route.shift() : route;
    if (!reply) return new Response("{}", { status: 500 });
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  };
  return { calls, client: new RestGitHubClient({ fetch, now: () => NOW }) };
}
const user = (expires?: string): Reply => ({
  status: 200,
  body: { login: "bragaru-i", email: "never@example.invalid" },
  ...(expires ? { headers: { "github-authentication-token-expiration": expires } } : {}),
});
const repo = (push: boolean): Reply => ({
  status: 200,
  body: { full_name: "bragaru-i/zamolxis", permissions: { admin: false, push, pull: true } },
});

describe("checking a repository token", () => {
  it("reports the login, expiry and push access, sending the token only as a header", async () => {
    const { calls, client } = fake({
      "GET /user": user("2026-12-25 10:00:00 UTC"),
      "GET /repos/bragaru-i/zamolxis": repo(true),
    });
    expect(await client.checkAccess(REPO, TOKEN)).toEqual({
      status: "ok",
      login: "bragaru-i",
      expiresAt: Date.parse("2026-12-25T10:00:00Z"),
      checkedAt: NOW,
    });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.github.com/user",
      "GET https://api.github.com/repos/bragaru-i/zamolxis",
    ]);
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
      expect(call.redirect).toBe("error");
    }
  });

  it("distinguishes invalid, read-only, unselected, expiring and expired tokens", async () => {
    expect(
      (await fake({ "GET /user": { status: 401 } }).client.checkAccess(REPO, TOKEN)).status,
    ).toBe("invalid");
    expect(
      (
        await fake({
          "GET /user": user(),
          "GET /repos/bragaru-i/zamolxis": repo(false),
        }).client.checkAccess(REPO, TOKEN)
      ).status,
    ).toBe("no_push");
    // A fine-grained token that was not given this repository does not see it.
    expect(
      await fake({
        "GET /user": user(),
        "GET /repos/bragaru-i/zamolxis": { status: 404 },
      }).client.checkAccess(REPO, TOKEN),
    ).toEqual({ status: "no_push", login: "bragaru-i", checkedAt: NOW });
    const soon = new Date(NOW + 5 * DAY).toISOString().replace("T", " ").slice(0, 19);
    expect(
      await fake({
        "GET /user": user(`${soon} +0000`),
        "GET /repos/bragaru-i/zamolxis": repo(true),
      }).client.checkAccess(REPO, TOKEN),
    ).toMatchObject({ status: "expiring", expiresAt: NOW + 5 * DAY });
    const past = new Date(NOW - DAY).toISOString().replace("T", " ").slice(0, 19);
    expect(
      (await fake({ "GET /user": user(`${past} UTC`) }).client.checkAccess(REPO, TOKEN)).status,
    ).toBe("expired");
  });

  it("treats network failures and server errors as unreachable, never as invalid", async () => {
    expect(await fake({ "GET /user": "network" }).client.checkAccess(REPO, TOKEN)).toEqual({
      status: "unreachable",
      checkedAt: NOW,
    });
    expect(
      (await fake({ "GET /user": { status: 502 } }).client.checkAccess(REPO, TOKEN)).status,
    ).toBe("unreachable");
    expect(
      (
        await fake({
          "GET /user": user(),
          "GET /repos/bragaru-i/zamolxis": "network",
        }).client.checkAccess(REPO, TOKEN)
      ).status,
    ).toBe("unreachable");
  });

  it("parses GitHub's expiration header formats", () => {
    expect(parseTokenExpiration("2026-12-25 10:00:00 UTC")).toBe(
      Date.parse("2026-12-25T10:00:00Z"),
    );
    expect(parseTokenExpiration("2026-12-25 10:00:00 -0200")).toBe(
      Date.parse("2026-12-25T12:00:00Z"),
    );
    expect(parseTokenExpiration(null)).toBeUndefined();
    expect(parseTokenExpiration("soon")).toBeUndefined();
  });
});

describe("opening a pull request", () => {
  const request = {
    repository: REPO,
    token: TOKEN,
    base: "main",
    head: "zamolxis/fix-1234567",
    title: "Fix",
    body: "Opened by Zamolxis",
  };
  const list =
    "GET /repos/bragaru-i/zamolxis/pulls?state=all&head=bragaru-i%3Azamolxis%2Ffix-1234567&base=main&per_page=1";
  it("reuses an existing pull request for the branch, including a closed one", async () => {
    const { calls, client } = fake({
      [list]: { status: 200, body: [{ html_url: "https://github.com/bragaru-i/zamolxis/pull/3" }] },
    });
    expect(await client.openPullRequest(request)).toBe(
      "https://github.com/bragaru-i/zamolxis/pull/3",
    );
    expect(calls.map(({ method }) => method)).toEqual(["GET"]);
  });

  it("opens one when none is open, and finds a concurrently opened one", async () => {
    const created = fake({
      [list]: { status: 200, body: [] },
      "POST /repos/bragaru-i/zamolxis/pulls": {
        status: 201,
        body: { html_url: "https://github.com/bragaru-i/zamolxis/pull/4" },
      },
    });
    expect(await created.client.openPullRequest(request)).toBe(
      "https://github.com/bragaru-i/zamolxis/pull/4",
    );
    expect(created.calls[1]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
      body: {
        title: "Fix",
        head: "zamolxis/fix-1234567",
        base: "main",
        body: "Opened by Zamolxis",
        maintainer_can_modify: false,
      },
    });
    const raced = fake({
      [list]: [
        { status: 200, body: [] },
        { status: 200, body: [{ html_url: "https://github.com/bragaru-i/zamolxis/pull/5" }] },
      ],
      "POST /repos/bragaru-i/zamolxis/pulls": { status: 422 },
    });
    expect(await raced.client.openPullRequest(request)).toBe(
      "https://github.com/bragaru-i/zamolxis/pull/5",
    );
    const refused = fake({
      [list]: { status: 200, body: [] },
      "POST /repos/bragaru-i/zamolxis/pulls": { status: 403 },
    });
    await expect(refused.client.openPullRequest(request)).rejects.toThrow(
      "GITHUB_PR_CREATE_FAILED",
    );
  });
});
