import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "@zamolxis/runtime-core";

/**
 * A repository's own map of where things live (area -> files), kept in the repository and
 * given to every agent so it starts from the right files instead of exploring (#163, #161).
 * Optional: a repository without one works as before.
 */
export const CODE_MAP_PATH = ".zamolxis/code-map.md";
const CODE_MAP_LIMIT = 12_000;

export function readCodeMap(root: string): string | undefined {
  try {
    const path = join(root, CODE_MAP_PATH);
    if (!lstatSync(path).isFile()) return undefined;
    const text = redactSecrets(readFileSync(path, "utf8")).trim().slice(0, CODE_MAP_LIMIT);
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** The map as a prompt section; empty without one. */
export function codeMapSection(root: string): string {
  const map = readCodeMap(root);
  return map
    ? `\n\nRepository map (${CODE_MAP_PATH}): start from the files it names for the area you work on, and search only when it does not cover it.\n${map}`
    : "";
}
