import { describe, expect, it } from "vitest";
import { assertAcyclic, getReadyTaskIds } from "./dependency-graph";
describe("task dependency graph", () => {
  it("returns tasks whose dependencies are complete", () => { expect(getReadyTaskIds([{ id: "a", status: "completed" }, { id: "b", status: "blocked" }], [{ taskId: "b", dependsOnTaskId: "a", requiresSuccess: true }])).toEqual(["b"]); });
  it("rejects cycles", () => { expect(() => assertAcyclic(["a", "b"], [{ taskId: "a", dependsOnTaskId: "b", requiresSuccess: true }, { taskId: "b", dependsOnTaskId: "a", requiresSuccess: true }])).toThrow(); });
});
