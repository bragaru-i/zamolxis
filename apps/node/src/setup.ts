import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { inspectRepository } from "@zamolxis/git";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import QRCode from "qrcode";
export interface NodeConfig {
  version: 1;
  appUrl: string;
  convexUrl: string;
  name: string;
  managedRoot: string;
  builderSlots: 3;
  verifierSlots: 1;
  repositories: Array<{ path: string; remoteUrl: string; name: string; repositoryId?: string }>;
  workstationId?: string;
  credential?: string;
  pendingPairing?: { pairingId: string; pollSecret: string; approvalCode: string };
}
export const configDirectory = () => join(homedir(), "Library", "Application Support", "Zamolxis");
export const configPath = () => join(configDirectory(), "config.json");
export function validateConfig(config: NodeConfig) {
  if (
    config.version !== 1 ||
    config.builderSlots !== 3 ||
    config.verifierSlots !== 1 ||
    !Array.isArray(config.repositories) ||
    config.repositories.length > 32 ||
    !isAbsolute(config.managedRoot)
  )
    throw new Error("INVALID_LOCAL_CONFIG");
  for (const url of [config.appUrl, config.convexUrl])
    if (new URL(url).protocol !== "https:") throw new Error("PUBLIC_HTTPS_CONTROL_PLANE_REQUIRED");
  for (const repository of config.repositories) {
    if (!isAbsolute(repository.path) || !repository.remoteUrl)
      throw new Error("INVALID_REPOSITORY_CONFIG");
    for (const [a, b] of [
      [repository.path, config.managedRoot],
      [config.managedRoot, repository.path],
    ] as const) {
      const suffix = relative(a, b);
      if (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix))
        throw new Error("MANAGED_ROOT_OVERLAPS_REPOSITORY");
    }
  }
}
export function saveConfig(config: NodeConfig, path = configPath()) {
  validateConfig(config);
  if (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink())
    throw new Error("UNSAFE_CONFIG_DIRECTORY");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (
    lstatSync(path, { throwIfNoEntry: false }) &&
    (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())
  )
    throw new Error("UNSAFE_CONFIG_FILE");
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
export function readConfig(path = configPath()): NodeConfig {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("CONFIG_PERMISSIONS_MUST_BE_PRIVATE");
  const config = JSON.parse(readFileSync(path, "utf8")) as NodeConfig;
  validateConfig(config);
  return config;
}
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function prerequisites() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Install Node.js >=22");
  console.log("✓ Node.js");
  for (const [tool, args] of [
    ["pnpm", ["--version"]],
    ["git", ["--version"]],
    ["codex", ["--version"]],
    ["codex", ["login", "status"]],
  ] as const) {
    try {
      execFileSync(tool, [...args], { stdio: "pipe", timeout: 10_000 });
    } catch {
      throw new Error(
        args[0] === "login"
          ? "Run codex login, then rerun setup"
          : `Install ${tool}, then rerun setup`,
      );
    }
    console.log(`✓ ${tool}${args[0] === "login" ? " authenticated" : ""}`);
  }
}
export function installService(path = configPath()) {
  if (process.platform !== "darwin") throw new Error("MAC_SERVICE_REQUIRES_DARWIN");
  const directory = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true });
  const label = "app.zamolxis.node";
  const servicePath = join(directory, `${label}.plist`);
  const xml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const args = [
    process.execPath,
    fileURLToPath(import.meta.resolve("tsx/cli")),
    fileURLToPath(new URL("./daemon.ts", import.meta.url)),
    "--config",
    path,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${xml(join(configDirectory(), "node.log"))}</string><key>StandardErrorPath</key><string>${xml(join(configDirectory(), "node-error.log"))}</string></dict></plist>`;
  const domain = `gui/${process.getuid?.()}`;
  let installed = false;
  try {
    execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "pipe" });
    installed = true;
  } catch {
    /* First install. */
  }
  if (existsSync(servicePath) && lstatSync(servicePath).isSymbolicLink())
    throw new Error("UNSAFE_SERVICE_FILE");
  if (installed && existsSync(servicePath) && readFileSync(servicePath, "utf8") === plist) return;
  if (installed) execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "pipe" });
  writeFileSync(servicePath, plist, { mode: 0o600 });
  execFileSync("launchctl", ["bootstrap", domain, servicePath], { stdio: "pipe" });
}
export async function setup() {
  prerequisites();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let config: NodeConfig;
    if (existsSync(configPath())) config = readConfig();
    else {
      const appUrl = new URL((await terminal.question("Zamolxis public app URL: ")).trim()).origin;
      if (new URL(appUrl).protocol !== "https:")
        throw new Error("PUBLIC_HTTPS_CONTROL_PLANE_REQUIRED");
      const response = await fetch(`${appUrl}/api/bootstrap`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Public control plane unavailable");
      const bootstrap = (await response.json()) as { version: number; convexUrl: string; appUrl: string };
      if (bootstrap.version !== 1) throw new Error("UNSUPPORTED_CONTROL_PLANE_VERSION");
      if (new URL(bootstrap.appUrl).origin !== appUrl)
        throw new Error("CANONICAL_APP_URL_MISMATCH");
      const name =
        (await terminal.question(`Name this Mac [${hostname()}]: `)).trim() || hostname();
      const candidates = new Set([process.cwd()]);
      try {
        candidates.add(
          execFileSync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf8",
            stdio: "pipe",
          }).trim(),
        );
      } catch {
        /* Not launched inside a Git checkout. */
      }
      for (const root of [join(homedir(), "Projects"), join(homedir(), "Developer")]) {
        if (!existsSync(root)) continue;
        for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 100))
          if (entry.isDirectory() && !entry.isSymbolicLink())
            candidates.add(join(root, entry.name));
      }
      const found = [...candidates].filter((path) => existsSync(join(path, ".git")));
      found.forEach((path, index) => {
        console.log(`${index + 1}. ${path}`);
      });
      const selection = (
        await terminal.question("Repository numbers (comma separated) or absolute path: ")
      ).trim();
      const paths = isAbsolute(selection)
        ? [selection]
        : selection.split(",").map((n) => found[Number(n.trim()) - 1]);
      if (!paths.length || paths.some((path) => !path)) throw new Error("Select a Git repository");
      const repositories = [...new Set(paths)].map((path) => {
        const snapshot = inspectRepository(realpathSync(path!));
        const remoteUrl = execFileSync(
          "git",
          ["-C", snapshot.path, "remote", "get-url", "origin"],
          { encoding: "utf8", stdio: "pipe" },
        ).trim();
        return { path: snapshot.path, remoteUrl, name: basename(snapshot.path) };
      });
      const managedRoot =
        (
          await terminal.question(`Managed root [${join(configDirectory(), "worktrees")}]: `)
        ).trim() || join(configDirectory(), "worktrees");
      config = {
        version: 1,
        appUrl,
        convexUrl: bootstrap.convexUrl,
        name,
        repositories,
        managedRoot,
        builderSlots: 3,
        verifierSlots: 1,
      };
      validateConfig(config);
      mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
      config.managedRoot = realpathSync(managedRoot);
      saveConfig(config);
    }
    const client = new ConvexHttpClient(config.convexUrl);
    if (!config.workstationId) {
      if (!config.pendingPairing) {
        const approvalCode = randomBytes(32).toString("hex");
        const pollSecret = randomBytes(32).toString("hex");
        const pairingId = await client.mutation(
          makeFunctionReference<"mutation">("pairing:begin"),
          { approvalCode, pollSecret, name: config.name },
        );
        config.pendingPairing = { pairingId: String(pairingId), pollSecret, approvalCode };
        saveConfig(config);
      }
      const pending = config.pendingPairing;
      const url = `${config.appUrl}/?pair=${pending.approvalCode}`;
      console.log("Scan with iPhone, sign in and approve this Mac:");
      console.log(await QRCode.toString(url, { type: "terminal", small: true }));
      console.log(url);
      for (;;) {
        const state = (await client.query(makeFunctionReference<"query">("pairing:poll"), {
          pairingId: pending.pairingId,
          pollSecret: pending.pollSecret,
        })) as { status: string };
        if (state.status === "expired") {
          delete config.pendingPairing;
          delete config.credential;
          saveConfig(config);
          throw new Error("Pairing expired; rerun setup for a new QR");
        }
        if (["approved", "consumed"].includes(state.status)) break;
        await pause(1500);
      }
      config.credential ??= randomBytes(32).toString("hex");
      saveConfig(config);
      const enrolled = (await client.action(
        makeFunctionReference<"action">("deviceTokens:enroll"),
        {
          pairingId: pending.pairingId,
          pollSecret: pending.pollSecret,
          credential: config.credential,
        },
      )) as { workstationId: string };
      config.workstationId = enrolled.workstationId;
      delete config.pendingPairing;
      saveConfig(config);
    }
    const auth = (await client.action(makeFunctionReference<"action">("deviceTokens:refresh"), {
      credential: config.credential,
    })) as { token: string; workstationId: string };
    if (auth.workstationId !== config.workstationId) throw new Error("DEVICE_IDENTITY_MISMATCH");
    client.setAuth(auth.token);
    const registered = (await client.mutation(
      makeFunctionReference<"mutation">("onboarding:registerRepositories"),
      {
        workstationId: config.workstationId,
        repositories: config.repositories.map(({ name, remoteUrl }) => ({ name, remoteUrl })),
      },
    )) as Array<{ repositoryId: string; remoteUrl: string }>;
    config.repositories = config.repositories.map((repository) => ({
      ...repository,
      repositoryId: registered.find((row) => row.remoteUrl === repository.remoteUrl)!.repositoryId,
    }));
    saveConfig(config);
    installService();
    console.log("✓ Paired; products configured; persistent Node service installed");
    for (let attempt = 0; attempt < 20; attempt++) {
      const health = (await client.query(makeFunctionReference<"query">("node:health"), {
        workstationId: config.workstationId,
      })) as { online: boolean; runtimeAvailable: boolean };
      if (health.online && health.runtimeAvailable) {
        console.log(
          `✓ Node online; Codex available; 3 builders + 1 verifier\nOpen ${config.appUrl} on iPhone`,
        );
        return;
      }
      await pause(1500);
    }
    throw new Error("Heartbeat/runtime check failed; inspect node-error.log and rerun setup");
  } finally {
    terminal.close();
  }
}
