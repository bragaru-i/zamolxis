import type { CommandId, WorkstationId, ZamolxisCommandDto } from "@zamolxis/contracts";

export function fakeStartCommand(overrides: Partial<Extract<ZamolxisCommandDto, { type: "runtime.start" }>> = {}): Extract<ZamolxisCommandDto, { type: "runtime.start" }> {
  return {
    commandId: "command-test" as CommandId,
    idempotencyKey: "test:start",
    type: "runtime.start",
    createdAt: 0,
    payload: {
      runId: "run-test" as never,
      taskId: "task-test" as never,
      workspaceId: "workspace-test" as never,
      runtime: "codex",
      instruction: "Test instruction",
    },
    ...overrides,
  };
}

export const TEST_WORKSTATION_ID = "workstation-test" as WorkstationId;
