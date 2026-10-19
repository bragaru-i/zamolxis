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
  return readGuide(root, CODE_MAP_PATH, CODE_MAP_LIMIT);
}

/**
 * The repository's glossary (one name per concept, the owner's words), the convention
 * of a root `CONTEXT.md` (#165). Optional, like the map.
 */
export const GLOSSARY_PATH = "CONTEXT.md";
const GLOSSARY_LIMIT = 8_000;

export function readGlossary(root: string): string | undefined {
  return readGuide(root, GLOSSARY_PATH, GLOSSARY_LIMIT);
}

/** A regular file of the repository, redacted and bounded; never a link. */
function readGuide(root: string, file: string, limit: number): string | undefined {
  try {
    const path = join(root, file);
    if (!lstatSync(path).isFile()) return undefined;
    const text = redactSecrets(readFileSync(path, "utf8")).trim().slice(0, limit);
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

/** The glossary as a prompt section; empty without one. */
export function glossarySection(root: string): string {
  const glossary = readGlossary(root);
  return glossary
    ? `\n\nRepository glossary (${GLOSSARY_PATH}): use these names in code, text and replies; the owner's words are in quotes.\n${glossary}`
    : "";
}
