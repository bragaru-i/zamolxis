import { describe, expect, it } from "vitest";
import { claudeSignedIn, findClaude } from "./claude";

describe("findClaude", () => {
  it("uses the first executable that reports a version", () => {
    const calls: string[] = [];
    const found = findClaude(
      (file) => {
        calls.push(file);
        if (file === "claude") throw new Error("ENOENT");
        return "2.1.287 (Claude Code)\n";
      },
      ["claude", "/bin/sh"],
    );
    expect(found).toEqual({ executable: "/bin/sh", version: "2.1.287 (Claude Code)" });
    expect(calls).toEqual(["claude", "/bin/sh"]);
  });
  it("finds nothing when no candidate runs", () => {
    expect(
      findClaude(() => {
        throw new Error("ENOENT");
      }, ["claude", "/does/not/exist/claude"]),
    ).toBeUndefined();
  });
});

describe("claudeSignedIn", () => {
  const status = (value: unknown) => () => JSON.stringify(value);
  it("accepts a Claude subscription login only", () => {
    expect(claudeSignedIn("claude", status({ loggedIn: true, authMethod: "claude.ai" }))).toBe(
      true,
    );
    expect(claudeSignedIn("claude", status({ loggedIn: true, authMethod: "oauth_token" }))).toBe(
      true,
    );
    expect(claudeSignedIn("claude", status({ loggedIn: true, authMethod: "api_key" }))).toBe(false);
    expect(claudeSignedIn("claude", status({ loggedIn: false, authMethod: "claude.ai" }))).toBe(
      false,
    );
    expect(claudeSignedIn("claude", () => "not json")).toBe(false);
  });
});
