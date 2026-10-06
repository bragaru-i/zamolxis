import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitHubAccess, MemoryRepositoryTokenStore } from "@zamolxis/node-core";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "./credential-store";
import {
  type ControlPlane,
  chooseRepositories,
  classifyCredentialError,
  configDirectory,
  discoverRepositories,
  inspectServicePlist,
  inspectServiceUnit,
  type MenuAction,
  menuChoices,
  migratePlaintextCredential,
  type NodeConfig,
  newProcessHeartbeat,
  parseAppAddress,
  readConfig,
  reloadService,
  runSetup,
  type ServicePlistState,
  type SetupEnvironment,
  type SetupIo,
  saveConfig,
  servicePlist,
  serviceUnit,
  systemdService,
  validateConfig,
} from "./setup";

it("uses native per-user configuration directories", () => {
  expect(configDirectory("darwin", "/home/me", "/xdg")).toBe(
    "/home/me/Library/Application Support/Zamolxis",
  );
  expect(configDirectory("linux", "/home/me", "/xdg")).toBe("/xdg/zamolxis");
  expect(configDirectory("linux", "/home/me", "")).toBe("/home/me/.config/zamolxis");
});

it("accepts a fresh Node heartbeat even before an agent runtime is installed", () => {
  expect(
    newProcessHeartbeat(
      { online: true, runtimeAvailable: false, instanceId: "new", lastHeartbeatAt: 20 },
      { online: true, runtimeAvailable: true, instanceId: "old", lastHeartbeatAt: 10 },
    ),
  ).toBe(true);
});

it("persists versioned private config atomically and rejects overlapping grants, insecure permissions and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "zamolxis-setup-"));
  try {
    const config: NodeConfig = {
      version: 1,
      appUrl: "https://app.example",
      convexUrl: "https://backend.example",
      name: "Mac",
      managedRoot: join(root, "managed"),
      builderSlots: 3,
      verifierSlots: 1,
      repositories: [
        { path: join(root, "repo"), name: "Repo", remoteUrl: "https://example.invalid/repo" },
      ],
    };
    const path = join(root, "private", "config.json");
    saveConfig(config, path);
    saveConfig(config, path);
    expect(readConfig(path)).toEqual(config);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() => validateConfig({ ...config, managedRoot: join(root, "repo", "managed") })).toThrow(
      "OVERLAPS",
    );
    expect(() => validateConfig({ ...config, convexUrl: "http://127.0.0.1:3210" })).toThrow(
      "HTTPS",
    );
    chmodSync(path, 0o644);
    expect(() => readConfig(path)).toThrow("PRIVATE");
    rmSync(path);
    symlinkSync(join(root, "target"), path);
    expect(() => saveConfig(config, path)).toThrow("UNSAFE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("asks for a protocol instead of assuming one and only accepts https", () => {
  expect(parseAppAddress(" zamolxis.example.com/ ")).toEqual({
    candidates: [
      { origin: "https://zamolxis.example.com" },
      { origin: "http://zamolxis.example.com", problem: "Zamolxis requires HTTPS" },
    ],
  });
  expect(parseAppAddress("https://zamolxis.example.com/path?q=1")).toEqual({
    origin: "https://zamolxis.example.com",
  });
  expect(() => parseAppAddress("http://zamolxis.example.com")).toThrow("HTTPS");
  expect(() => parseAppAddress("")).toThrow();
  expect(() => parseAppAddress("zamolxis.example.com/path")).toThrow("INVALID_APP_ADDRESS");
});

it("discovers canonical repository roots and explains unusable candidates", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-discover-")));
  const repository = (name: string, origin = true, commit = true) => {
    const path = join(root, name);
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    if (commit) {
      writeFileSync(join(path, "file.txt"), "x\n");
      git("add", ".");
      git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
    }
    if (origin) git("remote", "add", "origin", "https://example.invalid/team/repo.git");
    return path;
  };
  try {
    const good = repository("good");
    const noOrigin = repository("no-origin", false);
    const empty = repository("empty", true, false);
    const variant = join(root, "GOOD");
    const found = discoverRepositories([good, variant, noOrigin, empty, join(root, "missing")]);
    expect(found).toEqual([
      { path: good, remoteUrl: "https://example.invalid/team/repo.git" },
      { path: noOrigin, problem: "no origin remote" },
      { path: empty, problem: "no commits yet" },
    ]);
    // On case-insensitive volumes the case variant collapses into the canonical root.
    if (existsSync(variant)) expect(found.filter((choice) => choice.path === good)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("service definition", () => {
  const runtime = {
    node: "/opt/node",
    tsx: "/checkout/node_modules/tsx/cli.mjs",
    daemon: "/checkout/apps/node/src/daemon.ts",
    PATH: "/usr/bin:/bin",
    logDirectory: "/Users/me/Library/Application Support/Zamolxis",
  };
  it("recognizes a missing, current, outdated or foreign-checkout service", () => {
    const expected = servicePlist("/config & <x>.json", runtime);
    expect(expected).toContain("<string>/config &amp; &lt;x&gt;.json</string>");
    expect(inspectServicePlist(undefined, expected, runtime.daemon)).toEqual({
      status: "missing",
    });
    expect(inspectServicePlist(expected, expected, runtime.daemon)).toEqual({ status: "current" });
    expect(
      inspectServicePlist(
        servicePlist("/config.json", { ...runtime, PATH: "/other" }),
        expected,
        runtime.daemon,
      ),
    ).toEqual({ status: "outdated" });
    expect(
      inspectServicePlist(
        servicePlist("/config.json", { ...runtime, daemon: "/old & co/apps/node/src/daemon.ts" }),
        expected,
        runtime.daemon,
      ),
    ).toEqual({ status: "other-checkout", daemon: "/old & co/apps/node/src/daemon.ts" });
  });
});

describe("systemd user service definition", () => {
  it("quotes paths and detects a stale checkout", () => {
    const runtime = {
      node: "/opt/node bin/node",
      tsx: "/repo/node_modules/tsx/dist/cli.mjs",
      daemon: "/repo/apps/node/src/daemon.ts",
      PATH: "/home/me/.local/bin:/usr/bin",
    };
    const expected = serviceUnit("/config with space/config.json", runtime);
    expect(expected).toContain('ExecStart="/opt/node bin/node"');
    expect(expected).toContain('"/config with space/config.json"');
    expect(expected).toContain("WantedBy=default.target");
    expect(inspectServiceUnit(undefined, expected, runtime.daemon)).toEqual({ status: "missing" });
    expect(inspectServiceUnit(expected, expected, runtime.daemon)).toEqual({ status: "current" });
    expect(
      inspectServiceUnit(
        serviceUnit("/config.json", { ...runtime, daemon: "/old/apps/node/src/daemon.ts" }),
        expected,
        runtime.daemon,
      ),
    ).toEqual({ status: "other-checkout", daemon: "/old/apps/node/src/daemon.ts" });
  });

  it("installs, starts, inspects and restarts through the user service manager", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-systemd-"));
    const unitPath = join(root, "systemd", "user", "app.zamolxis.node.service");
    const calls: string[][] = [];
    let active = false;
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "is-active") {
        if (!active) throw new Error("inactive");
        return "active";
      }
      if (args[0] === "enable") active = true;
      if (args[0] === "show") return "4321";
      return "";
    };
    try {
      const definition = serviceUnit("/config.json", {
        node: "/usr/bin/node",
        tsx: "/repo/node_modules/tsx/dist/cli.mjs",
        daemon: "/repo/apps/node/src/daemon.ts",
        PATH: "/usr/bin:/bin",
      });
      const service = systemdService("/config.json", { unitPath, run, definition });
      expect(service.inspect()).toEqual({ plist: { status: "missing" }, loaded: false });
      service.install();
      expect(lstatSync(unitPath).mode & 0o777).toBe(0o600);
      expect(service.inspect()).toEqual({ plist: { status: "current" }, loaded: true });
      expect(service.pid()).toBe(4321);
      service.restart();
      expect(calls).toEqual(
        expect.arrayContaining([
          ["daemon-reload"],
          ["enable", "--now", "app.zamolxis.node"],
          ["restart", "app.zamolxis.node"],
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("credential helpers", () => {
  it("classifies refresh failures the owner can act on", () => {
    expect(classifyCredentialError(new ConvexError({ code: "FORBIDDEN" }))).toBe("rejected");
    expect(classifyCredentialError(new ConvexError({ code: "NOT_FOUND" }))).toBe("rejected");
    expect(classifyCredentialError(new ConvexError({ code: "ACCESS_DENIED" }))).toBe(
      "access-denied",
    );
    expect(classifyCredentialError(new Error("fetch failed"))).toBeUndefined();
  });
  it("offers every action, including rename, and defaults to check and repair", () => {
    const choices = menuChoices();
    expect(choices[0]?.value).toBe("repair");
    expect(choices.some(({ disabled }) => disabled)).toBe(false);
    expect(choices.map(({ value }) => value)).toEqual([
      "repair",
      "repositories",
      "github",
      "rename",
      "pair",
      "exit",
    ]);
  });
});

const OLD_SECRET = "1".repeat(64);
const NEW_SECRET = "2".repeat(64);
interface Harness {
  root: string;
  env: SetupEnvironment;
  store: MemoryCredentialStore;
  logs: string[];
  calls: string[];
  registered: Array<Array<{ name: string; remoteUrl: string }>>;
  answers: {
    select: MenuAction[];
    confirm: boolean[];
    checkbox: string[][];
    input: string[];
  };
  control: {
    refresh: (credential: string) => Promise<{ token: string; workstationId: string }>;
    removeOwnLocation: (repositoryId: string) => Promise<"removed" | "absent">;
    retireReplaced: (workstationId: string, replacementId: string) => Promise<void>;
  };
  service: { plist: ServicePlistState; loaded: boolean; pids: Array<number | undefined> };
  /** The Node process the service runs; a restart starts a new instance unless `stuck`. */
  node: { instanceId: string | null; heartbeatAt: number | null; stuck: boolean };
  config(): NodeConfig;
}
let harness: Harness;
function unpaired(root: string): NodeConfig {
  const { workstationId: _, ...config } = baseConfig(root);
  return config;
}
function baseConfig(root: string): NodeConfig {
  return {
    version: 1,
    appUrl: "https://app.example",
    convexUrl: "https://backend.example",
    name: "Mac",
    managedRoot: join(root, "managed"),
    builderSlots: 3,
    verifierSlots: 1,
    repositories: [
      {
        path: join(root, "one"),
        remoteUrl: "https://example.invalid/one.git",
        name: "one",
        repositoryId: "r-one",
      },
    ],
    workstationId: "ws1",
  };
}
beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "zamolxis-repair-")));
  const configPath = join(root, "private", "config.json");
  const logs: string[] = [];
  const calls: string[] = [];
  const registered: Harness["registered"] = [];
  const answers: Harness["answers"] = { select: [], confirm: [], checkbox: [], input: [] };
  const service: Harness["service"] = {
    plist: { status: "current" },
    loaded: true,
    pids: [100],
  };
  const node: Harness["node"] = { instanceId: "instance-1", heartbeatAt: 1000, stuck: false };
  const startNode = () => {
    if (node.stuck) return;
    node.instanceId = `instance-${Number(node.instanceId?.split("-")[1] ?? 0) + 1}`;
    node.heartbeatAt = (node.heartbeatAt ?? 0) + 15_000;
  };
  const control: Harness["control"] = {
    refresh: async (credential) => {
      if (credential !== OLD_SECRET) throw new ConvexError({ code: "FORBIDDEN" });
      return { token: "jwt", workstationId: "ws1" };
    },
    removeOwnLocation: async () => "removed",
    retireReplaced: async () => undefined,
  };
  const store = new MemoryCredentialStore();
  let secrets = 0;
  const io: SetupIo = {
    log: (message) => logs.push(message),
    qr: async () => {
      calls.push("qr");
    },
    select: async <T extends string>() => {
      const answer = answers.select.shift();
      if (!answer) throw new Error("unexpected select");
      return answer as unknown as T;
    },
    checkbox: async (_message, choices) => {
      calls.push(`checkbox:${choices.map((c) => `${c.value}${c.checked ? "*" : ""}`).join(",")}`);
      const answer = answers.checkbox.shift();
      if (!answer) throw new Error("unexpected checkbox");
      return answer;
    },
    input: async (_message, options) => {
      const answer = answers.input.shift();
      if (answer === undefined) throw new Error("unexpected input");
      const valid = options?.validate?.(answer) ?? true;
      if (valid !== true) throw new Error(`invalid input: ${valid}`);
      return answer;
    },
    confirm: async () => {
      const answer = answers.confirm.shift();
      if (answer === undefined) throw new Error("unexpected confirm");
      return answer;
    },
  };
  const plane: ControlPlane = {
    beginPairing: async () => {
      calls.push("begin");
      return "pair1";
    },
    pollPairing: async () => ({ status: "approved" }),
    enroll: async ({ credential }) => {
      calls.push("enroll");
      if (credential !== NEW_SECRET) throw new Error("unexpected credential");
      return { workstationId: "ws2" };
    },
    refresh: (credential) => control.refresh(credential),
    setAuth: (token) => calls.push(`auth:${token}`),
    registerRepositories: async (_workstationId, repositories, options) => {
      registered.push(repositories);
      if (options?.reactivate) calls.push("reactivate");
      return repositories.map(({ remoteUrl }) => ({
        remoteUrl,
        repositoryId: `r-${remoteUrl.split("/").pop()?.replace(".git", "")}`,
      }));
    },
    health: async () => ({
      online: node.instanceId !== null,
      runtimeAvailable: true,
      instanceId: node.instanceId,
      lastHeartbeatAt: node.heartbeatAt,
    }),
    renameSelf: async (workstationId, name) => {
      calls.push(`rename:${workstationId}:${name}`);
    },
    removeOwnLocation: async (workstationId, repositoryId) => {
      calls.push(`remove:${workstationId}:${repositoryId}`);
      return control.removeOwnLocation(repositoryId);
    },
    retireReplaced: async (workstationId, replacementId) => {
      calls.push(`retire:${workstationId}->${replacementId}`);
      return control.retireReplaced(workstationId, replacementId);
    },
  };
  const env: SetupEnvironment = {
    io,
    store,
    connect: () => {
      calls.push("connect");
      return plane;
    },
    service: {
      inspect: () => ({ plist: service.plist, loaded: service.loaded }),
      install: () => {
        calls.push("install");
        service.pids = [200];
        startNode();
      },
      restart: () => {
        calls.push("restart");
        service.pids = [300];
        startNode();
      },
      pid: () => (service.pids.length > 1 ? service.pids.shift() : service.pids[0]),
    },
    configPath,
    pause: async () => undefined,
    discover: () => [
      { path: join(root, "two"), remoteUrl: "https://example.invalid/two.git" },
      { path: join(root, "broken"), problem: "no commits yet" },
    ],
    inspectRepository: (path) => ({
      path,
      remoteUrl: `https://example.invalid/${path.split("/").pop()}.git`,
    }),
    githubAccounts: () => [],
    verifyGithubAccount: () => false,
    secret: () => {
      secrets += 1;
      return secrets === 3 ? NEW_SECRET : String(secrets).padStart(64, "0");
    },
  };
  harness = {
    root,
    env,
    store,
    logs,
    calls,
    registered,
    answers,
    control,
    service,
    node,
    config: () => readConfig(configPath),
  };
});

it("selects and verifies a publishing account per GitHub repository", async () => {
  const path = join(harness.root, "personal");
  const current: NodeConfig["repositories"] = [
    {
      path,
      name: "personal",
      remoteUrl: "https://github.com/bragaru-i/personal.git",
    },
  ];
  harness.answers.checkbox.push([path]);
  harness.answers.select.push("bragaru-i" as MenuAction);
  harness.env.githubAccounts = () => ["ion-wellcopy", "bragaru-i"];
  harness.env.verifyGithubAccount = (host, login, owner, repo) =>
    host === "github.com" && login === "bragaru-i" && owner === "bragaru-i" && repo === "personal";
  await expect(chooseRepositories(harness.env, current)).resolves.toEqual([
    {
      ...current[0],
      publishingIdentity: { provider: "github", host: "github.com", login: "bragaru-i" },
    },
  ]);
  expect(harness.logs.at(-1)).toBe(
    "✓ bragaru-i/personal pull requests will be published as bragaru-i",
  );
});

describe("GitHub access per repository in the repository flow", () => {
  const TOKEN = `github_pat_${"Ch00s3T0k3".repeat(8)}`;
  const GITHUB = { host: "github.com", owner: "bragaru-i", repo: "personal" };
  function personal() {
    const path = join(harness.root, "personal");
    const current: NodeConfig["repositories"] = [
      { path, name: "personal", remoteUrl: "https://github.com/bragaru-i/personal.git" },
    ];
    harness.answers.checkbox.push([path]);
    const tokens = new MemoryRepositoryTokenStore();
    harness.env.github = {
      tokens,
      client: {
        checkAccess: async () => ({ status: "ok", login: "bragaru-i", checkedAt: Date.now() }),
      },
      openUrl: () => undefined,
    };
    const offered: string[][] = [];
    const select = harness.env.io.select.bind(harness.env.io);
    harness.env.io.select = async (message, choices, value) => {
      offered.push(choices.map(({ name }) => name));
      return select(message, choices, value);
    };
    return { current, tokens, offered };
  }

  it("offers a dedicated token besides signed-in gh accounts and then needs no account", async () => {
    const p = personal();
    harness.env.githubAccounts = () => ["ion-wellcopy", "bragaru-i"];
    harness.env.verifyGithubAccount = () => {
      throw new Error("no account was chosen");
    };
    harness.env.io.password = async () => TOKEN;
    harness.answers.select.push("\0token" as MenuAction);
    await expect(chooseRepositories(harness.env, p.current)).resolves.toEqual(p.current);
    expect(p.offered[0]).toEqual([
      "Signed-in gh account ion-wellcopy",
      "Signed-in gh account bragaru-i",
      "Add a dedicated token for this repository",
      "Decide later (no pull requests until it is connected)",
    ]);
    expect(p.tokens.read(GITHUB)).toBe(TOKEN);
    expect(harness.logs.join("\n")).not.toContain(TOKEN);
    // With its own token stored, the repository is not asked about accounts again.
    harness.answers.checkbox.push([p.current[0]?.path ?? ""]);
    await expect(chooseRepositories(harness.env, p.current)).resolves.toEqual(p.current);
    expect(p.offered).toHaveLength(1);
    expect(harness.logs.at(-1)).toContain("publishes with its own GitHub token on this Mac");
  });

  it("without a signed-in account can be left for later, never falling back to another", async () => {
    const p = personal();
    harness.env.githubAccounts = () => [];
    harness.answers.select.push("\0later" as MenuAction);
    const withIdentity = p.current.map((repository) => ({
      ...repository,
      publishingIdentity: { provider: "github" as const, host: "github.com", login: "gone" },
    }));
    await expect(chooseRepositories(harness.env, withIdentity)).resolves.toEqual(p.current);
    expect(harness.logs.at(-1)).toContain("is not connected to GitHub yet");
  });

  it("refuses a chosen account that cannot push the repository", async () => {
    const p = personal();
    harness.env.githubAccounts = () => ["ion-wellcopy"];
    harness.env.verifyGithubAccount = async () => false;
    harness.answers.select.push("ion-wellcopy" as MenuAction);
    await expect(chooseRepositories(harness.env, p.current)).rejects.toThrow(
      "GITHUB_PUSH_ACCESS_REQUIRED: ion-wellcopy cannot push bragaru-i/personal",
    );
  });
});
afterEach(() => rmSync(harness.root, { recursive: true, force: true }));

describe("rerunning setup", () => {
  it("migrates a plaintext credential into the store and removes it from config.json", async () => {
    saveConfig({ ...baseConfig(harness.root), credential: OLD_SECRET }, harness.env.configPath);
    await runSetup({ repair: true }, harness.env);
    expect(harness.store.read("ws1")).toBe(OLD_SECRET);
    expect(readFileSync(harness.env.configPath, "utf8")).not.toContain(OLD_SECRET);
    expect(harness.config().credential).toBeUndefined();
    // The running daemon still holds the old value; it restarts to read the Keychain.
    expect(harness.calls).toContain("restart");
    expect(harness.calls).toContain("auth:jwt");
    expect(harness.logs.join("\n")).not.toContain(OLD_SECRET);
  });

  it("keeps a pending pairing credential under its pairing account and drops orphaned values", () => {
    const store = new MemoryCredentialStore();
    const saved: NodeConfig[] = [];
    const pending: NodeConfig = {
      ...unpaired(harness.root),
      credential: OLD_SECRET,
      pendingPairing: { pairingId: "p1", pollSecret: "x", approvalCode: "y" },
    };
    expect(migratePlaintextCredential(pending, store, (c) => saved.push(c))).toBe(true);
    expect(store.read("pairing-p1")).toBe(OLD_SECRET);
    const orphan = unpaired(harness.root);
    orphan.credential = "not-hex";
    expect(migratePlaintextCredential(orphan, store, (c) => saved.push(c))).toBe(true);
    expect(orphan.credential).toBeUndefined();
    expect(saved).toHaveLength(2);
    expect(migratePlaintextCredential(orphan, store, (c) => saved.push(c))).toBe(false);
  });

  describe("GitHub access for publishing", () => {
    const TOKEN = `github_pat_${"H4rn3ssT0k".repeat(8)}`;
    function withGitHub() {
      const config = baseConfig(harness.root);
      const [first] = config.repositories;
      if (!first) throw new Error("no repository");
      config.repositories = [{ ...first, remoteUrl: "https://github.com/bragaru-i/one.git" }];
      saveConfig(config, harness.env.configPath);
      harness.store.write("ws1", OLD_SECRET);
      const tokens = new MemoryRepositoryTokenStore();
      const reported: Array<[string, string, GitHubAccess["status"]]> = [];
      const opened: string[] = [];
      harness.env.github = {
        tokens,
        client: {
          checkAccess: async () => ({ status: "ok", login: "bragaru-i", checkedAt: Date.now() }),
        },
        openUrl: (url) => opened.push(url),
      };
      const connect = harness.env.connect;
      harness.env.connect = (url) => ({
        ...connect(url),
        reportGithubAccess: async (workstationId, repositoryId, access) => {
          reported.push([workstationId, repositoryId, access.status]);
        },
      });
      return { tokens, reported, opened };
    }

    it("reports each repository's GitHub access during --repair without asking anything", async () => {
      const g = withGitHub();
      harness.env.io.password = async () => {
        throw new Error("unexpected password prompt");
      };
      await runSetup({ repair: true }, harness.env);
      expect(harness.logs).toContain(
        "GitHub bragaru-i/one: not connected: no token and no GitHub account chosen for this repository yet",
      );
      expect(harness.logs.at(-1)).toContain("pnpm zamolxis github-token");
      expect(g.reported).toEqual([["ws1", "r-one", "missing"]]);
      expect(g.opened).toEqual([]);
    });

    it("adds a token from the setup menu with hidden input", async () => {
      const g = withGitHub();
      harness.answers.select.push("github");
      harness.answers.confirm.push(true);
      harness.env.io.password = async () => TOKEN;
      await runSetup({}, harness.env);
      expect(g.tokens.read({ host: "github.com", owner: "bragaru-i", repo: "one" })).toBe(TOKEN);
      expect(g.opened).toHaveLength(1);
      expect(g.reported.at(-1)).toEqual(["ws1", "r-one", "ok"]);
      expect(harness.logs.join("\n")).not.toContain(TOKEN);
    });
  });

  it("repairs without changes when everything is healthy", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    await runSetup({ repair: true }, harness.env);
    expect(harness.calls).not.toContain("install");
    expect(harness.calls).not.toContain("restart");
    expect(harness.registered).toEqual([
      [{ name: "one", remoteUrl: "https://example.invalid/one.git" }],
    ]);
    expect(harness.logs.at(-1)).toContain("Node online");
  });

  it("reinstalls a service that runs another checkout and fails when it keeps exiting", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.service.plist = { status: "other-checkout", daemon: "/old/apps/node/src/daemon.ts" };
    await runSetup({ repair: true }, harness.env);
    expect(harness.calls).toContain("install");
    expect(harness.logs.join("\n")).toContain("/old/apps/node/src/daemon.ts");

    harness.service.plist = { status: "missing" };
    harness.env.service.install = () => {
      harness.service.pids = [undefined];
    };
    await expect(runSetup({ repair: true }, harness.env)).rejects.toThrow("setup --repair");
  });

  it("explains a revoked credential and never pairs without a person in --repair", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", NEW_SECRET);
    await expect(runSetup({ repair: true }, harness.env)).rejects.toThrow(
      /no longer accepts.*Pair again/,
    );
    expect(harness.calls).not.toContain("begin");
    expect(harness.store.read("ws1")).toBe(NEW_SECRET);
  });

  it("reports blocked account access instead of offering to pair again", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.control.refresh = async () => {
      throw new ConvexError({ code: "ACCESS_DENIED" });
    };
    harness.answers.select.push("repair");
    await expect(runSetup({}, harness.env)).rejects.toThrow("does not have access");
    expect(harness.calls).not.toContain("begin");
  });

  it("offers to pair again on a revoked credential and replaces it in the store", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", "9".repeat(64));
    harness.control.refresh = async (credential) => {
      if (credential !== NEW_SECRET) throw new ConvexError({ code: "FORBIDDEN" });
      return { token: "jwt2", workstationId: "ws2" };
    };
    harness.answers.select.push("repair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.calls).toEqual(
      expect.arrayContaining(["begin", "qr", "enroll", "auth:jwt2", "restart"]),
    );
    expect(harness.store.read("ws1")).toBeUndefined();
    expect(harness.store.read("ws2")).toBe(NEW_SECRET);
    expect(harness.store.read("pairing-pair1")).toBeUndefined();
    const config = harness.config();
    expect(config.workstationId).toBe("ws2");
    expect(config.pendingPairing).toBeUndefined();
    expect(readFileSync(harness.env.configPath, "utf8")).not.toContain(NEW_SECRET);
  });

  it("pairs again from the menu only after confirmation", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.answers.select.push("pair");
    harness.answers.confirm.push(false);
    await runSetup({}, harness.env);
    expect(harness.store.read("ws1")).toBe(OLD_SECRET);
    expect(harness.calls).not.toContain("connect");

    // The old credential is still valid: it proves the previous entry, which is retired.
    harness.control.refresh = async (credential) =>
      credential === OLD_SECRET
        ? { token: "jwt-old", workstationId: "ws1" }
        : { token: "jwt2", workstationId: "ws2" };
    harness.answers.select.push("pair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.store.read("ws1")).toBeUndefined();
    expect(harness.store.read("ws2")).toBe(NEW_SECRET);
    expect(harness.calls).toEqual(
      expect.arrayContaining(["auth:jwt2", "auth:jwt-old", "retire:ws1->ws2"]),
    );
    expect(harness.logs).toContain("✓ Revoked this Mac's previous entry");
    expect(harness.logs.join("\n")).not.toContain(OLD_SECRET);
  });

  it("leaves the previous entry and says so when its credential is no longer accepted", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", "9".repeat(64));
    harness.control.refresh = async (credential) => {
      if (credential !== NEW_SECRET) throw new ConvexError({ code: "FORBIDDEN" });
      return { token: "jwt2", workstationId: "ws2" };
    };
    // Explicit "Pair again" with a rejected old credential: it cannot prove the old entry.
    harness.answers.select.push("pair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.calls.some((call) => call.startsWith("retire:"))).toBe(false);
    expect(harness.logs.join("\n")).toContain("previous entry for this Mac was left as it is");
  });

  it("reports the previous entry when repair has to pair again", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", "8".repeat(64));
    harness.control.refresh = async (credential) => {
      if (credential !== NEW_SECRET) throw new ConvexError({ code: "FORBIDDEN" });
      return { token: "jwt2", workstationId: "ws2" };
    };
    // The rejected credential is reported, never used to revoke anything.
    harness.answers.select.push("repair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.calls.some((call) => call.startsWith("retire:"))).toBe(false);
    expect(harness.logs.join("\n")).toContain("previous entry for this Mac was left as it is");
  });

  it("reports a failed retirement without failing setup", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.control.refresh = async (credential) =>
      credential === OLD_SECRET
        ? { token: "jwt-old", workstationId: "ws1" }
        : { token: "jwt2", workstationId: "ws2" };
    harness.control.retireReplaced = async () => {
      throw new Error("fetch failed");
    };
    harness.answers.select.push("pair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.logs.join("\n")).toContain("Could not revoke this Mac's previous entry");
    expect(harness.logs.at(-1)).toContain("Node online");
  });

  it("renames this Mac in Zamolxis with its own credential and in config.json", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.answers.select.push("rename");
    harness.answers.input.push("  Studio Mac  ");
    await runSetup({}, harness.env);
    expect(harness.calls).toEqual(["connect", "auth:jwt", "rename:ws1:Studio Mac"]);
    expect(harness.config().name).toBe("Studio Mac");
    expect(harness.calls).not.toContain("restart");

    harness.answers.select.push("rename");
    harness.answers.input.push("x".repeat(65));
    await expect(runSetup({}, harness.env)).rejects.toThrow("at most 64");

    // A rejected credential changes nothing.
    harness.store.write("ws1", NEW_SECRET);
    harness.answers.select.push("rename");
    harness.answers.input.push("Other");
    await expect(runSetup({}, harness.env)).rejects.toThrow("name was not changed");
    expect(harness.config().name).toBe("Studio Mac");
  });

  it("verifies the heartbeat of the restarted Node process, not the previous one", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    harness.service.plist = { status: "outdated" };
    await runSetup({ repair: true }, harness.env);
    expect(harness.node.instanceId).toBe("instance-2");
    expect(harness.logs.at(-1)).toContain("heartbeat from the restarted service");

    // The old process keeps heartbeating while the new one never reports.
    harness.service.plist = { status: "outdated" };
    harness.service.pids = [100];
    harness.node.stuck = true;
    await expect(runSetup({ repair: true }, harness.env)).rejects.toThrow(
      "Only the previous Node process reported a heartbeat",
    );
  });

  it("adds and removes repositories, keeps existing registrations and restarts the service", async () => {
    saveConfig(
      {
        ...baseConfig(harness.root),
        repositories: [
          ...baseConfig(harness.root).repositories,
          {
            path: join(harness.root, "three"),
            remoteUrl: "https://example.invalid/three.git",
            name: "three",
            repositoryId: "r-three",
          },
        ],
      },
      harness.env.configPath,
    );
    harness.store.write("ws1", OLD_SECRET);
    harness.answers.select.push("repositories");
    harness.answers.checkbox.push([join(harness.root, "one"), join(harness.root, "two")]);
    await runSetup({}, harness.env);
    const one = join(harness.root, "one");
    const two = join(harness.root, "two");
    const three = join(harness.root, "three");
    // Current grants are pre-checked; discovered ones are offered unchecked.
    expect(harness.calls[0]).toBe(
      `checkbox:${one}*,${three}*,${two},${join(harness.root, "broken")},\0other`,
    );
    expect(harness.config().repositories).toEqual([
      {
        path: one,
        remoteUrl: "https://example.invalid/one.git",
        name: "one",
        repositoryId: "r-one",
      },
      {
        path: two,
        remoteUrl: "https://example.invalid/two.git",
        name: "two",
        repositoryId: "r-two",
      },
    ]);
    expect(harness.registered.at(-1)?.map(({ name }) => name)).toEqual(["one", "two"]);
    expect(harness.calls).toContain("restart");
    // The removal is recorded for this Mac; the kept grants are confirmed again.
    expect(harness.calls).toContain("remove:ws1:r-three");
    expect(harness.calls).toContain("reactivate");
    expect(harness.logs.join("\n")).toContain("no longer receives new work on this Mac");
  });

  it("keeps a repository granted while work still runs in it", async () => {
    const three = {
      path: join(harness.root, "three"),
      remoteUrl: "https://example.invalid/three.git",
      name: "three",
      repositoryId: "r-three",
    };
    saveConfig(
      {
        ...baseConfig(harness.root),
        repositories: [...baseConfig(harness.root).repositories, three],
      },
      harness.env.configPath,
    );
    harness.store.write("ws1", OLD_SECRET);
    harness.control.removeOwnLocation = async () => {
      throw new ConvexError({ code: "LOCATION_BUSY" });
    };
    harness.answers.select.push("repositories");
    harness.answers.checkbox.push([join(harness.root, "one")]);
    await runSetup({}, harness.env);
    expect(harness.config().repositories.map(({ name }) => name)).toEqual(["one", "three"]);
    expect(harness.registered.at(-1)?.map(({ name }) => name)).toEqual(["one", "three"]);
    expect(harness.logs.join("\n")).toContain("still has work running on this Mac");
  });

  it("does not re-grant removed repositories on a plain repair", async () => {
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.store.write("ws1", OLD_SECRET);
    await runSetup({ repair: true }, harness.env);
    expect(harness.calls).not.toContain("reactivate");
  });

  it("exits without contacting the control plane and refuses --repair before first setup", async () => {
    await expect(runSetup({ repair: true }, harness.env)).rejects.toThrow("not set up yet");
    saveConfig(baseConfig(harness.root), harness.env.configPath);
    harness.answers.select.push("exit");
    await runSetup({}, harness.env);
    expect(harness.calls).toEqual([]);
  });

  it("explains an unusable config without echoing its contents", async () => {
    mkdirSync(join(harness.root, "private"), { recursive: true });
    writeFileSync(harness.env.configPath, `{"credential":"${OLD_SECRET}"`, { mode: 0o600 });
    const error = await runSetup({ repair: true }, harness.env).catch((caught: Error) => caught);
    expect(String(error)).toContain("not valid JSON");
    expect(String(error)).not.toContain(OLD_SECRET);
  });
});

it("waits for launchd to unload the old service and retries a failed bootstrap", () => {
  const calls: string[] = [];
  let loadedChecks = 2;
  let failures = 2;
  reloadService({
    loaded: () => loadedChecks-- > 0,
    bootstrap: () => {
      calls.push("bootstrap");
      if (failures-- > 0) throw new Error("Bootstrap failed: 5: Input/output error");
    },
    sleep: (ms) => calls.push(`sleep ${ms}`),
  });
  expect(calls).toEqual([
    "sleep 250",
    "sleep 250",
    "bootstrap",
    "sleep 1000",
    "bootstrap",
    "sleep 1000",
    "bootstrap",
  ]);
  expect(() =>
    reloadService({
      loaded: () => false,
      bootstrap: () => {
        throw new Error("still failing");
      },
      sleep: () => {},
    }),
  ).toThrow("still failing");
});
