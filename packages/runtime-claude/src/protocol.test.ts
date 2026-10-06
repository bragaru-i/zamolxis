import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeArgs,
  mapModels,
  projectDirName,
  sessionTranscriptExists,
  turnUsage,
} from "./protocol";

// Trimmed from Claude Code 2.1.287's `initialize` response.
const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "fable",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable 5.1",
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers",
  },
  {
    value: "claude-sonnet-4-6",
    resolvedModel: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5" },
];

describe("mapModels", () => {
  it("lists the CLI's models by the ids --model accepts, default first", () => {
    expect(mapModels(MODELS)).toEqual([
      {
        id: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "For complex work and everyday tasks",
        isDefault: true,
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "claude-fable-5-1",
        displayName: "Fable 5.1",
        description: "For your toughest challenges",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        description: "Fastest for quick answers",
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Sonnet 4.6",
        description: "Efficient for routine tasks",
        efforts: ["low", "medium", "high", "max"],
      },
      { id: "claude-haiku-4-5", displayName: "Haiku 4.5" },
    ]);
  });
  it("rejects a response without a model list", () => {
    expect(() => mapModels(undefined)).toThrow("CLAUDE_INVALID_RESPONSE");
    expect(mapModels([null, "x", { value: "" }])).toEqual([]);
  });
});

describe("turnUsage", () => {
  it("counts cache reads and writes as input and cache reads as cached input", () => {
    expect(
      turnUsage({
        input_tokens: 42,
        cache_creation_input_tokens: 4250,
        cache_read_input_tokens: 105268,
        output_tokens: 799,
        server_tool_use: { web_search_requests: 0 },
      }),
    ).toEqual({
      inputTokens: 109560,
      cachedInputTokens: 105268,
      cacheWriteInputTokens: 4250,
      outputTokens: 799,
    });
  });
  it("reports nothing it cannot trust", () => {
    expect(turnUsage(undefined)).toBeUndefined();
    expect(turnUsage({ output_tokens: 3 })).toBeUndefined();
    expect(turnUsage({ input_tokens: -1, output_tokens: 3 })).toBeUndefined();
    expect(turnUsage({ input_tokens: 1.5, output_tokens: 3 })).toBeUndefined();
    expect(turnUsage({ input_tokens: 1, output_tokens: 3 })).toEqual({
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
    });
  });
});

describe("claudeArgs", () => {
  it("resumes by id instead of creating a session", () => {
    const args = claudeArgs({ role: "builder", sessionId: "a", resume: "b" });
    expect(args[args.indexOf("--resume") + 1]).toBe("b");
    expect(args).not.toContain("--session-id");
  });
  it("never uses a bypass mode or the API key path", () => {
    for (const role of ["builder", "repair", "verifier", "supervisor"] as const) {
      const args = claudeArgs({ role }).join(" ");
      expect(args).not.toMatch(/bypass|dangerously|--bare/);
    }
  });
});

describe("session transcripts", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it("finds a session only under its own workspace's project directory", () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-claude-store-")));
    const workspace = join(root, "work.space");
    const other = join(root, "other");
    mkdirSync(workspace);
    mkdirSync(other);
    const id = "10234980-849a-4090-95ba-86f158a12751";
    expect(projectDirName("/private/tmp/zclaude-exp")).toBe("-private-tmp-zclaude-exp");
    const config = join(root, "config");
    mkdirSync(join(config, "projects", projectDirName(workspace)), { recursive: true });
    writeFileSync(join(config, "projects", projectDirName(workspace), `${id}.jsonl`), "{}\n");
    expect(sessionTranscriptExists(workspace, id, config)).toBe(true);
    expect(sessionTranscriptExists(other, id, config)).toBe(false);
    expect(sessionTranscriptExists(workspace, "../../etc/passwd", config)).toBe(false);
  });
});
