import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedOrModifiedFiles, commitCandidate } from "@zamolxis/git";
import { describe, expect, it } from "vitest";
import { PROOF_DIR, PROOF_MAX_BYTES, PROOF_MAX_FILES, takeChangedImages, takeProof } from "./proof";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "zam-proof-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return { dir, root: mkdtempSync(join(tmpdir(), "zam-proof-root-")) };
}

describe("proof images", () => {
  it("moves the proof folder out before the candidate commit, keeping only allowed images", () => {
    const { dir, root } = repository();
    const folder = join(dir, PROOF_DIR);
    mkdirSync(join(folder, "screens"), { recursive: true });
    writeFileSync(join(folder, "b-dark.png"), PNG);
    writeFileSync(
      join(folder, "screens", "a-light.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    writeFileSync(join(folder, "notes.txt"), "not an image");
    writeFileSync(join(folder, "empty.png"), "");
    writeFileSync(join(folder, "huge.png"), Buffer.alloc(PROOF_MAX_BYTES + 1));
    // A link could point anywhere on the Mac: never followed.
    symlinkSync(join(dir, "README.md"), join(folder, "link.png"));
    writeFileSync(
      join(dir, "logo.svg"),
      "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>",
    );

    const proof = takeProof(dir, root, "run-1");
    expect(proof.map((file) => [file.name, file.contentType, file.source])).toEqual([
      ["b-dark.png", "image/png", "proof"],
      ["screens/a-light.svg", "image/svg+xml", "proof"],
    ]);
    expect(proof[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(proof[0]?.path ?? "")).toEqual(PNG);
    expect(proof.every((file) => file.path.startsWith(join(root, "run-1")))).toBe(true);
    expect(existsSync(folder)).toBe(false);

    const before = git(dir, "rev-parse", "HEAD");
    const after = commitCandidate(dir);
    expect(git(dir, "show", "--name-only", "--format=", after).split("\n")).toEqual(["logo.svg"]);
    const changed = takeChangedImages(
      dir,
      root,
      "run-1",
      addedOrModifiedFiles(dir, before, after),
      PROOF_MAX_FILES - proof.length,
    );
    expect(changed.map((file) => [file.name, file.source])).toEqual([["logo.svg", "changed"]]);
  });

  it("keeps at most the limit and nothing when there is no folder", () => {
    const { dir, root } = repository();
    expect(takeProof(dir, root, "run-2")).toEqual([]);
    mkdirSync(join(dir, PROOF_DIR));
    for (let index = 0; index < PROOF_MAX_FILES + 3; index++)
      writeFileSync(join(dir, PROOF_DIR, `shot-${String(index).padStart(2, "0")}.png`), PNG);
    const proof = takeProof(dir, root, "run-2");
    expect(proof).toHaveLength(PROOF_MAX_FILES);
    expect(takeChangedImages(dir, root, "run-2", ["a.png"], 0)).toEqual([]);
    expect(takeChangedImages(dir, root, "run-2", ["../escape.png", "README.md"], 4)).toEqual([]);
  });
});
