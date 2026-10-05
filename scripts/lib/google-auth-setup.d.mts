export interface SetupConfig {
  version: 1;
  environment: "dev" | "prod";
  deployment: string;
  appUrl: string;
  convexUrl?: string;
  httpActionsUrl?: string;
}
export interface SetupCredentials {
  deployKey: string;
  googleClientId: string;
  googleClientSecret: string;
}
export function validateConfig(config: unknown): SetupConfig;
export function validateCredentials(config: SetupConfig, credentials: unknown): void;
export function convexInvocation(
  command: string[],
  directory: string,
  config: SetupConfig,
  credentials: SetupCredentials,
  inheritedEnv: Record<string, string | undefined>,
): { args: string[]; env: Record<string, string | undefined>; envFileContent: string };

export function serializeAuthVariables(variables: Record<string, string>): string;
