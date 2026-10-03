export interface RepositorySource {
  readonly path: string;
  readonly scope: string;
  readonly digest: string;
  readonly content: string;
}
export interface RepositorySkill extends RepositorySource {
  readonly capability: string;
}
export interface CapabilityDefinition {
  readonly capability: string;
  readonly source: string;
  readonly instructions: string;
}
export interface SelectedCapability extends CapabilityDefinition {
  readonly origin: "repository" | "fallback";
}

export interface RepositoryContext {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly gitSha: string;
  readonly snapshotDigest: string;
  readonly instructions: readonly RepositorySource[];
  readonly skills: readonly RepositorySkill[];
  readonly discoveredSources: readonly string[];
  readonly conventions: readonly RepositorySource[];
  readonly resolvedCapabilities: Readonly<Record<string, SelectedCapability>>;
}
export type RepositoryRole = "supervisor" | "builder" | "verifier" | "publisher";
export interface CapabilityTrace {
  readonly workspaceId: string;
  readonly gitSha: string;
  readonly snapshotDigest: string;
  readonly role: RepositoryRole;
  readonly capability: string;
  readonly source: string;
  readonly origin: "repository" | "fallback";
  readonly decision: "allowed" | "denied";
  readonly reason: string;
}
