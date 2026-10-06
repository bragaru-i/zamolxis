import { describe, expect, it } from "vitest";
import { githubRepositoryFromRemote, githubTokenUrl, repositoryRemoteKey } from "./github-access";

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

  it("gives the same repository one key however its remote is written", () => {
    for (const remote of [
      "https://github.com/bragaru-i/zamolxis.git",
      "https://github.com/Bragaru-I/Zamolxis",
      " https://user:secret@github.com/bragaru-i/zamolxis/ ",
      "git@github.com:bragaru-i/zamolxis.git",
      "ssh://git@github.com/bragaru-i/zamolxis",
    ])
      expect(repositoryRemoteKey(remote)).toBe("github.com/bragaru-i/zamolxis");
    expect(repositoryRemoteKey("https://GitLab.com/Team/Repo.git")).toBe("gitlab.com/Team/Repo");
    expect(repositoryRemoteKey("git@gitlab.com:Team/Repo")).toBe("gitlab.com/Team/Repo");
    expect(repositoryRemoteKey("ssh://git@ghe.example:2222/team/repo.git")).toBe(
      "ghe.example:2222/team/repo",
    );
    // Different repositories keep different keys; unparseable remotes are left alone.
    expect(repositoryRemoteKey("https://github.com/bragaru-i/other")).not.toBe(
      repositoryRemoteKey("https://github.com/bragaru-i/zamolxis"),
    );
    expect(repositoryRemoteKey("/local/path")).toBe("/local/path");
    expect(repositoryRemoteKey("https://github.com/a/b?x=1")).toBe("https://github.com/a/b?x=1");
  });
});
