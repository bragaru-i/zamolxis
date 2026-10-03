export class DomainError extends Error {
  constructor(
    readonly code: "INVALID_STATE" | "WORKSPACE_BUSY" | "DEPENDENCY_CYCLE",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
