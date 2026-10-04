import { expect, it } from "vitest";
import { evaluateTrust } from "./execution-policy";
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
