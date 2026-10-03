import { describe, expect, it } from "vitest";
import { canTransitionRun } from "./run-status";
describe("run transitions", () => {
  it("allows normal execution", () => { expect(canTransitionRun("queued", "starting")).toBe(true); expect(canTransitionRun("starting", "running")).toBe(true); expect(canTransitionRun("running", "completed")).toBe(true); });
  it("keeps terminal runs terminal", () => { expect(canTransitionRun("completed", "running")).toBe(false); expect(canTransitionRun("stopped", "running")).toBe(false); });
});
