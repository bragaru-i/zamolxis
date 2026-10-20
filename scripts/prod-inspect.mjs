#!/usr/bin/env node
// Read-only production inspection, with keys that are never printed: recent table rows
// (`data`) or recent function logs (`logs`). Production is the self-hosted server on the
// owner's Mac when ~/zamolxis-server/admin.env exists, else the cloud deployment.
//   node scripts/prod-inspect.mjs data <table> [limit] [field,field,...]
//   node scripts/prod-inspect.mjs logs [historyLines] [seconds]
import { spawn, spawnSync } from "node:child_process";
import { productionEnv } from "./lib/production-env.mjs";

let production;
try {
  production = productionEnv();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { env, envFile, hide, clean } = production;
console.error(`Production: ${production.target}`);
const [command, ...rest] = process.argv.slice(2);

if (command === "data") {
  const [table, limit = "10", fields] = rest;
  if (!table || !/^[A-Za-z]+$/.test(table) || !/^\d{1,4}$/.test(limit)) {
    clean();
    console.error("Usage: prod-inspect.mjs data <table> [limit] [field,field,...]");
    process.exit(2);
  }
  const result = spawnSync(
    "npx",
    [
      "convex",
      "data",
      table,
      "--limit",
      limit,
      "--order",
      "desc",
      "--format",
      "jsonLines",
      "--env-file",
      envFile,
    ],
    { env, encoding: "utf8", maxBuffer: 1 << 26 },
  );
  clean();
  if (result.status !== 0) {
    console.error(hide(result.stderr || "convex data failed"));
    process.exit(1);
  }
  const now = Date.now();
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const picked = fields
      ? Object.fromEntries(fields.split(",").map((name) => [name, row[name]]))
      : row;
    // Timestamps become relative ages; emails are masked.
    for (const [name, value] of Object.entries(picked)) {
      if (typeof value === "number" && value > 1e12)
        picked[name] = `${Math.round((now - value) / 1000)}s ago`;
      if (typeof value === "string" && value.includes("@"))
        picked[name] = value.replace(/^(.).*@/, "$1***@");
    }
    console.log(JSON.stringify(picked));
  }
} else if (command === "logs") {
  const [history = "500", seconds = "20"] = rest;
  const child = spawn(
    "npx",
    ["convex", "logs", "--history", history, "--success", "--env-file", envFile],
    { env },
  );
  child.stdout.on("data", (chunk) => process.stdout.write(hide(String(chunk))));
  child.stderr.on("data", (chunk) => process.stderr.write(hide(String(chunk))));
  setTimeout(() => {
    child.kill("SIGINT");
    clean();
  }, Number(seconds) * 1000);
} else {
  clean();
  console.error("Usage: prod-inspect.mjs data <table> [limit] [fields] | logs [history] [seconds]");
  process.exit(2);
}
