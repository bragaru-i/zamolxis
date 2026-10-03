import type { AgentRunId, WorkspaceId, WorkstationId } from "@zamolxis/contracts";
import { FakeRuntime } from "@zamolxis/runtime-core";
import { defineRuntimeAdapterContract } from "./runtime-contract";

defineRuntimeAdapterContract("FakeRuntime", {
  create: () => new FakeRuntime(),
  input: () => ({
    runId: "run" as AgentRunId,
    workstationId: "node" as WorkstationId,
    instruction: "Perform the assigned task",
    workspace: {
      workspaceId: "workspace" as WorkspaceId,
      cwd: "/assigned/workspace",
      branch: "task",
      headSha: "abc",
    },
  }),
});
