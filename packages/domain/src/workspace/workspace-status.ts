export type WorkspaceStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "in_use"
  | "dirty"
  | "integrating"
  | "completed"
  | "cleanup_pending"
  | "removed"
  | "error";
