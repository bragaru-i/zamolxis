import { expect, it } from "vitest";
import { applyRunEvent, evaluateTrust } from "./execution-policy";
it("rejects builder claims, stale evidence and independent failures", () => {
  const proof = {
    subjectSha: "sha",
    verifierRunId: "verifier",
    origin: "independent-verifier" as const,
    result: "passed" as const,
  };
  const evidence = [
    { ...proof, modality: "static" },
    { ...proof, modality: "behavioral" },
  ];
  expect(evaluateTrust("builder", "sha", evidence).eligible).toBe(true);
  expect(evaluateTrust("builder", "changed", evidence).eligible).toBe(false);
  expect(
    evaluateTrust(
      "builder",
      "sha",
      evidence.map((item) => ({ ...item, origin: "builder" })),
    ).eligible,
  ).toBe(false);
  expect(
    evaluateTrust(
      "builder",
      "sha",
      evidence.map((item) => ({ ...item, verifierRunId: "builder" })),
    ).eligible,
  ).toBe(false);
  expect(
    evaluateTrust("builder", "sha", [
      ...evidence,
      { ...proof, modality: "security", result: "failed" },
    ]).eligible,
  ).toBe(false);
});

it("keeps a stopping run stopping until a terminal event arrives", () => {
  expect(applyRunEvent("stopping", "run.started")).toBe("stopping");
  expect(applyRunEvent("stopping", "run.activity")).toBe("stopping");
  expect(applyRunEvent("stopping", "run.waiting")).toBe("stopping");
  expect(applyRunEvent("stopping", "run.stopped")).toBe("stopped");
  expect(applyRunEvent("stopping", "run.completed")).toBe("completed");
  expect(() => applyRunEvent("stopped", "run.started")).toThrow();
});
