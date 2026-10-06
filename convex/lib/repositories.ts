import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { load } from "./access";

/**
 * The entry that stands for a repository today. A repository registered twice (the same
 * remote written differently on another computer) is merged into its oldest entry; a
 * Node or client still holding the merged id is pointed at the survivor.
 */
export async function canonicalRepository(
  ctx: QueryCtx,
  repositoryId: Id<"repositories">,
): Promise<Doc<"repositories">> {
  let repository = await load(ctx, "repositories", repositoryId);
  for (let hop = 0; repository.mergedIntoId && hop < 8; hop++)
    repository = await load(ctx, "repositories", repository.mergedIntoId);
  return repository;
}
