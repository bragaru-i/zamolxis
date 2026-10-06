import { type AgentRuntime, FakeRuntime, type RuntimeModelDto } from "@zamolxis/runtime-core";
import { describe, expect, it, vi } from "vitest";
import { RuntimeModelCatalog } from "./model-catalog";

function runtime(listModels: () => Promise<RuntimeModelDto[]>): AgentRuntime {
  // Only the identity and listModels are used by the catalog.
  return { id: "codex", listModels } as unknown as AgentRuntime;
}
const entry = { runtime: "codex", capabilities: ["start"], version: "1" };

describe("RuntimeModelCatalog", () => {
  it("caches models and asks the runtime at most once per refresh interval", async () => {
    let now = 0;
    const listModels = vi.fn(async () => [{ id: "a", displayName: "A", isDefault: true }]);
    const codex = runtime(listModels);
    const catalog = new RuntimeModelCatalog((id) => (id === "codex" ? codex : undefined), {
      now: () => now,
      refreshMs: 1000,
    });
    expect(await catalog.advertise([entry])).toEqual([
      { ...entry, models: [{ id: "a", displayName: "A", isDefault: true }] },
    ]);
    now = 999;
    await catalog.advertise([entry]);
    expect(listModels).toHaveBeenCalledTimes(1);
    now = 1000;
    await catalog.advertise([entry]);
    expect(listModels).toHaveBeenCalledTimes(2);
  });
  it("keeps the previous list when a refresh fails and never throws", async () => {
    let now = 0;
    const listModels = vi
      .fn<() => Promise<RuntimeModelDto[]>>()
      .mockResolvedValueOnce([{ id: "a", displayName: "A" }])
      .mockRejectedValue(new Error("CODEX_PROCESS_EXITED"));
    const codex = runtime(listModels);
    const catalog = new RuntimeModelCatalog(() => codex, { now: () => now, refreshMs: 10 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await catalog.advertise([entry]);
    now = 10;
    expect(await catalog.advertise([entry])).toEqual([
      { ...entry, models: [{ id: "a", displayName: "A" }] },
    ]);
    // The failed attempt counts: the runtime is not asked again before the interval.
    now = 15;
    await catalog.advertise([entry]);
    expect(listModels).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
  it("sends the entry without models when the first fetch fails or the runtime cannot list", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = runtime(async () => {
      throw new Error("boom");
    });
    const catalog = new RuntimeModelCatalog((id) => (id === "codex" ? failing : new FakeRuntime()));
    expect(await catalog.advertise([entry, { runtime: "fake", capabilities: ["start"] }])).toEqual([
      entry,
      { runtime: "fake", capabilities: ["start"] },
    ]);
    errors.mockRestore();
  });
  it("does not hold the heartbeat for a slow runtime", async () => {
    let finish: (models: RuntimeModelDto[]) => void = () => {};
    const slow = runtime(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const catalog = new RuntimeModelCatalog(() => slow, { waitMs: 5 });
    expect(await catalog.advertise([entry])).toEqual([entry]);
    finish([{ id: "late", displayName: "Late" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await catalog.advertise([entry])).toEqual([
      { ...entry, models: [{ id: "late", displayName: "Late" }] },
    ]);
  });
});
