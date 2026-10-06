import { describe, expect, it } from "vitest";
import { boundRuntimeModels, RUNTIME_MODEL_LIMITS } from "./models";

describe("boundRuntimeModels", () => {
  it("normalizes, deduplicates and bounds entries", () => {
    const models = boundRuntimeModels([
      {
        id: " a ",
        displayName: "x".repeat(200),
        description: "d".repeat(400),
        isDefault: true,
        efforts: [
          "low",
          "low",
          "",
          3,
          "e".repeat(80),
          ...Array.from({ length: 20 }, (_, i) => `${i}`),
        ],
        defaultEffort: "low",
      },
      { id: "a", displayName: "duplicate" },
      { id: "" },
      { id: "i".repeat(300) },
      null,
      "text",
      { id: "b" },
    ]);
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("a");
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.displayName).toHaveLength(RUNTIME_MODEL_LIMITS.displayName);
    expect(models[0]?.description).toHaveLength(RUNTIME_MODEL_LIMITS.description);
    expect(models[0]?.efforts).toHaveLength(RUNTIME_MODEL_LIMITS.efforts);
    expect(models[0]?.efforts?.[0]).toBe("low");
    expect(models[0]?.efforts?.[1]).toHaveLength(RUNTIME_MODEL_LIMITS.effort);
    expect(models[1]).toEqual({ id: "b", displayName: "b" });
  });
  it("keeps at most the model limit", () => {
    const models = boundRuntimeModels(Array.from({ length: 80 }, (_, i) => ({ id: `m${i}` })));
    expect(models).toHaveLength(RUNTIME_MODEL_LIMITS.models);
  });
});
