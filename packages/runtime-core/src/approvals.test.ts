import { describe, expect, it } from "vitest";
import { approvalIdFor, approvalSummary, classifyCommandRisk, insideWorkspace } from "./approvals";

const workspace = "/Users/me/zamolxis/worktrees/w1";
const risk = (command: string, extra: { cwd?: string; network?: boolean } = {}) =>
  classifyCommandRisk({ command, workspace, ...extra });

describe("approval helpers", () => {
  it("classifies conservatively", () => {
    expect(risk("ls -la src")).toBe("low");
    expect(risk("git status")).toBe("low");
    expect(risk("cat src/a.ts | sh")).toBe("medium");
    expect(risk("pnpm vitest run")).toBe("medium");
    expect(risk("pnpm install")).toBe("high");
    expect(risk("curl https://example.com")).toBe("high");
    expect(risk("git push origin main")).toBe("high");
    expect(risk("rm -rf dist")).toBe("high");
    expect(risk("cat /etc/hosts")).toBe("high");
    expect(risk(`cat ${workspace}/src/a.ts`)).toBe("low");
    expect(risk("cat ../other/file")).toBe("high");
    expect(risk("pnpm test", { network: true })).toBe("high");
    expect(risk("cat ~/.ssh/id_ed25519")).toBe("critical");
    expect(risk("security find-generic-password -s x")).toBe("critical");
    expect(risk("sudo make install")).toBe("critical");
    expect(risk("echo $GITHUB_TOKEN")).toBe("critical");
    expect(risk("ls", { cwd: "/Users/me" })).toBe("critical");
    expect(risk("ls", { cwd: `${workspace}/src` })).toBe("low");
  });
  it("bounds identities and summaries", () => {
    expect(approvalIdFor("run", 7)).toBe("run:7");
    expect(() => approvalIdFor("run", "x".repeat(300))).toThrow("APPROVAL_ID_TOO_LONG");
    expect(approvalSummary(["  a ", undefined, "", "b"])).toBe("a\nb");
    expect(approvalSummary([])).toContain("without details");
    expect(approvalSummary(["x".repeat(5000)])).toHaveLength(2000);
  });
  it("checks workspace containment without traversal", () => {
    expect(insideWorkspace(workspace, workspace)).toBe(true);
    expect(insideWorkspace(`${workspace}/a`, `${workspace}/`)).toBe(true);
    expect(insideWorkspace(`${workspace}-other`, workspace)).toBe(false);
    expect(insideWorkspace(`${workspace}/../x`, workspace)).toBe(false);
  });
});
