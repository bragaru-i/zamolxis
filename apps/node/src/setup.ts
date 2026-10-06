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
import { fileURLToPath } from "node:url";
import { checkbox, confirm, input, password, select } from "@inquirer/prompts";
import { inspectRepository, remoteIdentity } from "@zamolxis/git";
import {
  type GitHubAccess,
  type GitHubClient,
  KeychainRepositoryTokenStore,
  type RepositoryTokenStore,
  RestGitHubClient,
} from "@zamolxis/node-core";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import QRCode from "qrcode";
import { claudeSignedIn, findClaude } from "./claude";
import {
  type CredentialStore,
  isDeviceCredential,
  KeychainCredentialStore,
  loadDeviceCredential,
  pairingAccount,
} from "./credential-store";
import { type GitHubTokenEnvironment, manageGitHubTokens, openInBrowser } from "./github-token";
export interface NodeConfig {
  version: 1;
  appUrl: string;
  convexUrl: string;
  name: string;
  managedRoot: string;
  builderSlots: 3;
  verifierSlots: 1;
  repositories: RepositoryConfig[];
  workstationId?: string;
  credential?: string;
  pendingPairing?: { pairingId: string; pollSecret: string; approvalCode: string };
}
export interface PublishingIdentity {
  provider: "github";
  host: string;
  login: string;
}
export interface RepositoryConfig {
  path: string;
  remoteUrl: string;
  name: string;
  repositoryId?: string;
  publishingIdentity?: PublishingIdentity;
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
    if (
      repository.publishingIdentity &&
      (repository.publishingIdentity.provider !== "github" ||
        !/^[A-Za-z0-9.-]{1,253}$/.test(repository.publishingIdentity.host) ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(repository.publishingIdentity.login))
    )
      throw new Error("INVALID_PUBLISHING_IDENTITY");
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
  // Optional second runtime: the owner's Claude Code login (subscription), never an API key.
  const claude = findClaude();
  if (claude && claudeSignedIn(claude.executable))
    console.log(`✓ Claude Code ${claude.version} (optional runtime)`);
  else
    console.log(
      claude
        ? "– Claude Code is installed but not signed in with a Claude subscription (optional: run claude, then /login)"
        : "– Claude Code not found (optional runtime)",
    );
}
export type AppAddress =
  | { origin: string }
  | { candidates: Array<{ origin: string; problem?: string }> };
export function parseAppAddress(value: string): AppAddress {
  const trimmed = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") throw new Error("PUBLIC_HTTPS_CONTROL_PLANE_REQUIRED");
    return { origin: url.origin };
  }
  // Without a protocol the user chooses one; nothing is assumed silently.
  const host = new URL(`https://${trimmed}`).host;
  if (!trimmed || /[/?#\s]/.test(trimmed.replace(/\/+$/, "")))
    throw new Error("INVALID_APP_ADDRESS");
  return {
    candidates: [
      { origin: `https://${host}` },
      { origin: `http://${host}`, problem: "Zamolxis requires HTTPS" },
    ],
  };
}
export interface RepositoryChoice {
  path: string;
  remoteUrl?: string;
  problem?: string;
}
export function inspectRepositoryChoice(path: string): RepositoryChoice {
  try {
    const snapshot = inspectRepository(realpathSync.native(path));
    const remoteUrl = execFileSync("git", ["-C", snapshot.path, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return { path: snapshot.path, remoteUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      path,
      problem: message.includes("ROOT_REQUIRED")
        ? "not a repository root"
        : message.includes("HEAD^{commit}")
          ? "no commits yet"
          : message.includes("get-url origin")
            ? "no origin remote"
            : message.includes("UNSUPPORTED_REMOTE")
              ? "unsupported origin remote"
              : "not a readable Git repository",
    };
  }
}
export function discoverRepositories(candidates: Iterable<string>) {
  const choices = new Map<string, RepositoryChoice>();
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, ".git"))) continue;
    const choice = inspectRepositoryChoice(candidate);
    if (!choices.has(choice.path)) choices.set(choice.path, choice);
  }
  return [...choices.values()];
}

// ---------------------------------------------------------------------------
// launchd service
// ---------------------------------------------------------------------------
export const SERVICE_LABEL = "app.zamolxis.node";
export const servicePlistPath = () =>
  join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
/** The daemon of this checkout; the service must run exactly this file. */
export const daemonPath = () => fileURLToPath(new URL("./daemon.ts", import.meta.url));
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const unxml = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
export function servicePlist(
  path = configPath(),
  runtime = {
    node: process.execPath,
    tsx: fileURLToPath(import.meta.resolve("tsx/cli")),
    daemon: daemonPath(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    logDirectory: configDirectory(),
  },
) {
  const args = [runtime.node, runtime.tsx, runtime.daemon, "--config", path];
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${SERVICE_LABEL}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtime.PATH)}</string></dict><key>StandardOutPath</key><string>${xml(join(runtime.logDirectory, "node.log"))}</string><key>StandardErrorPath</key><string>${xml(join(runtime.logDirectory, "node-error.log"))}</string></dict></plist>`;
}
export type ServicePlistState =
  | { status: "missing" }
  | { status: "current" }
  | { status: "other-checkout"; daemon: string }
  | { status: "outdated" };
/** Compares the installed plist with the one this checkout would install. */
export function inspectServicePlist(
  actual: string | undefined,
  expected: string,
  expectedDaemon = daemonPath(),
): ServicePlistState {
  if (actual === undefined) return { status: "missing" };
  if (actual === expected) return { status: "current" };
  const daemon = [...actual.matchAll(/<string>([^<]*)<\/string>/g)]
    .map((match) => unxml(match[1] ?? ""))
    .find((value) => value.endsWith("daemon.ts"));
  return daemon && daemon !== expectedDaemon
    ? { status: "other-checkout", daemon }
    : { status: "outdated" };
}
export interface ServiceManager {
  inspect(): { plist: ServicePlistState; loaded: boolean };
  /** Writes the plist and (re)loads the service; launchd starts it immediately. */
  install(): void;
  /** Restarts the running service so it rereads config and credential. */
  restart(): void;
  pid(): number | undefined;
}
export function launchdService(path = configPath()): ServiceManager {
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const plistPath = servicePlistPath();
  const requireMac = () => {
    if (process.platform !== "darwin") throw new Error("MAC_SERVICE_REQUIRES_DARWIN");
  };
  const print = () => {
    try {
      return execFileSync("launchctl", ["print", target], { encoding: "utf8", stdio: "pipe" });
    } catch {
      return undefined;
    }
  };
  const readPlist = () => {
    const stat = lstatSync(plistPath, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("UNSAFE_SERVICE_FILE");
    return readFileSync(plistPath, "utf8");
  };
  return {
    inspect() {
      requireMac();
      return {
        plist: inspectServicePlist(readPlist(), servicePlist(path)),
        loaded: print() !== undefined,
      };
    },
    install() {
      requireMac();
      mkdirSync(dirname(plistPath), { recursive: true });
      readPlist();
      if (print() !== undefined) execFileSync("launchctl", ["bootout", target], { stdio: "pipe" });
      writeFileSync(plistPath, servicePlist(path), { mode: 0o600 });
      reloadService({
        loaded: () => print() !== undefined,
        bootstrap: () =>
          execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "pipe" }),
        sleep: sleepSync,
      });
    },
    restart() {
      requireMac();
      execFileSync("launchctl", ["kickstart", "-k", target], { stdio: "pipe" });
    },
    pid() {
      const match = print()?.match(/\bpid = (\d+)/);
      return match ? Number(match[1]) : undefined;
    },
  };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// launchd unloads asynchronously after `bootout`; bootstrapping before it finishes fails
// with "Input/output error" (5) and leaves the Node unloaded. Wait for the unload, then
// retry the bootstrap briefly.
export function reloadService(launchd: {
  loaded(): boolean;
  bootstrap(): void;
  sleep(ms: number): void;
}) {
  for (let waited = 0; launchd.loaded() && waited < 10_000; waited += 250) launchd.sleep(250);
  for (let attempt = 1; ; attempt++) {
    try {
      launchd.bootstrap();
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      launchd.sleep(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Control plane and prompts (injected so the flows are testable)
// ---------------------------------------------------------------------------
export interface ControlPlane {
  beginPairing(args: { approvalCode: string; pollSecret: string; name: string }): Promise<string>;
  pollPairing(args: { pairingId: string; pollSecret: string }): Promise<{ status: string }>;
  enroll(args: {
    pairingId: string;
    pollSecret: string;
    credential: string;
  }): Promise<{ workstationId: string }>;
  refresh(credential: string): Promise<{ token: string; workstationId: string }>;
  setAuth(token: string): void;
  registerRepositories(
    workstationId: string,
    repositories: Array<{ name: string; remoteUrl: string }>,
    options?: { reactivate?: boolean },
  ): Promise<Array<{ repositoryId: string; remoteUrl: string }>>;
  health(workstationId: string): Promise<NodeHealth>;
  renameSelf(workstationId: string, name: string): Promise<void>;
  /** Stops new work for this Mac in one repository; "absent" if it was never registered. */
  removeOwnLocation(workstationId: string, repositoryId: string): Promise<"removed" | "absent">;
  /** Called with the previous entry's token: revokes it in favour of `replacementId`. */
  retireReplaced(workstationId: string, replacementId: string): Promise<void>;
  /** Reports a repository's GitHub publishing access on this Mac (never the token). */
  reportGithubAccess?(
    workstationId: string,
    repositoryId: string,
    access: GitHubAccess,
  ): Promise<void>;
}
export interface NodeHealth {
  online: boolean;
  runtimeAvailable: boolean;
  /** Absent on control planes older than the exact heartbeat check. */
  lastHeartbeatAt?: number | null;
  instanceId?: string | null;
}
export function convexControlPlane(convexUrl: string): ControlPlane {
  const client = new ConvexHttpClient(convexUrl);
  return {
    beginPairing: async (args) =>
      String(await client.mutation(makeFunctionReference<"mutation">("pairing:begin"), args)),
    pollPairing: async (args) =>
      (await client.query(makeFunctionReference<"query">("pairing:poll"), args)) as {
        status: string;
      },
    enroll: async (args) =>
      (await client.action(makeFunctionReference<"action">("deviceTokens:enroll"), args)) as {
        workstationId: string;
      },
    refresh: async (credential) =>
      (await client.action(makeFunctionReference<"action">("deviceTokens:refresh"), {
        credential,
      })) as { token: string; workstationId: string },
    setAuth: (token) => client.setAuth(token),
    registerRepositories: async (workstationId, repositories, options) =>
      (await client.mutation(makeFunctionReference<"mutation">("onboarding:registerRepositories"), {
        workstationId,
        repositories,
        ...(options?.reactivate ? { reactivate: true } : {}),
      })) as Array<{ repositoryId: string; remoteUrl: string }>,
    health: async (workstationId) =>
      (await client.query(makeFunctionReference<"query">("node:health"), {
        workstationId,
      })) as NodeHealth,
    renameSelf: async (workstationId, name) => {
      await client.mutation(makeFunctionReference<"mutation">("workstations:renameSelf"), {
        workstationId,
        name,
      });
    },
    removeOwnLocation: async (workstationId, repositoryId) =>
      (await client.mutation(makeFunctionReference<"mutation">("repositories:removeOwnLocation"), {
        workstationId,
        repositoryId,
      })) as "removed" | "absent",
    retireReplaced: async (workstationId, replacementId) => {
      await client.mutation(makeFunctionReference<"mutation">("workstations:retireReplaced"), {
        workstationId,
        replacementId,
      });
    },
    reportGithubAccess: async (workstationId, repositoryId, access) => {
      await client.mutation(makeFunctionReference<"mutation">("node:reportGithubAccess"), {
        workstationId,
        repositoryId,
        access,
      });
    },
  };
}
export interface Choice<T extends string> {
  name: string;
  value: T;
  disabled?: boolean | string;
  description?: string;
}
export interface SetupIo {
  log(message: string): void;
  qr(url: string): Promise<void>;
  select<T extends string>(message: string, choices: Choice<T>[], defaultValue?: T): Promise<T>;
  checkbox(
    message: string,
    choices: Array<Choice<string> & { checked?: boolean }>,
    validate?: (selected: readonly string[]) => true | string,
  ): Promise<string[]>;
  input(
    message: string,
    options?: { default?: string; validate?: (value: string) => true | string },
  ): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  /** Reads a secret without echoing it; absent where nothing secret can be asked. */
  password?(message: string): Promise<string>;
}
export const terminalIo: SetupIo = {
  log: (message) => console.log(message),
  qr: async (url) => console.log(await QRCode.toString(url, { type: "terminal", small: true })),
  select: (message, choices, defaultValue) =>
    select({ message, choices, ...(defaultValue ? { default: defaultValue } : {}) }),
  checkbox: (message, choices, validate) =>
    checkbox<string>({
      message,
      choices,
      ...(validate ? { validate: (selected) => validate(selected.map(({ value }) => value)) } : {}),
    }),
  input: (message, options) => input({ message, ...options }),
  confirm: (message, defaultValue) => confirm({ message, default: defaultValue }),
  // No mask: nothing is echoed while the token is pasted.
  password: (message) => password({ message }),
};
export interface SetupEnvironment {
  io: SetupIo;
  store: CredentialStore;
  connect(convexUrl: string): ControlPlane;
  service: ServiceManager;
  configPath: string;
  pause(ms: number): Promise<unknown>;
  /** Repository roots offered in the checklist. */
  discover(): RepositoryChoice[];
  inspectRepository(path: string): RepositoryChoice;
  githubAccounts(host: string): string[];
  verifyGithubAccount(host: string, login: string, owner: string, repo: string): boolean;
  secret(): string;
  /** Per-repository GitHub publishing tokens; absent where setup must not touch them. */
  github?: GitHubSetup;
}
export interface GitHubSetup {
  tokens: RepositoryTokenStore;
  client: Pick<GitHubClient, "checkAccess">;
  openUrl(url: string): void;
}
interface GhAuthStatus {
  hosts?: Record<string, Array<{ login?: string; state?: string }>>;
}
export function authenticatedGithubAccounts(host: string): string[] {
  try {
    const status = JSON.parse(
      execFileSync("gh", ["auth", "status", "--hostname", host, "--json", "hosts"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }),
    ) as GhAuthStatus;
    return [
      ...new Set(
        (status.hosts?.[host] ?? [])
          .filter(({ login, state }) => login && state === "logged_in")
          .map(({ login }) => login as string),
      ),
    ];
  } catch {
    return [];
  }
}
export function verifyGithubAccount(
  host: string,
  login: string,
  owner: string,
  repo: string,
): boolean {
  try {
    const token = execFileSync("gh", ["auth", "token", "--hostname", host, "--user", login], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    const env = { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
    const actual = execFileSync("gh", ["api", "--hostname", host, "user", "--jq", ".login"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
    if (actual !== login) return false;
    return (
      execFileSync(
        "gh",
        ["api", "--hostname", host, `repos/${owner}/${repo}`, "--jq", ".permissions.push"],
        { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
      ).trim() === "true"
    );
  } catch {
    return false;
  }
}
export function repositoryCandidates() {
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
      if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.add(join(root, entry.name));
  }
  return candidates;
}
export function defaultEnvironment(): SetupEnvironment {
  const path = configPath();
  return {
    io: terminalIo,
    store: new KeychainCredentialStore(),
    connect: convexControlPlane,
    service: launchdService(path),
    configPath: path,
    pause,
    discover: () => discoverRepositories(repositoryCandidates()),
    inspectRepository: inspectRepositoryChoice,
    githubAccounts: authenticatedGithubAccounts,
    verifyGithubAccount,
    secret: () => randomBytes(32).toString("hex"),
    github: {
      tokens: new KeychainRepositoryTokenStore(),
      client: new RestGitHubClient(),
      openUrl: openInBrowser,
    },
  };
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------
/**
 * Moves a plaintext credential from config.json into the credential store. The
 * secret is removed from config.json only after it reads back from the store.
 */
export function migratePlaintextCredential(
  config: NodeConfig,
  store: CredentialStore,
  save: (config: NodeConfig) => void,
): boolean {
  const secret = config.credential;
  if (secret === undefined) return false;
  const account = config.workstationId
    ? config.workstationId
    : config.pendingPairing
      ? pairingAccount(config.pendingPairing.pairingId)
      : undefined;
  if (account && isDeviceCredential(secret)) {
    store.write(account, secret);
    if (store.read(account) !== secret) throw new Error("KEYCHAIN_VERIFY_FAILED");
  }
  // A malformed or orphaned value is useless; dropping it leads to pairing again.
  delete config.credential;
  save(config);
  return true;
}
export type CredentialProblem = "missing" | "rejected" | "access-denied";
const errorCode = (error: unknown) =>
  (error as { data?: { code?: unknown } } | undefined)?.data?.code;
/** Maps a refresh failure to something the owner can act on; other errors stay errors. */
export function classifyCredentialError(error: unknown): CredentialProblem | undefined {
  const code = errorCode(error);
  if (code === "FORBIDDEN" || code === "NOT_FOUND") return "rejected";
  if (code === "ACCESS_DENIED") return "access-denied";
  return undefined;
}
const PROBLEM_MESSAGE: Record<CredentialProblem, string> = {
  missing: "No device credential for this Mac was found in the login Keychain.",
  rejected:
    "Zamolxis no longer accepts this Mac's device credential: the Mac was removed or revoked in Settings, or the credential belongs to an older pairing.",
  "access-denied":
    "Your Zamolxis account does not have access (pending or blocked). Ask the operator to allow it, then run pnpm zamolxis setup --repair.",
};

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------
const OTHER_PATH = "\0other";
const EDIT_ADDRESS = "\0edit";
async function promptAppUrl(io: SetupIo) {
  for (;;) {
    const parsed = parseAppAddress(
      await io.input("Zamolxis app address", {
        validate: (value) => {
          try {
            parseAppAddress(value);
            return true;
          } catch (error) {
            return error instanceof Error && error.message.includes("HTTPS")
              ? "Zamolxis requires HTTPS"
              : "Enter a host such as zamolxis.example.com";
          }
        },
      }),
    );
    if ("origin" in parsed) return parsed.origin;
    const choice = await io.select<string>("Which protocol?", [
      ...parsed.candidates.map(({ origin, problem }) => ({
        name: origin,
        value: origin,
        ...(problem ? { disabled: problem } : {}),
      })),
      { name: "Edit address", value: EDIT_ADDRESS },
    ]);
    if (choice !== EDIT_ADDRESS) return choice;
  }
}
/** Repository checklist: current grants are checked; existing entries are kept as they are. */
export async function chooseRepositories(
  env: SetupEnvironment,
  current: NodeConfig["repositories"],
): Promise<NodeConfig["repositories"]> {
  const currentPaths = new Set(current.map(({ path }) => path));
  const selected = await env.io.checkbox(
    "Repositories this Mac may work on",
    [
      ...current.map(({ path }) => ({ name: path, value: path, checked: true })),
      ...env
        .discover()
        .filter((choice) => !currentPaths.has(choice.path))
        .map((choice) => ({
          name: choice.path,
          value: choice.path,
          ...(choice.problem ? { disabled: choice.problem } : {}),
        })),
      { name: "Another repository path…", value: OTHER_PATH },
    ],
    (choices) => choices.length > 0 || "Select at least one repository",
  );
  const chosen = selected
    .filter((path) => path !== OTHER_PATH && !currentPaths.has(path))
    .map((path) => env.inspectRepository(path));
  if (selected.includes(OTHER_PATH)) {
    const other = await env.io.input("Absolute repository paths (comma separated)", {
      validate: (value) => {
        const paths = value
          .split(",")
          .map((path) => path.trim())
          .filter(Boolean);
        if (!paths.length) return "Enter at least one path";
        for (const path of paths) {
          if (!isAbsolute(path)) return `${path}: use an absolute path`;
          if (!existsSync(path)) return `${path}: does not exist`;
          const { problem } = env.inspectRepository(path);
          if (problem) return `${path}: ${problem}`;
        }
        return true;
      },
    });
    chosen.push(
      ...other
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => env.inspectRepository(path)),
    );
  }
  const kept = current.filter(({ path }) => selected.includes(path));
  const added: RepositoryConfig[] = [
    ...new Map(chosen.map((choice) => [choice.path, choice])).values(),
  ]
    .filter(({ path }) => !kept.some((repository) => repository.path === path))
    .map(({ path, remoteUrl, problem }) => {
      if (problem || !remoteUrl) throw new Error(`${path}: ${problem ?? "no origin remote"}`);
      return { path, remoteUrl, name: basename(path) };
    });
  const repositories = [...kept, ...added];
  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index];
    if (!repository) continue;
    let identity: string;
    try {
      identity = remoteIdentity(repository.remoteUrl);
    } catch {
      continue;
    }
    const [host, owner, repo, ...rest] = identity.split("/");
    if (host !== "github.com" || !owner || !repo || rest.length) continue;
    const accounts = env.githubAccounts(host);
    if (!accounts.length)
      throw new Error(`GITHUB_AUTH_REQUIRED: run gh auth login for ${host}, then rerun setup`);
    const preferred = repository.publishingIdentity?.login ?? owner;
    const login = await env.io.select(
      `GitHub account for publishing ${owner}/${repo}`,
      accounts.map((account) => ({ name: account, value: account })),
      accounts.includes(preferred) ? preferred : accounts[0],
    );
    if (!env.verifyGithubAccount(host, login, owner, repo))
      throw new Error(`GITHUB_PUSH_ACCESS_REQUIRED: ${login} cannot push ${owner}/${repo}`);
    repositories[index] = {
      ...repository,
      publishingIdentity: { provider: "github", host, login },
    };
    env.io.log(`✓ ${owner}/${repo} pull requests will be published as ${login}`);
  }
  return repositories;
}
async function firstRun(env: SetupEnvironment): Promise<NodeConfig> {
  const { io } = env;
  const appUrl = await promptAppUrl(io);
  const response = await fetch(`${appUrl}/api/bootstrap`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Public control plane unavailable");
  const bootstrap = (await response.json()) as {
    version: number;
    convexUrl: string;
    appUrl: string;
  };
  if (bootstrap.version !== 1) throw new Error("UNSUPPORTED_CONTROL_PLANE_VERSION");
  if (new URL(bootstrap.appUrl).origin !== appUrl) throw new Error("CANONICAL_APP_URL_MISMATCH");
  const name = (await io.input("Name this Mac", { default: hostname() })).trim() || hostname();
  const repositories = await chooseRepositories(env, []);
  const managedRoot = (
    await io.input("Managed root", { default: join(configDirectory(), "worktrees") })
  ).trim();
  const config: NodeConfig = {
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
  config.managedRoot = realpathSync.native(managedRoot);
  saveConfig(config, env.configPath);
  return config;
}
async function pairDevice(config: NodeConfig, env: SetupEnvironment, client: ControlPlane) {
  const save = () => saveConfig(config, env.configPath);
  if (!config.pendingPairing) {
    const approvalCode = env.secret();
    const pollSecret = env.secret();
    const pairingId = await client.beginPairing({ approvalCode, pollSecret, name: config.name });
    config.pendingPairing = { pairingId, pollSecret, approvalCode };
    save();
  }
  const pending = config.pendingPairing;
  const holding = pairingAccount(pending.pairingId);
  // The QR carries only the single-use approval code, never poll or device secrets.
  const url = `${config.appUrl}/?pair=${pending.approvalCode}`;
  env.io.log("Scan with iPhone, sign in and approve this Mac:");
  await env.io.qr(url);
  env.io.log(url);
  for (;;) {
    const state = await client.pollPairing({
      pairingId: pending.pairingId,
      pollSecret: pending.pollSecret,
    });
    if (state.status === "expired") {
      env.store.remove(holding);
      delete config.pendingPairing;
      save();
      throw new Error("Pairing expired; rerun setup for a new QR");
    }
    if (["approved", "consumed"].includes(state.status)) break;
    await env.pause(1500);
  }
  // Kept under a pairing account until enrollment returns the workstation id, so an
  // interrupted setup resumes with the same credential.
  let credential = env.store.read(holding);
  if (!credential) {
    credential = env.secret();
    env.store.write(holding, credential);
  }
  const enrolled = await client.enroll({
    pairingId: pending.pairingId,
    pollSecret: pending.pollSecret,
    credential,
  });
  env.store.write(enrolled.workstationId, credential);
  env.store.remove(holding);
  config.workstationId = enrolled.workstationId;
  delete config.pendingPairing;
  delete config.credential;
  save();
  env.io.log("✓ Paired; device credential saved in the login Keychain");
}
/** Forgets this Mac's pairing locally so the next step pairs it again. */
export function forgetPairing(config: NodeConfig, env: SetupEnvironment) {
  if (config.workstationId) env.store.remove(config.workstationId);
  if (config.pendingPairing) env.store.remove(pairingAccount(config.pendingPairing.pairingId));
  delete config.workstationId;
  delete config.credential;
  delete config.pendingPairing;
  saveConfig(config, env.configPath);
}
async function authenticate(
  config: NodeConfig,
  env: SetupEnvironment,
  client: ControlPlane,
): Promise<CredentialProblem | undefined> {
  let credential: string;
  try {
    credential = loadDeviceCredential(config, env.store);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DEVICE_CREDENTIAL_MISSING"))
      return "missing";
    throw error;
  }
  let auth: { token: string; workstationId: string };
  try {
    auth = await client.refresh(credential);
  } catch (error) {
    const problem = classifyCredentialError(error);
    if (problem) return problem;
    throw error;
  }
  if (auth.workstationId !== config.workstationId) throw new Error("DEVICE_IDENTITY_MISMATCH");
  client.setAuth(auth.token);
  return undefined;
}
async function confirmServiceStable(env: SetupEnvironment, previousPid: number | undefined) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await env.pause(2000);
    const pid = env.service.pid();
    if (pid && pid !== previousPid) {
      // The daemon reads the credential and sends a heartbeat at start; it exits if either fails.
      await env.pause(8000);
      if (env.service.pid() === pid) return;
    }
  }
  throw new Error(
    "The Node service stops right after it starts. See ~/Library/Application Support/Zamolxis/node-error.log (a locked login Keychain or a rejected credential are the usual causes), then rerun pnpm zamolxis setup --repair",
  );
}
/** The entry this Mac had before pairing again, and its credential if still at hand. */
export interface PreviousPairing {
  workstationId: string;
  credential?: string;
}
/** Captures the current pairing before it is forgotten, so it can be retired afterwards. */
export function previousPairing(
  config: NodeConfig,
  store: CredentialStore,
): PreviousPairing | undefined {
  if (!config.workstationId) return undefined;
  const stored = store.read(config.workstationId) ?? config.credential;
  return {
    workstationId: config.workstationId,
    ...(isDeviceCredential(stored) ? { credential: stored } : {}),
  };
}
const RETIRE_FALLBACK =
  "The previous entry for this Mac was left as it is: its credential is no longer accepted, so setup cannot prove it belongs to this Mac. If it is still listed in Settings → Macs, remove it there.";
/**
 * Revokes the entry this Mac had before pairing again. Only the previous entry's own
 * credential can do that; without it the entry is left alone and the owner is told.
 */
async function retirePrevious(
  config: NodeConfig,
  env: SetupEnvironment,
  previous: PreviousPairing,
  replacementId: string,
) {
  if (!previous.credential) {
    env.io.log(RETIRE_FALLBACK);
    return;
  }
  const client = env.connect(config.convexUrl);
  try {
    const auth = await client.refresh(previous.credential);
    if (auth.workstationId !== previous.workstationId) throw new Error("DEVICE_IDENTITY_MISMATCH");
    client.setAuth(auth.token);
    await client.retireReplaced(previous.workstationId, replacementId);
    env.io.log("✓ Revoked this Mac's previous entry");
  } catch (error) {
    env.io.log(
      classifyCredentialError(error)
        ? RETIRE_FALLBACK
        : `Could not revoke this Mac's previous entry (${describeError(error)}). If it is still listed in Settings → Macs, remove it there.`,
    );
  }
}
const describeError = (error: unknown) =>
  String(errorCode(error) ?? (error instanceof Error ? error.message : "unknown error"));
/**
 * Stops new work for this Mac in repositories the owner unchecked. Repositories with
 * active work stay granted (returned) so the running work is not cut off.
 */
async function removeRepositories(
  client: ControlPlane,
  workstationId: string,
  removed: NodeConfig["repositories"],
  io: SetupIo,
) {
  const kept: NodeConfig["repositories"] = [];
  for (const repository of removed) {
    if (!repository.repositoryId) continue;
    try {
      await client.removeOwnLocation(workstationId, repository.repositoryId);
      io.log(`✓ ${repository.path} no longer receives new work on this Mac`);
    } catch (error) {
      if (errorCode(error) === "LOCATION_BUSY") {
        io.log(
          `${repository.path} still has work running on this Mac; it stays granted. Remove it again once that work has finished.`,
        );
        kept.push(repository);
      } else
        io.log(
          `Could not record the removal of ${repository.path} in Zamolxis (${describeError(error)}); remove it in Settings → Macs if it is still listed.`,
        );
    }
  }
  return kept;
}
/** Health of a freshly (re)started Node: a heartbeat from a process other than `before`. */
export function newProcessHeartbeat(health: NodeHealth, before: NodeHealth | undefined) {
  if (!health.online || !health.runtimeAvailable) return false;
  // Control planes before the exact check only report online.
  if (health.instanceId === undefined) return true;
  if (!health.instanceId || health.instanceId === before?.instanceId) return false;
  return (health.lastHeartbeatAt ?? 0) > (before?.lastHeartbeatAt ?? 0);
}
/**
 * Brings an existing configuration to a working state: Keychain credential,
 * accepted credential (pairing again when needed), registered repositories,
 * the service of this checkout and a heartbeat from the Node process it started.
 */
export async function checkAndRepair(
  config: NodeConfig,
  env: SetupEnvironment,
  options: {
    interactive: boolean;
    restart?: boolean;
    /** Repositories the owner just unchecked; recorded as removed for this Mac. */
    removed?: NodeConfig["repositories"];
    /** The owner confirmed the repository list: removed locations become eligible again. */
    regrant?: boolean;
    /** The entry before "Pair again", retired once the new pairing works. */
    previous?: PreviousPairing;
  },
) {
  const { io } = env;
  const save = (value: NodeConfig) => saveConfig(value, env.configPath);
  let restart = options.restart ?? false;
  let previous = options.previous;
  io.log("✓ Configuration is valid");
  if (migratePlaintextCredential(config, env.store, save)) {
    io.log("✓ Moved the device credential from config.json into the login Keychain");
    restart = true;
  }
  const client = env.connect(config.convexUrl);
  let workstationId: string;
  for (;;) {
    if (!config.workstationId) {
      await pairDevice(config, env, client);
      restart = true;
    }
    const problem = await authenticate(config, env, client);
    if (!problem && config.workstationId) {
      workstationId = config.workstationId;
      break;
    }
    const reason = problem ?? "missing";
    if (reason === "access-denied") throw new Error(PROBLEM_MESSAGE[reason]);
    if (!options.interactive)
      throw new Error(
        `${PROBLEM_MESSAGE[reason]} Run pnpm zamolxis setup and choose "Pair again".`,
      );
    io.log(PROBLEM_MESSAGE[reason]);
    if (!(await io.confirm("Pair this Mac again now? (shows a new QR code)", true)))
      throw new Error("Setup stopped: the Node cannot connect until this Mac is paired again");
    // The rejected credential cannot prove the old entry; it is reported, not revoked.
    if (config.workstationId && !previous) previous = { workstationId: config.workstationId };
    forgetPairing(config, env);
  }
  io.log("✓ Device credential accepted");
  if (previous && previous.workstationId !== workstationId)
    await retirePrevious(config, env, previous, workstationId);
  if (options.removed?.length) {
    const kept = await removeRepositories(client, workstationId, options.removed, io);
    if (kept.length) {
      config.repositories = [...config.repositories, ...kept];
      validateConfig(config);
      save(config);
    }
  }
  const registered = await client.registerRepositories(
    workstationId,
    config.repositories.map(({ name, remoteUrl }) => ({ name, remoteUrl })),
    options.regrant ? { reactivate: true } : undefined,
  );
  config.repositories = config.repositories.map((repository) => {
    const row = registered.find(({ remoteUrl }) => remoteUrl === repository.remoteUrl);
    if (!row) throw new Error("REPOSITORY_REGISTRATION_MISSING");
    return { ...repository, repositoryId: row.repositoryId };
  });
  save(config);
  io.log(`✓ ${config.repositories.length} repositories registered`);
  const state = env.service.inspect();
  const previousPid = env.service.pid();
  let reinstall = true;
  if (state.plist.status === "missing") io.log("Installing the Node service…");
  else if (state.plist.status === "other-checkout")
    io.log(`The Node service runs ${state.plist.daemon}; reinstalling it for this checkout…`);
  else if (state.plist.status === "outdated")
    io.log("The Node service definition is outdated; reinstalling it…");
  else if (!state.loaded) io.log("The Node service is installed but not loaded; loading it…");
  else reinstall = false;
  const restarted = reinstall || restart;
  // The heartbeat before the restart, so only the new process can satisfy the check.
  const before = restarted ? await client.health(workstationId).catch(() => undefined) : undefined;
  if (reinstall) env.service.install();
  else if (restart) {
    io.log("Restarting the Node service to apply the changes…");
    env.service.restart();
  }
  if (restarted) await confirmServiceStable(env, previousPid);
  io.log("✓ Node service runs this checkout's daemon");
  let last: NodeHealth | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    last = await client.health(workstationId);
    if (restarted ? newProcessHeartbeat(last, before) : last.online && last.runtimeAvailable) {
      io.log(
        `✓ Node online${restarted ? " (heartbeat from the restarted service)" : ""}; Codex available; 3 builders + 1 verifier\nOpen ${config.appUrl} on iPhone`,
      );
      await githubStep(config, env, options.interactive, client, workstationId);
      return;
    }
    await env.pause(1500);
  }
  if (restarted && last?.online && last.instanceId && last.instanceId === before?.instanceId)
    throw new Error(
      "Only the previous Node process reported a heartbeat; the restarted service has not. Inspect node-error.log and rerun setup",
    );
  throw new Error("Heartbeat/runtime check failed; inspect node-error.log and rerun setup");
}
/** The environment for managing GitHub tokens, or undefined where setup has none. */
export function githubTokenEnvironment(
  env: SetupEnvironment,
  interactive: boolean,
  report?: { client: ControlPlane; workstationId: string },
): GitHubTokenEnvironment | undefined {
  const github = env.github;
  const ask = env.io.password?.bind(env.io);
  if (!github) return undefined;
  return {
    io: {
      log: (message) => env.io.log(message),
      confirm: (message, value) => env.io.confirm(message, value),
      select: (message, choices, value) => env.io.select(message, choices, value),
      password: async (message) => {
        if (!ask) throw new Error("SECRET_INPUT_UNAVAILABLE");
        return ask(message);
      },
    },
    tokens: github.tokens,
    github: github.client,
    openUrl: github.openUrl,
    interactive: interactive && !!ask,
    ...(report?.client.reportGithubAccess
      ? {
          report: async (entry, access) => {
            if (entry.repositoryId)
              await report.client.reportGithubAccess?.(
                report.workstationId,
                entry.repositoryId,
                access,
              );
          },
        }
      : {}),
  };
}
/** Last setup step: GitHub publishing access per repository. Never fails setup. */
async function githubStep(
  config: NodeConfig,
  env: SetupEnvironment,
  interactive: boolean,
  client: ControlPlane,
  workstationId: string,
) {
  const tokens = githubTokenEnvironment(env, interactive, { client, workstationId });
  if (!tokens) return;
  try {
    await manageGitHubTokens(config.repositories, tokens, { offer: "when-needed" });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") throw error;
    env.io.log(
      `GitHub access could not be checked; run ${"pnpm zamolxis github-token"} later to connect publishing.`,
    );
  }
}
/**
 * `pnpm zamolxis github-token [repository] [--remove]`: shows and manages this Mac's
 * per-repository GitHub tokens. Reports the new status to Zamolxis when the Mac is paired.
 */
export async function githubToken(
  options: { repository?: string; remove?: boolean; interactive: boolean },
  env: SetupEnvironment,
) {
  if (!existsSync(env.configPath))
    throw new Error("This Mac is not set up yet; run pnpm zamolxis setup first");
  const config = readConfig(env.configPath);
  let report: { client: ControlPlane; workstationId: string } | undefined;
  if (config.workstationId)
    try {
      const client = env.connect(config.convexUrl);
      if (!(await authenticate(config, env, client)))
        report = { client, workstationId: config.workstationId };
    } catch {
      /* Not reachable: the Node reports the change itself within a minute or so. */
    }
  const tokens = githubTokenEnvironment(env, options.interactive, report);
  if (!tokens) throw new Error("GitHub tokens are not available here");
  try {
    await manageGitHubTokens(config.repositories, tokens, {
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.remove ? { remove: true } : {}),
      offer: "always",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") throw new Error("Cancelled");
    throw error;
  }
}
export type MenuAction = "repair" | "repositories" | "github" | "rename" | "pair" | "exit";
export function menuChoices(): Choice<MenuAction>[] {
  return [
    { name: "Check and repair", value: "repair" },
    { name: "Add or remove repositories", value: "repositories" },
    { name: "GitHub access for publishing (tokens per repository)", value: "github" },
    { name: "Rename this Mac", value: "rename" },
    { name: "Pair again (new QR code, replaces the device credential)", value: "pair" },
    { name: "Exit", value: "exit" },
  ];
}
/** Validates a Mac name the same way the control plane does (trimmed, 1..64). */
export function validateMacName(value: string): true | string {
  const name = value.trim();
  if (!name) return "Enter a name";
  if (name.length > 64) return "Use at most 64 characters";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters.
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Use printable characters only";
  return true;
}
/** Renames this Mac in Zamolxis (Node-authenticated) and in config.json. */
export async function renameMac(config: NodeConfig, env: SetupEnvironment) {
  const name = (
    await env.io.input("New name for this Mac", { default: config.name, validate: validateMacName })
  ).trim();
  if (name === config.name) {
    env.io.log("The name is unchanged");
    return;
  }
  if (config.workstationId) {
    migratePlaintextCredential(config, env.store, (value) => saveConfig(value, env.configPath));
    const client = env.connect(config.convexUrl);
    const problem = await authenticate(config, env, client);
    if (problem)
      throw new Error(
        `${PROBLEM_MESSAGE[problem]} The name was not changed; run pnpm zamolxis setup and choose "Check and repair" first.`,
      );
    await client.renameSelf(config.workstationId, name);
  }
  config.name = name;
  saveConfig(config, env.configPath);
  env.io.log(
    config.workstationId
      ? `✓ This Mac is now "${name}" in Zamolxis`
      : `✓ This Mac will be paired as "${name}"`,
  );
}
/** Changes repository grants in config.json; returns the change, or undefined if none. */
export async function editRepositories(config: NodeConfig, env: SetupEnvironment) {
  const next = await chooseRepositories(env, config.repositories);
  const added = next.filter(({ path }) => !config.repositories.some((r) => r.path === path));
  const removed = config.repositories.filter(({ path }) => !next.some((r) => r.path === path));
  if (!added.length && !removed.length) {
    env.io.log("No repository changes");
    return undefined;
  }
  validateConfig({ ...config, repositories: next });
  config.repositories = next;
  saveConfig(config, env.configPath);
  for (const { path } of added) env.io.log(`+ ${path}`);
  for (const { path } of removed) env.io.log(`- ${path}`);
  if (removed.length)
    env.io.log(
      "Removed repositories keep their Product and history in Zamolxis; this Mac stops receiving new work for them.",
    );
  return { added, removed };
}
export async function runSetup(options: { repair?: boolean }, env: SetupEnvironment) {
  try {
    if (!existsSync(env.configPath)) {
      if (options.repair)
        throw new Error("This Mac is not set up yet; run pnpm zamolxis setup first");
      await checkAndRepair(await firstRun(env), env, { interactive: true });
      return;
    }
    let config: NodeConfig;
    try {
      config = readConfig(env.configPath);
    } catch (error) {
      // JSON parse messages can quote file contents; never echo them.
      const reason =
        error instanceof SyntaxError
          ? "not valid JSON"
          : error instanceof Error
            ? error.message
            : "unreadable";
      throw new Error(
        `${env.configPath} cannot be used (${reason}). Fix it, or move it aside and run setup again to start over`,
      );
    }
    if (options.repair) return await checkAndRepair(config, env, { interactive: false });
    env.io.log(
      `This Mac is set up as "${config.name}" with ${config.repositories.length} repositories${config.workstationId ? "" : " (not paired yet)"}.`,
    );
    const action = await env.io.select("What do you want to do?", menuChoices(), "repair");
    if (action === "exit") return;
    if (action === "rename") return await renameMac(config, env);
    if (action === "github") return await githubToken({ interactive: true }, env);
    if (action === "repositories") {
      const change = await editRepositories(config, env);
      if (!change) return;
      return await checkAndRepair(config, env, {
        interactive: true,
        restart: true,
        removed: change.removed,
        regrant: true,
      });
    }
    if (action === "pair") {
      if (
        !(await env.io.confirm(
          "Pair again? This Mac stops working until you approve the new QR code. Its previous entry is revoked once the new pairing works.",
          false,
        ))
      )
        return;
      const previous = previousPairing(config, env.store);
      forgetPairing(config, env);
      return await checkAndRepair(config, env, {
        interactive: true,
        ...(previous ? { previous } : {}),
      });
    }
    await checkAndRepair(config, env, { interactive: true });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError")
      throw new Error("Setup cancelled");
    throw error;
  }
}
export async function setup(options: { repair?: boolean } = {}) {
  prerequisites();
  await runSetup(options, defaultEnvironment());
}
export async function githubTokenCli(options: { repository?: string; remove?: boolean }) {
  await githubToken(
    { ...options, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY },
    defaultEnvironment(),
  );
}
