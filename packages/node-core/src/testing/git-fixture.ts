import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@zamolxis/git";

export function repositoryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zamolxis-git-")));
  const path = join(root, "repo");
  mkdirSync(path);
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(path, "source.txt"), "base\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "base"]);
  git(path, ["remote", "add", "origin", "https://example.invalid/team/repo.git"]);
  return { root, path };
}
