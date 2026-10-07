import type {
  AgentRunId,
  NormalizedRunEventDto,
  WorkspaceId,
  WorkstationId,
} from "@zamolxis/contracts";
import type { StartRunInput } from "@zamolxis/runtime-core";
import { describe, expect, it, vi } from "vitest";
import { LocalChatRuntime } from "./local-runtime";

const input = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  runId: "orchestrator:m1" as AgentRunId,
  workstationId: "w1" as WorkstationId,
  instruction: "Reply with JSON",
  role: "supervisor",
  workspace: {
    workspaceId: "orchestrator:m1" as WorkspaceId,
    cwd: "/tmp/scratch",
    branch: "orchestrator",
    headSha: "orchestrator",
  },
  ...overrides,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const MODELS = { data: [{ id: "text-embedding-nomic" }, { id: "qwen/qwen3-coder-30b" }] };

async function events(runtime: LocalChatRuntime, id: string) {
  const all: NormalizedRunEventDto[] = [];
  for await (const event of runtime.subscribe({ nativeSessionId: id })) all.push(event);
  return all;
}

describe("LocalChatRuntime", () => {
  it("answers one Orchestrator turn with the loaded chat model and reports its tokens", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return json(MODELS);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "qwen/qwen3-coder-30b",
        messages: [{ role: "user", content: "Reply with JSON" }],
      });
      return json({
        model: "qwen/qwen3-coder-30b",
        choices: [{ message: { content: '{"decision":"answer","reply":"Hi"}' } }],
        usage: { prompt_tokens: 400, completion_tokens: 50 },
      });
    });
    const runtime = new LocalChatRuntime({
      baseUrls: ["http://127.0.0.1:1234/v1/"],
      fetch,
      now: () => 7,
    });
    const started = await runtime.start(input());
    const all = await events(runtime, started.nativeSessionId);
    expect(all.map((event) => event.type)).toEqual([
      "run.started",
      "run.activity",
      "run.usage",
      "run.completed",
    ]);
    expect(all[2]?.payload).toEqual({
      modelActual: "qwen/qwen3-coder-30b",
      inputTokens: 400,
      outputTokens: 50,
      totalTokens: 450,
      modelCalls: 1,
    });
    expect(all[3]?.payload).toEqual({ summary: '{"decision":"answer","reply":"Hi"}' });
    expect(
      all.every((event) => event.workspaceId === "orchestrator:m1" && event.occurredAt === 7),
    ).toBe(true);
    expect((await runtime.inspect(started.nativeSessionId)).state).toBe("completed");
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:1234/v1/models");
  });
  it("never runs a repository role", async () => {
    const runtime = new LocalChatRuntime({ baseUrls: ["http://x/v1"], fetch: vi.fn() });
    for (const bad of [
      input({ role: "builder" }),
      input({ role: "verifier" }),
      input({ workspace: { ...input().workspace, branch: "zam/task", headSha: "abc" } }),
    ])
      await expect(runtime.start(bad)).rejects.toThrow("LOCAL_RUNTIME_ORCHESTRATOR_ONLY");
  });
  it("lists chat models only and reports whether the server answers", async () => {
    const runtime = new LocalChatRuntime({
      baseUrls: ["http://x/v1"],
      fetch: vi.fn(async () => json(MODELS)),
    });
    expect(await runtime.listModels()).toEqual([
      { id: "qwen/qwen3-coder-30b", displayName: "qwen/qwen3-coder-30b", isDefault: true },
    ]);
    expect(await runtime.reachable()).toBe(true);
    const down = new LocalChatRuntime({
      baseUrls: ["http://x/v1"],
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(await down.reachable()).toBe(false);
    // The first server that answers is used: Ollama when LM Studio is not running.
    const fallback = new LocalChatRuntime({
      baseUrls: ["http://127.0.0.1:1234/v1", "http://127.0.0.1:11434/v1"],
      fetch: vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes(":1234")) throw new Error("ECONNREFUSED");
        return json({ data: [{ id: "deepseek-coder" }] });
      }),
    });
    expect(await fallback.reachable()).toBe(true);
    expect(fallback.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
  it("fails with the reason when the server errors, and stops on request", async () => {
    const failing = new LocalChatRuntime({
      baseUrls: ["http://x/v1"],
      fetch: vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/models") ? json(MODELS) : json({ error: "no model" }, 500),
      ),
    });
    const failed = await failing.start(input({ model: "qwen" }));
    const end = (await events(failing, failed.nativeSessionId)).at(-1);
    expect(end).toMatchObject({
      type: "run.failed",
      payload: {
        code: "LOCAL_MODEL_FAILED",
        message: "Local model failed: The local model server answered 500",
      },
    });
    let release: (() => void) | undefined;
    const slow = new LocalChatRuntime({
      baseUrls: ["http://x/v1"],
      fetch: vi.fn((url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith("/models")
          ? Promise.resolve(json(MODELS))
          : new Promise<Response>((_resolve, reject) => {
              release = () => reject(new Error("aborted"));
              init?.signal?.addEventListener("abort", () => release?.());
            }),
      ),
    });
    const running = await slow.start(input({ model: "qwen" }));
    await slow.stop({ nativeSessionId: running.nativeSessionId });
    expect((await events(slow, running.nativeSessionId)).at(-1)?.type).toBe("run.stopped");
    expect((await slow.inspect(running.nativeSessionId)).state).toBe("stopped");
  });
});
