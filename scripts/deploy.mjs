#!/usr/bin/env node
// Production release: exact origin/main -> checks -> Convex -> web (Vercel) -> local Node restart.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  NODE_SERVICE_LABEL,
  deployedCommitMatches,
  gitProblem,
  nodeServiceRunsFrom,
  parseDeployArgs,
  vercelArgs,
} from "./lib/deploy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERCEL = ["dlx", "vercel@62"];
const usage = `Deploy production from the exact commit on origin/main.

  pnpm deploy:prod --directory /absolute/private/prod-directory [options]

The directory is the private prod directory from google-auth-setup (config.json,
credentials.json). ZAMOLXIS_PROD_SETUP_DIR can be set instead of --directory.

Options:
  --pull          fast-forward local main to origin/main first
  --yes           do not ask for confirmation
  --skip-check    skip pnpm check (lint, typecheck, tests, build)
  --skip-convex   do not deploy the Convex backend
  --skip-web      do not deploy the web app to Vercel
  --skip-node     do not restart the local Node service

Order: Convex first (the web app depends on new backend functions), then the web
app, then the Node service on this Mac.`;

const step = (text) => console.log(`\n▸ ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);
function fail(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}
function run(command, args, { capture = false, cwd = root, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim() };
}
const git = (...args) => run("git", args, { capture: true });

let options;
try {
  options = parseDeployArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(`\n${usage}`);
  process.exit(2);
}
if (options.help) {
  console.log(usage);
  process.exit(0);
}

// 1. Pre-flight: nothing in production changes until every check passes.
step("Checking Git state");
if (git("fetch", "--quiet", "origin", "main").status !== 0) fail("Could not fetch origin/main");
if (options.pull) {
  if (git("pull", "--ff-only", "--quiet", "origin", "main").status !== 0)
    fail("main cannot fast-forward to origin/main; resolve it manually");
}
const state = {
  branch: git("branch", "--show-current").stdout,
  head: git("rev-parse", "HEAD").stdout,
  remoteHead: git("rev-parse", "origin/main").stdout,
  dirty: git("status", "--porcelain", "--untracked-files=no").stdout.length > 0,
};
const problem = gitProblem(state);
if (problem) fail(problem);
const commit = state.head;
const subject = git("log", "-1", "--format=%s").stdout;
ok(`main at ${commit.slice(0, 7)} ${subject}`);

let appUrl = "";
if (options.convex || options.web) {
  step("Checking the private prod directory");
  if (!isAbsolute(options.directory)) fail("--directory must be an absolute path");
  const configPath = join(options.directory, "config.json");
  if (!existsSync(configPath)) fail(`${configPath} not found`);
  if (statSync(configPath).mode & 0o077) fail(`${configPath} must have mode 0600`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.environment !== "prod") fail(`${configPath} is for ${config.environment}, not prod`);
  appUrl = new URL(config.appUrl).origin;
  ok(`prod deployment ${config.deployment}, app ${appUrl}`);
}

if (options.web) {
  step("Checking Vercel login");
  if (!existsSync(join(root, ".vercel", "project.json")))
    fail(`This checkout is not linked to Vercel. Run: pnpm ${VERCEL.join(" ")} link`);
  if (run("pnpm", [...VERCEL, "whoami"], { capture: true }).status !== 0)
    fail(`Not logged in to Vercel. Run: pnpm ${VERCEL.join(" ")} login`);
  ok("Vercel CLI is logged in and the project is linked");
}

const plistPath = join(homedir(), "Library", "LaunchAgents", `${NODE_SERVICE_LABEL}.plist`);
let restartNode = false;
if (options.node) {
  step("Checking the Node service");
  if (!existsSync(plistPath)) console.log("  - Node service not installed; skipping restart");
  else if (!nodeServiceRunsFrom(readFileSync(plistPath, "utf8"), root))
    console.log("  - Node service runs from another checkout; skipping restart");
  else {
    restartNode = true;
    ok("Node service runs from this checkout");
  }
}

if (options.check) {
  step("Running pnpm check (lint, boundaries, typechecks, tests, build)");
  if (run("pnpm", ["check"]).status !== 0) fail("pnpm check failed; nothing was deployed");
  ok("All checks passed");
}

// 2. Confirm.
console.log(`\nAbout to release ${commit.slice(0, 7)} to production:`);
if (options.convex) console.log("  • Convex backend");
if (options.web) console.log(`  • Web app → ${appUrl}`);
if (restartNode) console.log("  • Restart the Node service on this Mac");
if (!options.yes) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("Continue? [y/N] ")).trim().toLowerCase();
  prompt.close();
  if (answer !== "y" && answer !== "yes") fail("Cancelled; nothing was deployed");
}

// 3. Release, backend first.
if (options.convex) {
  step("Deploying Convex backend");
  const result = run(process.execPath, [
    join(root, "scripts", "google-auth-setup.mjs"),
    "deploy",
    "--environment",
    "prod",
    "--directory",
    options.directory,
  ]);
  if (result.status !== 0) fail("Convex deploy failed; web and Node were not touched");
}

if (options.web) {
  step("Deploying web app to Vercel");
  if (run("pnpm", [...VERCEL, ...vercelArgs(commit)]).status !== 0)
    fail("Vercel deploy failed; Convex is already updated (it is backward compatible)");
  step(`Waiting for ${appUrl} to serve ${commit.slice(0, 7)}`);
  let live = false;
  for (let attempt = 0; attempt < 60 && !live; attempt++) {
    try {
      const response = await fetch(`${appUrl}/api/bootstrap`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      live = response.ok && deployedCommitMatches(await response.json(), commit);
    } catch {
      /* Retry until the alias points at the new deployment. */
    }
    if (!live) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!live) fail(`${appUrl} is not serving ${commit.slice(0, 7)} after 5 minutes`);
  ok(`${appUrl} serves ${commit.slice(0, 7)}`);
}

if (restartNode) {
  step("Restarting the Node service");
  const errorLog = join(homedir(), "Library", "Application Support", "Zamolxis", "node-error.log");
  const offset = existsSync(errorLog) ? statSync(errorLog).size : 0;
  const target = `gui/${process.getuid()}/${NODE_SERVICE_LABEL}`;
  if (run("launchctl", ["kickstart", "-k", target], { capture: true }).status !== 0)
    fail(`launchctl kickstart ${target} failed`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const status = run("launchctl", ["print", target], { capture: true }).stdout;
  if (!/state = running/.test(status)) fail("The Node service is not running after restart");
  const fresh = existsSync(errorLog)
    ? readFileSync(errorLog, "utf8").slice(offset).trim().split("\n").filter(Boolean)
    : [];
  if (fresh.length) {
    console.log("  ! New lines in node-error.log since restart:");
    for (const line of fresh.slice(-20)) console.log(`    ${line}`);
  }
  ok("Node service restarted and running");
}

console.log(`\n✓ Released ${commit.slice(0, 7)} ${subject}`);
