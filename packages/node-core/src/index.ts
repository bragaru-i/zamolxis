export interface NodeInfo { readonly version: string }
export function createNodeInfo(): NodeInfo { return { version: "0.0.0" }; }
