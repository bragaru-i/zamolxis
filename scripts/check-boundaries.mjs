import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const rules = {
  "packages/domain/src": [
    /from ["']convex(?:\/|["'])/,
    /from ["']next(?:\/|["'])/,
    /from ["']node:child_process["']/,
    /from ["']@zamolxis\/runtime-/,
  ],
  "packages/application/src": [
    /from ["']next(?:\/|["'])/,
    /from ["']node:child_process["']/,
    /from ["']@zamolxis\/runtime-(?:codex|claude|hermes|local)/,
  ],
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

let failed = false;
for (const [dir, patterns] of Object.entries(rules)) {
  for (const file of await walk(dir)) {
    const source = await readFile(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        console.error(`Architecture boundary violation: ${file} matches ${pattern}`);
        failed = true;
      }
    }
  }
}
// Convex bundles these entry points for its own runtime, which has no Node built-ins
// (node:fs, node:child_process…): nothing they reach may import one. Node-only helpers get
// their own export path instead (e.g. @zamolxis/runtime-core/known-commits).
const convexEntries = ["packages/runtime-core/src/index.ts", "packages/contracts/src/index.ts"];
const seen = new Set();
async function reach(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return;
  }
  if (/from ["']node:/.test(source)) {
    console.error(`Convex-bundled module imports a Node built-in: ${file}`);
    failed = true;
  }
  for (const [, path] of source.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g)) {
    const base = join(dirname(file), path.replace(/\.js$/, ""));
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")])
      await reach(candidate);
  }
}
for (const entry of convexEntries) await reach(entry);
if (failed) process.exit(1);
console.log("Architecture boundaries OK");
