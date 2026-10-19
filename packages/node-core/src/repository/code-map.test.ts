import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  CODE_MAP_PATH,
  codeMapSection,
  GLOSSARY_PATH,
  glossarySection,
  readCodeMap,
  readGlossary,
} from "./code-map";

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

it("reads the repository's glossary, bounded, and nothing without one or as a link", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zx-glossary-")));
  expect(readGlossary(root)).toBeUndefined();
  expect(glossarySection(root)).toBe("");
  writeFileSync(join(root, GLOSSARY_PATH), "- **Task:** one unit of a plan.\n");
  expect(glossarySection(root)).toContain("Repository glossary (CONTEXT.md)");
  expect(glossarySection(root)).toContain("- **Task:** one unit of a plan.");
  writeFileSync(join(root, GLOSSARY_PATH), "x".repeat(20_000));
  expect(readGlossary(root)?.length).toBe(8_000);
  const linked = realpathSync.native(mkdtempSync(join(tmpdir(), "zx-glossary-")));
  writeFileSync(join(linked, "elsewhere.md"), "secret");
  symlinkSync(join(linked, "elsewhere.md"), join(linked, GLOSSARY_PATH));
  expect(readGlossary(linked)).toBeUndefined();
});
