import { describe, expect, it } from "vitest";
import { parseExecutionCommand } from "./convex-control-plane";

const command = (decision: unknown) => ({
  _id: "command",
  workstationId: "node",
  idempotencyKey: "approval:1",
  type: "runtime.approval",
  targetType: "run",
  targetId: "run",
  payload: { runId: "run", approvalId: "run:1", decision },
});

describe("runtime approval command parsing", () => {
  it("accepts one-time, run-scoped and rejected decisions", () => {
    for (const decision of ["approve", "approve_session", "reject"])
      expect(parseExecutionCommand(command(decision))).toMatchObject({
        type: "runtime.approval",
        payload: { decision },
      });
  });

  it("rejects unknown decisions", () => {
    expect(() => parseExecutionCommand(command("always"))).toThrow("INVALID_COMMAND");
  });
});
