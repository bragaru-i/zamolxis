// Zamolxis only ever publishes to its own branches: never a default or human branch.
export const PUBLISH_BRANCH = /^zamolxis\/[a-z0-9][a-z0-9-]{0,47}-[a-f0-9]{7}$/;

/** `zamolxis/<short-task>-<sha7>`: readable, and unique per trusted commit. */
export function publishBranchName(title: string, sha: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `zamolxis/${slug}-${sha.slice(0, 7)}`;
}
