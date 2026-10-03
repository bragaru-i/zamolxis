export interface NodeInfo { readonly version: string }
export function createNodeInfo(): NodeInfo { return { version: "0.0.0" }; }
export * from "./persistence/local-state";
export * from "./repository/repository-registry";
export * from "./workspace/workspace-manager";
