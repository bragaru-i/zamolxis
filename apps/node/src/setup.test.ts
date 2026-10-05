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
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "./credential-store";
import {
  type ControlPlane,
  classifyCredentialError,
  discoverRepositories,
  inspectServicePlist,
  type MenuAction,
  menuChoices,
  migratePlaintextCredential,
  type NodeConfig,
  parseAppAddress,
  readConfig,
  reloadService,
  runSetup,
  type ServicePlistState,
  type SetupEnvironment,
  type SetupIo,
  saveConfig,
  servicePlist,
  validateConfig,
} from "./setup";

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

describe("credential helpers", () => {
  it("classifies refresh failures the owner can act on", () => {
    expect(classifyCredentialError(new ConvexError({ code: "FORBIDDEN" }))).toBe("rejected");
    expect(classifyCredentialError(new ConvexError({ code: "NOT_FOUND" }))).toBe("rejected");
    expect(classifyCredentialError(new ConvexError({ code: "ACCESS_DENIED" }))).toBe(
      "access-denied",
    );
    expect(classifyCredentialError(new Error("fetch failed"))).toBeUndefined();
  });
  it("offers rename only as unavailable and defaults to check and repair", () => {
    const choices = menuChoices();
    expect(choices[0]?.value).toBe("repair");
    expect(choices.find(({ value }) => value === "rename")?.disabled).toBeTruthy();
    expect(choices.map(({ value }) => value)).toEqual([
      "repair",
      "repositories",
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
  };
  control: { refresh: (credential: string) => Promise<{ token: string; workstationId: string }> };
  service: { plist: ServicePlistState; loaded: boolean; pids: Array<number | undefined> };
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
  const answers: Harness["answers"] = { select: [], confirm: [], checkbox: [] };
  const service: Harness["service"] = {
    plist: { status: "current" },
    loaded: true,
    pids: [100],
  };
  const control: Harness["control"] = {
    refresh: async (credential) => {
      if (credential !== OLD_SECRET) throw new ConvexError({ code: "FORBIDDEN" });
      return { token: "jwt", workstationId: "ws1" };
    },
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
    input: async () => {
      throw new Error("unexpected input");
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
    registerRepositories: async (_workstationId, repositories) => {
      registered.push(repositories);
      return repositories.map(({ remoteUrl }) => ({
        remoteUrl,
        repositoryId: `r-${remoteUrl.split("/").pop()?.replace(".git", "")}`,
      }));
    },
    health: async () => ({ online: true, runtimeAvailable: true }),
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
      },
      restart: () => {
        calls.push("restart");
        service.pids = [300];
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
    config: () => readConfig(configPath),
  };
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
    await expect(runSetup({ repair: true }, harness.env)).rejects.toThrow("node-error.log");
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

    harness.control.refresh = async () => ({ token: "jwt2", workstationId: "ws2" });
    harness.answers.select.push("pair");
    harness.answers.confirm.push(true);
    await runSetup({}, harness.env);
    expect(harness.store.read("ws1")).toBeUndefined();
    expect(harness.store.read("ws2")).toBe(NEW_SECRET);
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
    expect(harness.logs.join("\n")).toContain("stay registered");
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
