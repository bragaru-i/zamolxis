export type EntityId<T extends string> = string & { readonly __entity: T };

export type WorkstationId = EntityId<"workstation">;
export type RepositoryId = EntityId<"repository">;
export type RepositoryLocationId = EntityId<"repository-location">;
export type WorkSessionId = EntityId<"work-session">;
export type TaskId = EntityId<"task">;
export type WorkspaceId = EntityId<"workspace">;
export type AgentRunId = EntityId<"agent-run">;
export type CommandId = EntityId<"command">;
export type ApprovalId = EntityId<"approval">;
