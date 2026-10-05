import { expect, it } from "vitest";
import { startupWatchdog } from "./startup-watchdog";

it("ships a watchdog that parses as plain script and checks the start flag", () => {
  // biome-ignore lint/security/noGlobalEval: compile-only check of a static first-party script.
  expect(() => new Function(startupWatchdog)).not.toThrow();
  expect(startupWatchdog).toContain("__zamolxisStarted");
  expect(startupWatchdog).toContain("__convexAuth");
  expect(startupWatchdog).not.toMatch(/=>|\blet\b|\bconst\b|`/);
});
