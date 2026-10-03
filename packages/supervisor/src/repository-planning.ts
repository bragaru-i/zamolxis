import { contextForRole } from "@zamolxis/application";
import type { RepositoryContext } from "@zamolxis/contracts";

export interface RepositoryContextPort {
  discover(workspaceId: string): RepositoryContext | Promise<RepositoryContext>;
  assertCurrent(context: RepositoryContext): void | Promise<void>;
}

export async function planWithRepositoryContext<T>(
  workspaceId: string,
  repositories: RepositoryContextPort,
  plan: (input: { role: "supervisor"; context: RepositoryContext }) => T | Promise<T>,
): Promise<T> {
  const context = await repositories.discover(workspaceId);
  if (context.workspaceId !== workspaceId || !context.gitSha || !context.snapshotDigest)
    throw new Error("INVALID_REPOSITORY_CONTEXT");
  await repositories.assertCurrent(context);
  return plan({ ...contextForRole(context, "supervisor"), role: "supervisor" });
}
