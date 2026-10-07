import { afterEach, describe, expect, it, vi } from "vitest";
import { codexLocalReady, codexProvider } from "./local-model";

afterEach(() => vi.unstubAllGlobals());
const server = (baseUrl: string | undefined, reachable = true) => ({
  baseUrl,
  reachable: async () => reachable,
});

describe("Codex + local model readiness", () => {
  it("knows which local servers Codex can drive", () => {
    expect(codexProvider("http://127.0.0.1:1234/v1")).toBe("lmstudio");
    expect(codexProvider("http://127.0.0.1:11434/v1")).toBe("ollama");
    expect(codexProvider("http://127.0.0.1:8080/v1")).toBeUndefined();
  });
  it("needs a loaded LM Studio model with enough context", async () => {
    const context = (size: number) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ data: [{ state: "loaded", loaded_context_length: size }] }),
        ),
      );
    context(8192);
    expect(await codexLocalReady(server("http://127.0.0.1:1234/v1"))).toMatchObject({
      ready: false,
      provider: "lmstudio",
      reason: expect.stringContaining("8192"),
    });
    context(32768);
    expect(await codexLocalReady(server("http://127.0.0.1:1234/v1"))).toEqual({
      ready: true,
      provider: "lmstudio",
    });
    expect(await codexLocalReady(server(undefined, false))).toMatchObject({ ready: false });
    expect(await codexLocalReady(server("http://127.0.0.1:8080/v1"))).toMatchObject({
      ready: false,
      reason: expect.stringContaining("LM Studio or Ollama"),
    });
  });
});
