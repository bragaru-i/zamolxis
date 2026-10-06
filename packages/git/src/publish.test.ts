import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_TOKEN_ENV, pushCommit, tokenPushOptions } from "./publish";

const TOKEN = `github_pat_${"Z9y8X7w6V5".repeat(8)}`;
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("token pushes", () => {
  it("answer credentials only from the child environment, ignoring every other helper", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-credential-"));
    roots.push(root);
    // A global and a repository helper that would answer as someone else.
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, ".gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=global; echo password=global-secret; }; f"\n',
    );
    vi.stubEnv("HOME", home);
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "credential.helper",
      "!f() { echo username=local; echo password=local-secret; }; f",
    ]);
    const { args, env } = tokenPushOptions(TOKEN);
    // The token travels in the environment, never in argv.
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(env[PUBLISH_TOKEN_ENV]).toBe(TOKEN);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    const output = execFileSync("git", [...args, "-C", repo, "credential", "fill"], {
      encoding: "utf8",
      env,
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
    });
    expect(output).toContain("username=x-access-token");
    expect(output).toContain(`password=${TOKEN}`);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("global");
    // With a known login (a gh account's token) it is the HTTPS username.
    const named = tokenPushOptions(TOKEN, "bragaru-i");
    expect(named.args.join(" ")).not.toContain(TOKEN);
    const asLogin = execFileSync("git", [...named.args, "-C", repo, "credential", "fill"], {
      encoding: "utf8",
      env: named.env,
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
    });
    expect(asLogin).toContain("username=bragaru-i");
    expect(asLogin).toContain(`password=${TOKEN}`);
    expect(() => tokenPushOptions(TOKEN, "bad\nname")).toThrow("INVALID_PUSH_USERNAME");
    expect(() => tokenPushOptions(`${TOKEN}\n`)).toThrow("INVALID_PUSH_TOKEN");
  });

  it("treats an exact remote branch as an idempotent successful push", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-publish-retry-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Zamolxis Test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, "source.txt"), "candidate\n");
    execFileSync("git", ["-C", repo, "add", "source.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "candidate"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const branch = `zamolxis/candidate-${sha.slice(0, 7)}`;
    execFileSync("git", ["-C", repo, "push", "-q", remote, `${sha}:refs/heads/${branch}`]);
    const hook = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    expect(() => pushCommit(repo, sha, branch, { target: remote, token: TOKEN })).not.toThrow();
  });
});
