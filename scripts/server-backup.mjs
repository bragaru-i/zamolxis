#!/usr/bin/env node
// Daily backup of the production data on the owner's Mac (self-hosted Convex). Each run
// exports every table and file to ~/zamolxis-server/backups/zamolxis-<date>.zip, checks
// the archive, and keeps the newest KEEP of its own archives (other files, such as the
// 2026-10-19 cloud export, are never touched).
//   node scripts/server-backup.mjs              back up now
//   node scripts/server-backup.mjs --install    every day at 03:30 (launchd; a missed run
//                                               happens when the Mac wakes)
//   node scripts/server-backup.mjs --uninstall
// Restore: npx convex import --replace-all <archive> with the self-hosted env (runbook).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionEnv, serverDirectory } from "./lib/production-env.mjs";

const KEEP = 30;
const LABEL = "app.zamolxis.backup";
const backups = join(serverDirectory, "backups");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const ARCHIVE = /^zamolxis-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/;

const [option] = process.argv.slice(2);
if (option === "--install") install();
else if (option === "--uninstall") uninstall();
else if (option === undefined) backUp();
else {
  console.error("Usage: server-backup.mjs [--install | --uninstall]");
  process.exit(2);
}

function backUp() {
  const production = productionEnv();
  if (production.target !== "self-hosted") {
    production.clean();
    console.error(`No self-hosted server at ${serverDirectory}; nothing to back up.`);
    process.exit(1);
  }
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const archive = join(backups, `zamolxis-${stamp}.zip`);
  const npx = join(dirname(process.execPath), "npx");
  const result = spawnSync(
    npx,
    [
      "convex",
      "export",
      "--include-file-storage",
      "--path",
      archive,
      "--env-file",
      production.envFile,
    ],
    { cwd: repository, env: production.env, encoding: "utf8", maxBuffer: 1 << 26 },
  );
  production.clean();
  // The archive holds every record (owner data, sign-in tables): owner-only, like the server.
  if (existsSync(archive)) chmodSync(archive, 0o600);
  const listing = spawnSync("unzip", ["-l", archive], { encoding: "utf8" });
  const entries =
    listing.status === 0
      ? listing.stdout.split("\n").filter((line) => /documents\.jsonl$/.test(line)).length
      : 0;
  if (result.status !== 0 || entries === 0) {
    console.error(
      `${now.toISOString()} BACKUP_FAILED: ${production
        .hide(result.stderr || result.stdout || "no archive")
        .trim()
        .slice(-800)}`,
    );
    process.exit(1);
  }
  // Newest first by name (the date is in the name); remove only this script's own archives.
  const own = readdirSync(backups)
    .filter((name) => ARCHIVE.test(name))
    .sort()
    .reverse();
  for (const name of own.slice(KEEP)) rmSync(join(backups, name));
  const size = (statSync(archive).size / 1024).toFixed(0);
  console.log(
    `${now.toISOString()} backup ${archive} (${size} KB, ${entries} tables); keeping ${Math.min(own.length, KEEP)}`,
  );
}

/**
 * A node path that survives upgrades: the first `node` on PATH outside Homebrew's versioned
 * Cellar (e.g. /opt/homebrew/bin/node), else this process's own binary.
 */
function stableNode() {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, "node");
    if (directory && !directory.includes("/Cellar/") && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function install() {
  const node = stableNode();
  const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(fileURLToPath(import.meta.url))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repository)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>${xml(join(backups, "backup.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(backups, "backup.log"))}</string>
</dict>
</plist>
`,
  );
  spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
  if (loaded.status !== 0) {
    console.error(`launchctl bootstrap failed: ${loaded.stderr.trim()}`);
    process.exit(1);
  }
  console.log(`Daily backup at 03:30 installed (${plist}); log: ${join(backups, "backup.log")}`);
}

function uninstall() {
  spawnSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  rmSync(plist, { force: true });
  console.log("Daily backup removed.");
}
