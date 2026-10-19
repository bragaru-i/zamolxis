import { describe, expect, it } from "vitest";
import { type LoadedModel, LocalModelSwitch } from "./local-switch";

/** A pretend LM Studio: `lms ps --json`, `unload --all` and `load` change what is loaded. */
function lmStudio(initial: Array<LoadedModel & { status: string }>) {
  let loaded = [...initial];
  const calls: string[] = [];
  const exec = async (args: string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return JSON.stringify(loaded);
    if (args[0] === "unload") loaded = [];
    if (args[0] === "load")
      loaded = [{ identifier: args[1] ?? "", status: "idle", contextLength: Number(args[3]) }];
    return "";
  };
  return {
    calls,
    exec,
    set: (models: typeof loaded) => {
      loaded = models;
    },
  };
}

describe("LocalModelSwitch", () => {
  it("leaves a ready model alone", async () => {
    const lm = lmStudio([{ identifier: "qwen-a", status: "idle", contextLength: 32768 }]);
    await new LocalModelSwitch({ exec: lm.exec, minContext: 32768 }).ensure("qwen-a");
    expect(lm.calls).toEqual(["ps --json"]);
  });

  it("reloads a model whose context is too small, and swaps in another one", async () => {
    const lm = lmStudio([{ identifier: "qwen-a", status: "idle", contextLength: 8192 }]);
    const sw = new LocalModelSwitch({ exec: lm.exec, minContext: 32768 });
    await sw.ensure("qwen-a");
    await sw.ensure("qwen-b");
    expect(lm.calls).toEqual([
      "ps --json",
      "unload --all",
      "load qwen-a --context-length 32768 --identifier qwen-a --yes",
      "ps --json",
      "ps --json",
      "unload --all",
      "load qwen-b --context-length 32768 --identifier qwen-b --yes",
      "ps --json",
    ]);
  });

  it("waits until a busy model is idle before switching", async () => {
    const lm = lmStudio([{ identifier: "qwen-a", status: "generating", contextLength: 32768 }]);
    let waits = 0;
    const sw = new LocalModelSwitch({
      exec: lm.exec,
      minContext: 32768,
      sleep: async () => {
        waits++;
        if (waits === 2) lm.set([{ identifier: "qwen-a", status: "idle", contextLength: 32768 }]);
      },
    });
    await sw.ensure("qwen-b");
    expect(waits).toBe(2);
    expect(lm.calls.filter((call) => call.startsWith("load"))).toEqual([
      "load qwen-b --context-length 32768 --identifier qwen-b --yes",
    ]);
  });

  it("runs switches one at a time and fails clearly when loading does not work", async () => {
    const lm = lmStudio([]);
    const order: string[] = [];
    const sw = new LocalModelSwitch({
      exec: async (args) => {
        if (args[0] === "load") order.push(`start ${args[1]}`);
        const out = await lm.exec(args);
        if (args[0] === "load") order.push(`end ${args[1]}`);
        return out;
      },
      minContext: 32768,
    });
    await Promise.all([sw.ensure("qwen-a"), sw.ensure("qwen-b")]);
    expect(order).toEqual(["start qwen-a", "end qwen-a", "start qwen-b", "end qwen-b"]);
    const broken = new LocalModelSwitch({
      exec: async (args) => (args[0] === "ps" ? "[]" : ""),
      minContext: 32768,
    });
    await expect(broken.ensure("qwen-a")).rejects.toThrow("LOCAL_MODEL_SWITCH_FAILED");
  });
});
