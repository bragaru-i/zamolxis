import { expect, it } from "vitest";
import { validatePlan } from "./structured-plan";
const task = (key: string, dependencies: string[] = []) => ({
  key,
  title: key,
  description: key,
  dependencies,
  verificationScripts: ["test"],
  requiredModalities: ["test"],
});
it("validates independent tasks and topologically ordered dependencies", () => {
  expect(() => validatePlan([task("a"), task("b"), task("c", ["a", "b"])])).not.toThrow();
  for (const tasks of [
    [],
    [task("a", ["a"])],
    [task("a", ["b"]), task("b", ["a"])],
    [task("a"), task("a")],
  ])
    expect(() => validatePlan(tasks)).toThrow("INVALID_PLAN");
});
it("rejects privileged shell text and empty trust policies", () => {
  expect(() => validatePlan([{ ...task("a"), verificationScripts: ["test; rm -rf /"] }])).toThrow(
    "INVALID_PLAN",
  );
  expect(() => validatePlan([{ ...task("a"), requiredModalities: [] }])).toThrow("INVALID_PLAN");
});
