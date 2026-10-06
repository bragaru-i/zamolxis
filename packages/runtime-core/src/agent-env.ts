/**
 * GitHub credentials agents never receive. Publishing is done by the Node alone, with
 * each repository's own token from this Mac's Keychain; Builders, Verifiers, Repairs, the
 * Supervisor, the Orchestrator and repository checks run without any GitHub token, even
 * when the Node itself was started with one in its environment.
 */
export const GITHUB_TOKEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // The Node's own publishing variable (only ever set on its git push child).
  "ZAMOLXIS_PUBLISH_TOKEN",
] as const;

/** A copy of `env` without GitHub credentials, for agent and repository-script children. */
export function withoutGitHubTokens(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of GITHUB_TOKEN_ENV) delete copy[name];
  return copy;
}
