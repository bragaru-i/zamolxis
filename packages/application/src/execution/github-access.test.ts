import { describe, expect, it } from "vitest";
import { githubRepositoryFromRemote, githubTokenUrl } from "./github-access";

describe("GitHub repositories for publishing", () => {
  it("recognizes https, ssh and scp-like GitHub remotes only", () => {
    const zamolxis = { host: "github.com", owner: "bragaru-i", repo: "zamolxis" };
    for (const remote of [
      "https://github.com/bragaru-i/zamolxis.git",
      "https://user:secret@github.com/bragaru-i/zamolxis",
      "git@github.com:bragaru-i/zamolxis.git",
      "ssh://git@github.com/bragaru-i/zamolxis",
    ])
      expect(githubRepositoryFromRemote(remote)).toEqual(zamolxis);
    for (const remote of [
      undefined,
      "https://gitlab.com/bragaru-i/zamolxis.git",
      "https://github.com/bragaru-i",
      "https://github.com/a/b/c",
      "https://github.com/a/b?x=1",
      "/local/path",
      "file:///tmp/repo.git",
    ])
      expect(githubRepositoryFromRemote(remote)).toBeUndefined();
    expect(githubRepositoryFromRemote("https://ghe.example/team/repo", ["ghe.example"])).toEqual({
      host: "ghe.example",
      owner: "team",
      repo: "repo",
    });
  });

  it("prefills GitHub's fine-grained token page with the publishing permissions", () => {
    const url = new URL(
      githubTokenUrl({ host: "github.com", owner: "bragaru-i", repo: "zamolxis" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: "Zamolxis zamolxis",
      description:
        "Zamolxis publishing (push a trusted branch and open its pull request) for bragaru-i/zamolxis",
      target_name: "bragaru-i",
      expires_in: "90",
      contents: "write",
      pull_requests: "write",
    });
    const long = new URL(githubTokenUrl({ host: "github.com", owner: "o", repo: "r".repeat(80) }));
    expect(long.searchParams.get("name")?.length).toBe(40);
  });
});
