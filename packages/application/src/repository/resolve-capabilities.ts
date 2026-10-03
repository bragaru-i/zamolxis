import type {
  CapabilityDefinition,
  CapabilityTrace,
  RepositoryContext,
  RepositoryRole,
  SelectedCapability,
} from "@zamolxis/contracts";

export interface CapabilityPolicy {
  isAllowed(capability: string): boolean;
  readonly proofAccepted: boolean;
  readonly integrationAllowed: boolean;
}

// These actions publish/integrate a candidate; repository prose cannot waive their gates.
const publishingCapabilities = new Set(["create-pr", "deploy", "integrate", "merge"]);

export function resolveCapabilities(
  context: RepositoryContext,
  defaults: readonly CapabilityDefinition[],
): RepositoryContext {
  const resolved: Record<string, SelectedCapability> = Object.create(null);
  for (const fallback of defaults) {
    if (resolved[fallback.capability])
      throw new Error(`CAPABILITY_CONFLICT:${fallback.capability}`);
    resolved[fallback.capability] = { ...fallback, origin: "fallback" };
  }
  const repositoryNames = new Set<string>();
  for (const skill of context.skills) {
    if (repositoryNames.has(skill.capability))
      throw new Error(`CAPABILITY_CONFLICT:${skill.capability}`);
    repositoryNames.add(skill.capability);
    resolved[skill.capability] = {
      capability: skill.capability,
      source: skill.path,
      instructions: skill.content,
      origin: "repository",
    };
  }
  return { ...context, resolvedCapabilities: resolved };
}

export function selectCapability(
  context: RepositoryContext,
  capability: string,
  role: RepositoryRole,
  policy: CapabilityPolicy,
  recordTrace: (entry: CapabilityTrace) => void,
): SelectedCapability {
  const selected = context.resolvedCapabilities[capability];
  if (!selected) throw new Error(`CAPABILITY_NOT_FOUND:${capability}`);
  const reason = !policy.isAllowed(capability)
    ? "security-policy"
    : publishingCapabilities.has(capability) && !policy.proofAccepted
      ? "trust-gate"
      : publishingCapabilities.has(capability) && !policy.integrationAllowed
        ? "integration-policy"
        : "policy-allowed";
  recordTrace({
    workspaceId: context.workspaceId,
    gitSha: context.gitSha,
    snapshotDigest: context.snapshotDigest,
    role,
    capability,
    source: selected.source,
    origin: selected.origin,
    decision: reason === "policy-allowed" ? "allowed" : "denied",
    reason,
  });
  if (reason !== "policy-allowed") throw new Error(`CAPABILITY_DENIED:${reason}`);
  return selected;
}

export function contextForRole(
  context: RepositoryContext,
  role: RepositoryRole,
): { role: RepositoryRole; context: RepositoryContext } {
  // All roles receive the same snapshot; verifiers retain access to original repository instructions.
  return { role, context };
}
