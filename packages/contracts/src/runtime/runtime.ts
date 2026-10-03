export type RuntimeId = "codex" | "claude" | "hermes" | (string & {});

export interface RuntimeCapabilitiesDto {
  readonly runtime: RuntimeId;
  readonly canStart: boolean;
  readonly canResume: boolean;
  readonly canMessage: boolean;
  readonly canStop: boolean;
  readonly canDiscoverSessions: boolean;
  readonly supportsSubagents: boolean;
}
