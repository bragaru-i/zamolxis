import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CODE_MAP_PATH, codeMapSection, readCodeMap } from "./code-map";

it("reads the repository's code map, bounded, and nothing without one", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zx-map-")));
  expect(readCodeMap(root)).toBeUndefined();
  expect(codeMapSection(root)).toBe("");
  mkdirSync(join(root, ".zamolxis"));
  writeFileSync(join(root, CODE_MAP_PATH), "- Sidebar: apps/web/app/features/sessions.tsx\n");
  expect(readCodeMap(root)).toBe("- Sidebar: apps/web/app/features/sessions.tsx");
  expect(codeMapSection(root)).toContain("Repository map (.zamolxis/code-map.md)");
  writeFileSync(join(root, CODE_MAP_PATH), "x".repeat(20_000));
  expect(readCodeMap(root)?.length).toBe(12_000);
});

it("ignores a code map that is a link", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zx-map-")));
  mkdirSync(join(root, ".zamolxis"));
  writeFileSync(join(root, "elsewhere.md"), "secret map");
  symlinkSync(join(root, "elsewhere.md"), join(root, CODE_MAP_PATH));
  expect(readCodeMap(root)).toBeUndefined();
});
