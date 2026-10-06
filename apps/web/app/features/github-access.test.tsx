import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeGithubAccess, type GithubAccess, GithubAccessRow } from "./github-access";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const github = {
  slug: "bragaru-i/zamolxis",
  tokenUrl:
    "https://github.com/settings/personal-access-tokens/new?name=Zamolxis+zamolxis&target_name=bragaru-i&expires_in=90&contents=write&pull_requests=write",
};
const render = (access?: GithubAccess) =>
  renderToStaticMarkup(
    createElement(GithubAccessRow, { github, now: NOW, ...(access ? { access } : {}) }),
  );

describe("GitHub access per repository", () => {
  it("shows who publishes and when the token expires", () => {
    const html = render({
      status: "ok",
      login: "bragaru-i",
      expiresAt: NOW + 80 * DAY + 1000,
      checkedAt: NOW - 5 * 60_000,
    });
    expect(html).toContain("GitHub: publishing as bragaru-i · token expires in 80 days");
    expect(html).toContain("Checked 5 min ago");
    expect(html).not.toContain("Create a token on GitHub");
  });

  it("explains how to connect a repository, with the prefilled GitHub link", () => {
    const html = render();
    expect(html).toContain("GitHub not connected");
    expect(html).toContain("pnpm zamolxis github-token");
    expect(html).toContain("Create a token on GitHub");
    expect(html).toContain('href="https://github.com/settings/personal-access-tokens/new?');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("never paste it in this app");
    expect(html).toContain("Only select repositories");
  });

  it("describes every problem in plain language", () => {
    const at = (status: GithubAccess["status"], extra: Partial<GithubAccess> = {}) =>
      describeGithubAccess({ status, checkedAt: NOW, ...extra }, NOW);
    expect(at("expiring", { login: "bragaru-i", expiresAt: NOW + 3 * DAY })).toMatchObject({
      tone: "warning",
      needsToken: true,
    });
    expect(at("expiring", { expiresAt: NOW + 3 * DAY }).text).toContain("expires in 3 days");
    expect(at("invalid").text).toContain("no longer accepts");
    expect(at("expired").tone).toBe("danger");
    expect(at("no_push", { login: "ion-wellcopy" }).text).toContain(
      "token (ion-wellcopy) can't push to this repository",
    );
    expect(at("unreachable")).toMatchObject({ tone: "neutral", needsToken: false });
    for (const status of ["ok", "expiring", "expired", "invalid", "no_push", "missing"] as const)
      expect(at(status).text).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  it("never renders an unsafe link", () => {
    const html = renderToStaticMarkup(
      createElement(GithubAccessRow, {
        github: { slug: "x/y", tokenUrl: "javascript:alert(1)" },
        now: NOW,
      }),
    );
    expect(html).not.toContain("javascript:");
  });
});
