import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "@zamolxis/git";
import { evaluateTrust } from "@zamolxis/application";
import { expect, it } from "vitest";
import { repositoryFixture } from "../testing/git-fixture";
import { runVerificationChecks } from "./checks";
it("does not hide a failed explicit check behind a static-only policy", async () => {
  const f = repositoryFixture();
  try {
    writeFileSync(
      join(f.path, "package.json"),
      JSON.stringify({ scripts: { test: "node -e 'process.exit(3)'" } }),
    );
    git(f.path, ["add", "."]);
    git(f.path, ["commit", "-m", "check"]);
    const evidence = await runVerificationChecks(f.path, ["test"], ["static"]);
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ modality: "test", result: "failed" })]),
    );
    expect(
      evaluateTrust(
        "builder",
        "sha",
        evidence.map((item) => ({
          ...item,
          subjectSha: "sha",
          verifierRunId: "verifier",
          origin: "independent-verifier" as const,
        })),
        ["static"],
      ).eligible,
    ).toBe(false);
    const missing = await runVerificationChecks(f.path, [], ["test"]);
    expect(missing.find((item) => item.modality === "test")?.result).toBe("failed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
