import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_TOKEN_ENV, tokenPushOptions } from "./publish";

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
});
