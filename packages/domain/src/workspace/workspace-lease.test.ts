import { describe, expect, it } from "vitest";
import { canAcquireWorkspaceLease } from "./workspace-lease";
describe("workspace lease", () => {
  it("allows an unowned ready workspace", () => { expect(canAcquireWorkspaceLease({ status: "ready" }, "run-a")).toBe(true); });
  it("rejects another owner", () => { expect(canAcquireWorkspaceLease({ status: "in_use", ownerRunId: "run-a" }, "run-b")).toBe(false); });
});
