import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import { FakeNativeStore, FakeRuntime } from "@zamolxis/runtime-core";
import {
  defineRuntimeAdapterContract,
  defineRuntimeApprovalContract,
  defineRuntimeResumeContract,
} from "./runtime-contract";

const input = () => ({
  runId: "run" as AgentRunId,
  workstationId: "node" as WorkstationId,
  instruction: "Perform the assigned task",
  workspace: {
    workspaceId: "workspace" as WorkspaceId,
    cwd: "/assigned/workspace",
    branch: "task",
    headSha: "abc",
  },
});
defineRuntimeAdapterContract("FakeRuntime", { create: () => new FakeRuntime(), input });
defineRuntimeApprovalContract("FakeRuntime", {
  create: () =>
    new FakeRuntime([
      { type: "approval", kind: "command", summary: "pnpm test", risk: "medium" },
      { type: "success", summary: "Done" },
    ]),
  input,
  // The scenario requests the approval as soon as it starts.
  requestApproval: async () => {},
});
{
  const native = new FakeNativeStore();
  let runs = 0;
  defineRuntimeResumeContract("FakeRuntime", {
    create: () =>
      new FakeRuntime(
        [
          { type: "approval", kind: "command", summary: "pnpm test", risk: "medium" },
          { type: "success", summary: "Done" },
        ],
        () => 0,
        native,
      ),
    // Each test starts a new run, so sessions of earlier tests never interfere.
    input: () => ({ ...input(), runId: `run-${++runs}` as AgentRunId }),
    requestApproval: async () => {},
  });
}
