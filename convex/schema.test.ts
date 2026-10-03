import { describe, expect, it } from "vitest";
import schema from "./schema";

describe("control-plane schema acceptance", () => {
  it("keeps filesystem locations separate from logical repositories and runs", () => {
    expect(schema.tables.repositories.validator.fields).not.toHaveProperty("localPath");
    expect(schema.tables.repositoryLocations.validator.fields.canonicalPath.kind).toBe("string");
    expect(schema.tables.workspaces.validator.fields.repositoryId.tableName).toBe("repositories");
    expect(schema.tables.agentRuns.validator.fields.workspaceId.tableName).toBe("workspaces");
    expect(schema.tables.workspaces.validator.fields.ownerRunId.tableName).toBe("agentRuns");
  });

  it("supports bounded run history, delivery and recovery reads", () => {
    expect(schema.tables.runEvents[" indexes"]()).toEqual(expect.arrayContaining([
      { indexDescriptor: "by_run_sequence", fields: ["runId", "sequence"] },
      { indexDescriptor: "by_run_event_id", fields: ["runId", "eventId"] },
    ]));
    expect(schema.tables.commands[" indexes"]()).toContainEqual({
      indexDescriptor: "by_workstation_status", fields: ["workstationId", "status"],
    });
    expect(schema.tables.workspaces[" indexes"]()).toContainEqual({
      indexDescriptor: "by_workstation_status", fields: ["workstationId", "status"],
    });
  });
});
