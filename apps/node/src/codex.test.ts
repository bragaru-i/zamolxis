import { describe, expect, it } from "vitest";
import { codexSignedIn, findCodex } from "./codex";

describe("findCodex", () => {
  it("finds the first runnable candidate and bounds its version", () => {
    expect(
      findCodex(
        (file) => {
          if (file === "missing") throw new Error("not found");
          return `codex-cli ${"1".repeat(200)}\nignored`;
        },
        ["missing", "codex"],
      ),
    ).toEqual({ executable: "codex", version: `codex-cli ${"1".repeat(118)}` });
  });

  it("returns undefined when no candidate runs", () => {
    expect(
      findCodex(() => {
        throw new Error("not found");
      }, ["missing"]),
    ).toBeUndefined();
  });
});

describe("codexSignedIn", () => {
  it("reflects login status without exposing command output", () => {
    expect(codexSignedIn("codex", () => "Logged in")).toBe(true);
    expect(
      codexSignedIn("codex", () => {
        throw new Error("not logged in");
      }),
    ).toBe(false);
  });
});
