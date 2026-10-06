import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileRepositoryTokenStore,
  GITHUB_TOKEN_SERVICE,
  isGitHubToken,
  KeychainRepositoryTokenStore,
  MemoryRepositoryTokenStore,
  type SecurityRunner,
  tokenAccount,
} from "./token-store";

const TOKEN = `github_pat_${"P0o9I8u7Y6".repeat(8)}`;
const REPO = { host: "github.com", owner: "Bragaru-I", repo: "Zamolxis" };

describe("repository token store", () => {
  it("keys tokens by the repository's GitHub identity", () => {
    expect(tokenAccount(REPO)).toBe("github.com/bragaru-i/zamolxis");
    expect(() => tokenAccount({ ...REPO, owner: "a b" })).toThrow("INVALID_TOKEN_ACCOUNT");
    expect(isGitHubToken(TOKEN)).toBe(true);
    expect(isGitHubToken(`ghp_${"a".repeat(36)}`)).toBe(true);
    for (const bad of ["", "password", `github_pat_${"a".repeat(10)}`, `${TOKEN} -x`, `${TOKEN}\n`])
      expect(isGitHubToken(bad)).toBe(false);
  });

  it("keeps tokens in memory for tests", () => {
    const store = new MemoryRepositoryTokenStore();
    expect(store.read(REPO)).toBeUndefined();
    store.write(REPO, TOKEN);
    expect(store.read({ ...REPO, owner: "bragaru-i", repo: "zamolxis" })).toBe(TOKEN);
    expect(() => store.write(REPO, "not-a-token")).toThrow("INVALID_GITHUB_TOKEN");
    store.remove(REPO);
    expect(store.read(REPO)).toBeUndefined();
  });

  it("stores Linux tokens in a private local file", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-tokens-"));
    const path = join(root, "private", "github-tokens.json");
    try {
      const store = new FileRepositoryTokenStore(path);
      expect(store.read(REPO)).toBeUndefined();
      store.write(REPO, TOKEN);
      expect(store.read(REPO)).toBe(TOKEN);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      chmodSync(path, 0o644);
      expect(() => store.read(REPO)).toThrow("MUST_BE_PRIVATE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes through security's stdin, never its arguments, and reads with -w", () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const items = new Map<string, string>();
    const run: SecurityRunner = (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      if (args[0] === "-i") {
        const match = / -a (\S+) .* -w (\S+)\n$/.exec(input ?? "");
        if (match?.[1] && match[2]) items.set(match[1], match[2]);
        return { status: 0, stdout: "" };
      }
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "delete-generic-password")
        return { status: items.delete(account) ? 0 : 44, stdout: "" };
      const value = items.get(account);
      return value ? { status: 0, stdout: `${value}\n` } : { status: 44, stdout: "" };
    };
    const store = new KeychainRepositoryTokenStore(run, "darwin");
    expect(store.read(REPO)).toBeUndefined();
    store.write(REPO, TOKEN);
    expect(store.read(REPO)).toBe(TOKEN);
    store.remove(REPO);
    store.remove(REPO);
    expect(store.read(REPO)).toBeUndefined();
    for (const call of calls) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(calls.find((call) => call.args[0] === "-i")?.input).toBe(
      `add-generic-password -U -s ${GITHUB_TOKEN_SERVICE} -a github.com/bragaru-i/zamolxis -l Zamolxis -w ${TOKEN}\n`,
    );
    expect(calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      GITHUB_TOKEN_SERVICE,
      "-a",
      "github.com/bragaru-i/zamolxis",
      "-w",
    ]);
    // Malformed values are never written and a locked Keychain is an error, not "missing".
    expect(() => store.write(REPO, `${TOKEN}\nadd-generic-password`)).toThrow(
      "INVALID_GITHUB_TOKEN",
    );
    const locked = new KeychainRepositoryTokenStore(() => ({ status: 51, stdout: "" }), "darwin");
    expect(() => locked.read(REPO)).toThrow("KEYCHAIN_UNAVAILABLE");
    expect(() => new KeychainRepositoryTokenStore(run, "linux").read(REPO)).toThrow(
      "KEYCHAIN_REQUIRES_MACOS",
    );
  });
});
