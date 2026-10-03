import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const rules = {
  "packages/domain/src": [/from [\"']convex(?:\/|[\"'])/, /from [\"']next(?:\/|[\"'])/, /from [\"']node:child_process[\"']/, /from [\"']@zamolxis\/runtime-/],
  "packages/application/src": [/from [\"']next(?:\/|[\"'])/, /from [\"']node:child_process[\"']/, /from [\"']@zamolxis\/runtime-(?:codex|claude|hermes)/],
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
if (failed) process.exit(1);
console.log("Architecture boundaries OK");
