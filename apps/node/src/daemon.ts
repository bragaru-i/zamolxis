import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { WorkstationId } from "@zamolxis/contracts";
import { inspectRepository, remoteIdentity } from "@zamolxis/git";
import {
  ControlPlaneDriver,
  LocalStateStore,
  RepositoryDiscovery,
  RepositoryRegistry,
  RuntimeManager,
  WorkspaceManager,
} from "@zamolxis/node-core";
import { AppServerClient, CodexRuntime } from "@zamolxis/runtime-codex";
import { RuntimeRegistry } from "@zamolxis/runtime-core";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexControlPlaneTransport } from "./convex-control-plane";
import { configPath, pause, readConfig } from "./setup";

const pathIndex = process.argv.indexOf("--config");
const config = readConfig(pathIndex >= 0 ? process.argv[pathIndex + 1] : configPath());
if (!config.credential || !config.workstationId) throw new Error("SETUP_REQUIRED");
const root = realpathSync(config.managedRoot);
const canonical = config.repositories.map((repository) => realpathSync(repository.path));
const grant = (path: string) => {
  const suffix = relative(root, path);
  return (
    canonical.includes(path) ||
    (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix))
  );
};
const profile = mkdtempSync(join(tmpdir(), "zamolxis-node-codex-"));
chmodSync(profile, 0o700);
try {
  // Only reuse authentication; user plugins/MCP/config are not execution grants.
  copyFileSync(
    join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
    join(profile, "auth.json"),
  );
  chmodSync(join(profile, "auth.json"), 0o600);
  const children = new Set<ReturnType<typeof spawn>>();
  const statePath = join(root, "node-state.sqlite");
  for (const path of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("UNSAFE_STATE_FILE");
  }
  const store = new LocalStateStore(statePath);
  const identity = store.getOrCreateIdentity();
  const client = new ConvexHttpClient(config.convexUrl);
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
        runtimeCapabilities: [
          {
            runtime: "codex",
            version: execFileSync("codex", ["--version"], {
              encoding: "utf8",
              timeout: 5000,
            }).trim(),
            capabilities: ["start", "message", "stop"],
          },
        ],
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
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      config.workstationId as WorkstationId,
      (runtime) => runtime === "codex",
    );
    const driver = new ControlPlaneDriver(
      store,
      workspaces,
      runtimes,
      manager,
      new ConvexControlPlaneTransport(client, config.workstationId, identity.instanceId),
      config.workstationId,
    );
    // Discovery is performed before every assigned run by the driver.
    driver.setRepositoryDiscovery(new RepositoryDiscovery(workspaces));
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
  } finally {
    if (heartbeats) clearInterval(heartbeats);
    for (const child of children) child.kill("SIGKILL");
    store.close();
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
