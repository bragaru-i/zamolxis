export interface NodeInfo {
  readonly version: string;
}
export function createNodeInfo(): NodeInfo {
  return { version: "0.0.0" };
}
export * from "./capabilities/capability-trace";
export * from "./capabilities/repository-discovery";
export * from "./capabilities/orchestrator";
export * from "./capabilities/supervisor";
export * from "./control-plane/driver";
export * from "./persistence/local-state";
export * from "./repository/repository-registry";
export * from "./runtime/model-catalog";
export * from "./runtime/runtime-manager";
export * from "./trace/recorder";
export * from "./trace/steps";
export * from "./trace/supervisor-log";
export * from "./workspace/workspace-manager";
export * from "./integration/publish";
