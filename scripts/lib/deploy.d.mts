export interface DeployOptions {
  directory: string;
  pull: boolean;
  yes: boolean;
  check: boolean;
  convex: boolean;
  web: boolean;
  node: boolean;
  help?: boolean;
}
export const NODE_SERVICE_LABEL: string;
export function parseDeployArgs(argv: string[]): DeployOptions;
export function gitProblem(state: {
  branch: string;
  head: string;
  remoteHead: string;
  dirty: boolean;
}): string | undefined;
export function vercelArgs(commit: string): string[];
export function nodeServiceRunsFrom(plist: string, root: string): boolean;
export function deployedCommitMatches(bootstrap: unknown, commit: string): boolean;
