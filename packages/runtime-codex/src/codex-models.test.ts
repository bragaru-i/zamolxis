import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type CodexConnection, CodexRuntime } from "./codex-runtime";

function connection(pages: Record<string, unknown>, fail = false) {
  const client = {
    cwd: "",
    closed: false,
    params: [] as Record<string, unknown>[],
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "model/list") throw new Error("unexpected method");
      client.params.push(params);
      if (fail) throw new Error("CODEX_REQUEST_REJECTED");
      return pages[String(params.cursor ?? "")];
    }),
    onNotification: () => () => {},
    onClose: () => () => {},
    close: () => {
      client.closed = true;
    },
  };
  return client;
}
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  description: `${id} model`,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "fast" },
    { reasoningEffort: "high", description: "deep" },
  ],
  defaultReasoningEffort: "low",
  isDefault: false,
  ...extra,
});

describe("CodexRuntime.listModels", () => {
  it("reads every page, skips hidden models and closes the scratch connection", async () => {
    const client = connection({
      "": {
        data: [model("a", { isDefault: true }), model("secret", { hidden: true })],
        nextCursor: "p2",
      },
      p2: { data: [model("b")], nextCursor: null },
    });
    const runtime = new CodexRuntime({
      connect: (cwd) => {
        client.cwd = cwd;
        return client as unknown as CodexConnection;
      },
    });
    const models = await runtime.listModels();
    expect(models).toEqual([
      {
        id: "a",
        displayName: "A",
        description: "a model",
        isDefault: true,
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
      {
        id: "b",
        displayName: "B",
        description: "b model",
        efforts: ["low", "high"],
        defaultEffort: "low",
      },
    ]);
    expect(client.initialize).toHaveBeenCalledOnce();
    expect(client.params).toEqual([{}, { cursor: "p2" }]);
    expect(client.closed).toBe(true);
    expect(client.cwd.startsWith("/")).toBe(true);
    expect(existsSync(client.cwd)).toBe(false);
  });
  it("stops after a bounded number of pages", async () => {
    const client = connection({});
    client.request.mockImplementation(async (_method, params) => {
      client.params.push(params);
      return { data: [model(`m${client.params.length}`)], nextCursor: "again" };
    });
    const runtime = new CodexRuntime({ connect: () => client as unknown as CodexConnection });
    const models = await runtime.listModels();
    expect(models).toHaveLength(5);
    expect(client.params).toHaveLength(5);
  });
  it("throws on failure and still cleans up", async () => {
    const client = connection({}, true);
    const runtime = new CodexRuntime({
      connect: (cwd) => {
        client.cwd = cwd;
        return client as unknown as CodexConnection;
      },
    });
    await expect(runtime.listModels()).rejects.toThrow("CODEX_REQUEST_REJECTED");
    expect(client.closed).toBe(true);
    expect(existsSync(client.cwd)).toBe(false);
  });
  it("rejects a malformed response", async () => {
    const client = connection({ "": { data: "nope" } });
    const runtime = new CodexRuntime({ connect: () => client as unknown as CodexConnection });
    await expect(runtime.listModels()).rejects.toThrow("CODEX_INVALID_RESPONSE");
    expect(client.closed).toBe(true);
  });
});
