import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/** Where an agent saves screenshots or previews; never committed (moved out first). */
export const PROOF_DIR = ".zamolxis-proof";
export const PROOF_MAX_FILES = 8;
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
// Nested proof folders are allowed, but only this deep.
const MAX_DEPTH = 3;

export interface ProofFile {
  /** Display name: the path inside the proof folder, or the repository path of a changed file. */
  readonly name: string;
  /** Node-local copy, outside every worktree. */
  readonly path: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  /** "proof": saved by the agent as evidence; "changed": an image the change added or edited. */
  readonly source: "proof" | "changed";
}

export function proofContentType(name: string): string | undefined {
  return TYPES[extname(name).toLowerCase()];
}

function regularFile(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function listImages(directory: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    // Symbolic links are never followed: they could point outside the worktree.
    if (entry.isDirectory()) files.push(...listImages(path, depth + 1));
    else if (entry.isFile() && proofContentType(entry.name)) files.push(path);
  }
  return files;
}

function keep(source: string, name: string, destination: string, from: ProofFile["source"]) {
  const size = regularFile(source);
  const contentType = proofContentType(name);
  if (size === undefined || !contentType || size === 0 || size > PROOF_MAX_BYTES) return;
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
  const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
  return { name, path: destination, contentType, size, sha256, source: from } satisfies ProofFile;
}

/**
 * Moves the agent's proof folder out of the worktree into `root/<runId>/proof`, so it is never
 * committed or seen by checks, and keeps at most PROOF_MAX_FILES allowed images. The folder is
 * removed from the worktree even when nothing in it qualifies.
 */
export function takeProof(worktree: string, root: string, runId: string): ProofFile[] {
  const folder = join(worktree, PROOF_DIR);
  if (!existsSync(folder)) return [];
  const kept: ProofFile[] = [];
  try {
    if (!lstatSync(folder).isDirectory()) return [];
    for (const file of listImages(folder)) {
      if (kept.length >= PROOF_MAX_FILES) break;
      const name = relative(folder, file).split(sep).join("/");
      const destination = join(
        root,
        runId,
        "proof",
        `${kept.length}${extname(file).toLowerCase()}`,
      );
      const proof = keep(file, name, destination, "proof");
      if (proof) kept.push(proof);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return kept;
}

/** Copies images a candidate added or edited (e.g. a new logo), up to the remaining room. */
export function takeChangedImages(
  worktree: string,
  root: string,
  runId: string,
  paths: readonly string[],
  room: number,
): ProofFile[] {
  const kept: ProofFile[] = [];
  for (const path of paths) {
    if (kept.length >= room) break;
    if (!proofContentType(path) || path.split("/").includes("..")) continue;
    const destination = join(
      root,
      runId,
      "changed",
      `${kept.length}${extname(basename(path)).toLowerCase()}`,
    );
    const proof = keep(join(worktree, path), path, destination, "changed");
    if (proof) kept.push(proof);
  }
  return kept;
}
