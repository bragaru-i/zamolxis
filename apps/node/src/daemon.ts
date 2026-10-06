import { execFileSync, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { WorkstationId } from "@zamolxis/contracts";
import { inspectRepository, remoteIdentity } from "@zamolxis/git";
import {
  ControlPlaneDriver,
  LocalStateStore,
  RepositoryDiscovery,
  RepositoryRegistry,
  RuntimeManager,
  RuntimeModelCatalog,
  WorkspaceManager,
} from "@zamolxis/node-core";
import { ClaudeCliProcess, ClaudeRuntime, claudeEnv } from "@zamolxis/runtime-claude";
import {
  AppServerClient,
  CodexRuntime,
  prepareCodexHome,
  releaseCodexHome,
} from "@zamolxis/runtime-codex";
import { RuntimeRegistry } from "@zamolxis/runtime-core";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { claudeSignedIn, findClaude } from "./claude";
import { ConvexControlPlaneTransport } from "./convex-control-plane";
import { KeychainCredentialStore, loadDeviceCredential } from "./credential-store";
import { configPath, pause, readConfig } from "./setup";

const pathIndex = process.argv.indexOf("--config");
const config = readConfig(pathIndex >= 0 ? process.argv[pathIndex + 1] : configPath());
if (!config.workstationId) throw new Error("SETUP_REQUIRED");
// launchd runs this agent in the user's GUI session, so the login Keychain is reachable
// while unlocked; a legacy plaintext value is used until setup migrates it.
config.credential = loadDeviceCredential(config, new KeychainCredentialStore());
const root = realpathSync.native(config.managedRoot);
const canonical = config.repositories.map((repository) => realpathSync.native(repository.path));
const grant = (path: string) => {
  const suffix = relative(root, path);
  return (
    canonical.includes(path) ||
    (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix))
  );
};
// The Node's own CODEX_HOME persists across restarts: Codex keeps each thread's rollout
// there, which lets a restarted Node resume its runs (thread/resume). Only authentication
// is reused from the user's Codex home; user plugins/MCP/config are not execution grants.
const profile = join(root, "codex-home");
prepareCodexHome(profile, {
  authSource: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
});
try {
  const children = new Set<ReturnType<typeof spawn>>();
  const statePath = join(root, "node-state.sqlite");
  for (const path of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("UNSAFE_STATE_FILE");
  }
  const store = new LocalStateStore(statePath);
  const identity = store.getOrCreateIdentity();
  const client = new ConvexHttpClient(config.convexUrl);
  const runtimes = new RuntimeRegistry();
  runtimes.register(
    new CodexRuntime({
      connect: (cwd) =>
        new AppServerClient({
          cwd,
          launch: (executable, assignedCwd) => {
            const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
              cwd: assignedCwd,
              env: { ...process.env, CODEX_HOME: profile },
              shell: false,
              stdio: ["pipe", "pipe", "ignore"],
            });
            children.add(child);
            child.once("exit", () => children.delete(child));
            return child;
          },
        }),
    }),
  );
  // Claude Code is registered only when its CLI runs here. It uses the owner's own Claude
  // Code login (subscription); API key variables are removed from its environment. It is
  // advertised while that login is signed in.
  const claude = findClaude();
  if (claude)
    runtimes.register(
      new ClaudeRuntime({
        executable: claude.executable,
        launch: (launch) =>
          new ClaudeCliProcess({
            ...launch,
            executable: claude.executable,
            spawnChild: (file, args, cwd) => {
              const child = spawn(file, [...args], {
                cwd,
                env: claudeEnv(),
                shell: false,
                stdio: ["pipe", "pipe", "ignore"],
              });
              children.add(child);
              child.once("exit", () => children.delete(child));
              return child;
            },
          }),
      }),
    );
  // Models are fetched at startup and then at most every 30 minutes per runtime; a
  // failure keeps the previous list and never fails the heartbeat.
  const catalog = new RuntimeModelCatalog((id) =>
    runtimes.ids().includes(id) ? runtimes.get(id) : undefined,
  );
  let stopping = false;
  let heartbeatBusy = false;
  let heartbeats: ReturnType<typeof setInterval> | undefined;
  const heartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const token = (await client.action(makeFunctionReference<"action">("deviceTokens:refresh"), {
        credential: config.credential,
      })) as { token: string; workstationId: string };
      if (token.workstationId !== config.workstationId) throw new Error("DEVICE_IDENTITY_MISMATCH");
      client.setAuth(token.token);
      await client.mutation(makeFunctionReference<"mutation">("node:heartbeat"), {
        workstationId: config.workstationId,
        instanceId: identity.instanceId,
        runtimeCapabilities: await catalog.advertise([
          {
            runtime: "codex",
            version: execFileSync("codex", ["--version"], {
              encoding: "utf8",
              timeout: 5000,
            }).trim(),
            // "message": steering active runs; "approval": held operations wait for a human.
            capabilities: ["start", "stop", "message", "approval"],
          },
          ...(claude && claudeSignedIn(claude.executable)
            ? [
                {
                  runtime: "claude",
                  version: findClaude(undefined, [claude.executable])?.version ?? claude.version,
                  capabilities: ["start", "stop", "message", "approval"],
                },
              ]
            : []),
        ]),
      });
    } finally {
      heartbeatBusy = false;
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopping = true;
      for (const child of children) child.kill();
    });
  try {
    await heartbeat();
    heartbeats = setInterval(() => {
      void heartbeat().catch(() => console.error("HEARTBEAT_FAILED"));
    }, 15_000);
    const repositories = new RepositoryRegistry(store, grant);
    for (const repository of config.repositories) {
      if (!repository.repositoryId) throw new Error("REPOSITORY_REGISTRATION_MISSING");
      const snapshot = inspectRepository(repository.path);
      if (snapshot.remoteIdentity !== remoteIdentity(repository.remoteUrl))
        throw new Error("REPOSITORY_IDENTITY_MISMATCH");
      const locationId = await client.mutation(
        makeFunctionReference<"mutation">("node:registerLocation"),
        {
          workstationId: config.workstationId,
          repositoryId: repository.repositoryId,
          canonicalPath: snapshot.path,
          gitCommonDir: snapshot.gitCommonDir,
          headSha: snapshot.headSha,
          ...(snapshot.branch ? { defaultBranch: snapshot.branch } : {}),
        },
      );
      repositories.register({
        repositoryLocationId: String(locationId),
        repositoryId: repository.repositoryId,
        workstationId: config.workstationId,
        path: snapshot.path,
        expectedIdentity: { remoteUrl: repository.remoteUrl },
      });
    }
    const workspaces = new WorkspaceManager(
      store,
      repositories,
      join(root, "workspaces"),
      identity.instanceId,
      grant,
    );
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      config.workstationId as WorkstationId,
      (runtime) => runtime === "codex" || (!!claude && runtime === "claude"),
    );
    const driver = new ControlPlaneDriver(
      store,
      workspaces,
      runtimes,
      manager,
      new ConvexControlPlaneTransport(client, config.workstationId, identity.instanceId),
      config.workstationId,
    );
    // Discovery is performed before every assigned run by the driver. Its first tick
    // reattaches the runs a previous Node process left unfinished (resumed from the
    // persistent CODEX_HOME above, or reported lost).
    driver.setRepositoryDiscovery(new RepositoryDiscovery(workspaces));
    const control = (async () => {
      while (!stopping) {
        try {
          await driver.control();
        } catch {
          console.error("NODE_CONTROL_FAILED");
        }
        await pause(1000);
      }
    })();
    while (!stopping) {
      try {
        await client.mutation(makeFunctionReference<"mutation">("supervisor:dispatch"), {
          workstationId: config.workstationId,
        });
        await driver.tick();
      } catch {
        console.error("NODE_RECONCILIATION_OR_DELIVERY_REQUIRED");
      }
      await pause(1000);
    }
    await control;
  } finally {
    if (heartbeats) clearInterval(heartbeats);
    for (const child of children) child.kill("SIGKILL");
    store.close();
  }
} finally {
  // Rollouts stay for the next start; the copied login does not.
  releaseCodexHome(profile);
}
