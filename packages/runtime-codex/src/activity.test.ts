import { describe, expect, it } from "vitest";
import { describeItem, displayCommand, fitPayload, PAYLOAD_LIMIT } from "./activity";

const command = (extra: Record<string, unknown>) => ({
  id: "c",
  type: "commandExecution",
  command: '/bin/zsh -lc "pnpm test"',
  cwd: "/w",
  aggregatedOutput: "OUTPUT",
  status: "inProgress",
  exitCode: null,
  ...extra,
});

describe("describeItem", () => {
  it("shows the command line, its exit code and never the output", () => {
    expect(describeItem(command({}), false)).toEqual({
      kind: "tool",
      tool: "command",
      summary: "pnpm test",
    });
    expect(describeItem(command({ status: "completed", exitCode: 0 }), true)).toEqual({
      kind: "tool",
      tool: "command",
      summary: "pnpm test",
      success: true,
    });
    expect(describeItem(command({ status: "failed", exitCode: 1 }), true)).toMatchObject({
      summary: "pnpm test · exit code 1",
      success: false,
    });
    expect(describeItem(command({ status: "declined" }), true)).toMatchObject({
      summary: "pnpm test · declined",
      success: false,
    });
    expect(describeItem(command({ status: "failed" }), true)).toMatchObject({
      summary: "pnpm test · failed",
      success: false,
    });
    expect(describeItem(command({ command: "" }), false)).toMatchObject({ summary: "Command" });
    expect(JSON.stringify(describeItem(command({ status: "completed" }), true))).not.toContain(
      "OUTPUT",
    );
  });

  it("redacts and bounds command lines", () => {
    const secret = describeItem(
      command({ command: `/bin/bash -lc 'curl -H "Authorization: Bearer abc" https://x'` }),
      false,
    );
    expect(secret).toMatchObject({ summary: 'curl -H "Authorization: ***" https://x' });
    const long = describeItem(
      command({ command: `echo ${"word ".repeat(300)}`, status: "failed", exitCode: 2 }),
      true,
    );
    if (long?.kind !== "tool") throw new Error("expected a tool");
    expect(long.summary.length).toBeLessThanOrEqual(500);
    expect(long.summary.endsWith("… · exit code 2")).toBe(true);
  });

  it("names MCP and dynamic tools with a short failure reason", () => {
    const mcp = {
      id: "m",
      type: "mcpToolCall",
      server: "github",
      tool: "search_issues",
      arguments: { query: "ARGUMENT" },
      result: { content: "RESULT" },
      status: "inProgress",
    };
    expect(describeItem(mcp, false)).toEqual({
      kind: "tool",
      tool: "mcp",
      summary: "github/search_issues",
    });
    expect(describeItem({ ...mcp, status: "completed" }, true)).toMatchObject({
      summary: "github/search_issues",
      success: true,
    });
    const failed = describeItem(
      { ...mcp, status: "failed", error: { message: `token=abc ${"bad ".repeat(50)}` } },
      true,
    );
    expect(failed).toMatchObject({ success: false });
    if (failed?.kind !== "tool") throw new Error("expected a tool");
    expect(failed.summary.startsWith("github/search_issues · failed: token=*** bad")).toBe(true);
    expect(failed.summary.length).toBeLessThan(120);
    expect(JSON.stringify(failed)).not.toMatch(/ARGUMENT|RESULT/);
    expect(
      describeItem(
        {
          id: "d",
          type: "dynamicToolCall",
          namespace: null,
          tool: "lookup",
          status: "completed",
          success: false,
        },
        true,
      ),
    ).toEqual({ kind: "tool", tool: "tool", summary: "lookup · failed", success: false });
  });

  it("labels web searches, sub-agents and agent items without their text", () => {
    const search = { id: "s", type: "webSearch", query: "vitest mocks", action: null };
    expect(describeItem(search, false)).toEqual({
      kind: "tool",
      tool: "web",
      summary: 'Search "vitest mocks"',
    });
    expect(describeItem(search, true)).toMatchObject({ success: true });
    expect(
      describeItem(
        {
          id: "o",
          type: "webSearch",
          query: "",
          action: { type: "openPage", url: "https://a:b@x.dev/p" },
        },
        false,
      ),
    ).toMatchObject({ summary: "Open https://***@x.dev/p" });
    expect(describeItem({ id: "w", type: "webSearch", query: "" }, false)).toMatchObject({
      summary: "Web search",
    });
    expect(
      describeItem(
        { id: "a", type: "collabAgentToolCall", tool: "spawnAgent", status: "failed" },
        true,
      ),
    ).toEqual({ kind: "tool", tool: "agent", summary: "Start sub-agent · failed", success: false });
    expect(describeItem({ id: "r", type: "reasoning", summary: ["PRIVATE"] }, false)).toEqual({
      kind: "activity",
      label: "Thinking",
    });
    expect(describeItem({ id: "m", type: "agentMessage", text: "PRIVATE" }, false)).toEqual({
      kind: "activity",
      label: "Writing reply",
    });
    expect(describeItem({ id: "p", type: "plan", text: "PRIVATE" }, false)).toEqual({
      kind: "activity",
      label: "Planning",
    });
    expect(describeItem({ id: "m", type: "agentMessage", text: "PRIVATE" }, true)).toBeUndefined();
    expect(describeItem({ id: "u", type: "userMessage", content: [] }, false)).toBeUndefined();
    expect(describeItem({ id: "f", type: "fileChange", changes: [] }, false)).toBeUndefined();
    expect(describeItem({ id: "x", type: "somethingNew" }, false)).toBeUndefined();
  });
});

describe("displayCommand", () => {
  it("unwraps the shell wrapper Codex uses", () => {
    expect(displayCommand('/bin/zsh -lc "rg \\"foo\\" src"')).toBe('rg "foo" src');
    expect(displayCommand("bash -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(displayCommand("git status")).toBe("git status");
    expect(displayCommand('/bin/zsh -lc "a" && b "c"')).toBe('/bin/zsh -lc "a" && b "c"'.trim());
  });
});

describe("fitPayload", () => {
  it("keeps payloads under the backend event limit", () => {
    const small = { tool: "command", summary: "pnpm test" };
    expect(fitPayload(small)).toBe(small);
    const paths = Array.from({ length: 100 }, (_, index) => `${"d/".repeat(200)}${index}.ts`);
    const fitted = fitPayload({ paths });
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(PAYLOAD_LIMIT);
    expect((fitted.paths as string[])[0]).toBe(paths[0]);
    const text = fitPayload({ summary: '"'.repeat(9000) });
    expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(PAYLOAD_LIMIT);
  });
});
