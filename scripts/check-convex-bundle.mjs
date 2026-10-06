// Bundles every Convex module the way Convex's default runtime needs it: no Node built-ins.
// A module that reaches node:* (directly or through a workspace package) passes typecheck
// and tests but fails `convex deploy`; this catches it before merge. Files that start with
// "use node" run in Convex's Node runtime and are skipped, as Convex does.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

const fromConvex = createRequire(
  realpathSync(createRequire(import.meta.url).resolve("convex/package.json")),
);
const esbuild = fromConvex("esbuild");
const entryPoints = readdirSync("convex")
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "auth.config.ts")
  .filter((name) => !readFileSync(`convex/${name}`, "utf8").startsWith('"use node"'))
  .map((name) => `convex/${name}`);
try {
  await esbuild.build({
    entryPoints,
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    mainFields: ["module", "main"],
    outdir: "convex-bundle-check",
    logLevel: "silent",
    external: ["convex", "convex/*", "@convex-dev/*", "@auth/*", "jose", "oauth4webapi"],
  });
  console.log(`Convex bundle OK (${entryPoints.length} modules)`);
} catch (error) {
  for (const problem of error.errors ?? [{ text: String(error) }])
    console.error(
      `Convex bundle: ${problem.text}${problem.location ? ` (${problem.location.file})` : ""}`,
    );
  process.exit(1);
}
