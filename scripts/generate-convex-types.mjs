import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const vitePath = require.resolve("vite/package.json", {
  paths: [dirname(require.resolve("vitest/package.json"))],
});
const esbuild = createRequire(vitePath)("esbuild");
const convexRoot = dirname(require.resolve("convex/package.json"));
const templates = join(convexRoot, "src/cli/codegen_templates");
const scratch = mkdtempSync(join(tmpdir(), "zamolxis-codegen-"));
try {
  const generated = join(process.cwd(), "convex/_generated");
  mkdirSync(generated, { recursive: true });
  const entry = `export { serverCodegen } from ${JSON.stringify(join(templates, "server.ts"))};
    export { dynamicDataModelTS } from ${JSON.stringify(join(templates, "dataModel.ts"))};
    export { apiCodegen } from ${JSON.stringify(join(templates, "api.ts"))};`;
  const bundle = join(scratch, "templates.mjs");
  await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "offline-dynamic-schema",
        setup(build) {
          build.onLoad({ filter: /codegen_templates[/\\]dataModel\.ts$/ }, ({ path }) => {
            const source = readFileSync(path, "utf8");
            const start = source.indexOf("const dynamicDataModelContent =");
            const end = source.indexOf("async function staticDataModelImpl(");
            if (start < 0 || end < start)
              throw new Error("Unsupported installed Convex codegen template");
            return {
              contents: 'import { header } from "./common.js";\n' + source.slice(start, end),
              loader: "ts",
              resolveDir: dirname(path),
            };
          });
        },
      },
    ],
  });
  const generator = await import(pathToFileURL(bundle).href);
  const modules = readdirSync("convex").filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !["schema.ts", "auth.config.ts"].includes(name),
  );
  const server = generator.serverCodegen({ useTypeScript: true, envVars: undefined });
  const api = generator.apiCodegen(modules, { useTypeScript: true });
  writeFileSync(join(generated, "server.ts"), server.TS);
  writeFileSync(join(generated, "dataModel.ts"), generator.dynamicDataModelTS());
  writeFileSync(join(generated, "api.ts"), api.TS);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
