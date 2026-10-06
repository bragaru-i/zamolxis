import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { WorkstationId } from "@zamolxis/contracts";
import { inspectRepository, remoteIdentity } from "@zamolxis/git";
import {
  ControlPlaneDriver,
  LocalStateStore,
  RepositoryRegistry,
  RuntimeManager,
  WorkspaceManager,
} from "@zamolxis/node-core";
import { FakeRuntime, RuntimeRegistry } from "@zamolxis/runtime-core";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexControlPlaneTransport } from "./convex-control-plane";
export interface FakeLoopOptions {
  deploymentUrl: string;
  deviceToken: string;
  workstationId: string;
  repositoryId: string;
  repositoryPath: string;
  repositoryRemote: string;
  managedRoot: string;
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== ".." &&
    !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(suffix)
  );
}
export async function runFakeLoopOnce(options: FakeLoopOptions): Promise<void> {
  const canonical = realpathSync.native(options.repositoryPath);
  const managedRoot = realpathSync.native(options.managedRoot);
  if (!isAbsolute(options.managedRoot) || inside(canonical, managedRoot))
    throw new Error("MANAGED_ROOT_MUST_BE_OUTSIDE_CANONICAL_REPOSITORY");
  // These explicit paths are local filesystem grants, not paths supplied by a cloud command.
  const grant = (path: string) => path === canonical || inside(managedRoot, path);
  const statePath = join(managedRoot, "node-state.sqlite");
  for (const path of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("UNSAFE_STATE_FILE");
  }
  const store = new LocalStateStore(statePath);
  try {
    const identity = store.getOrCreateIdentity();
    const client = new ConvexHttpClient(options.deploymentUrl);
    client.setAuth(options.deviceToken);
    await client.mutation(makeFunctionReference<"mutation">("node:heartbeat"), {
      workstationId: options.workstationId,
      instanceId: identity.instanceId,
      runtimeCapabilities: [{ runtime: "fake", capabilities: ["start"] }],
    });
    const repositories = new RepositoryRegistry(store, grant);
    // Verify identity locally before reporting an available location to the control plane.
    const location = inspectRepository(canonical);
    if (location.remoteIdentity !== remoteIdentity(options.repositoryRemote))
      throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    const locationId = await client.mutation(
      makeFunctionReference<"mutation">("node:registerLocation"),
      {
        workstationId: options.workstationId,
        repositoryId: options.repositoryId,
        canonicalPath: location.path,
        gitCommonDir: location.gitCommonDir,
        headSha: location.headSha,
        ...(location.branch ? { defaultBranch: location.branch } : {}),
      },
    );
    if (typeof locationId !== "string") throw new Error("INVALID_LOCATION_RESPONSE");
    repositories.register({
      repositoryLocationId: locationId,
      repositoryId: options.repositoryId,
      workstationId: options.workstationId,
      path: canonical,
      expectedIdentity: { remoteUrl: options.repositoryRemote },
    });
    const workspaces = new WorkspaceManager(
      store,
      repositories,
      join(managedRoot, "workspaces"),
      identity.instanceId,
      grant,
    );
    const runtimes = new RuntimeRegistry();
    runtimes.register(new FakeRuntime());
    const manager = new RuntimeManager(
      store,
      workspaces,
      runtimes,
      options.workstationId as WorkstationId,
      (runtime) => runtime === "fake",
    );
    const transport = new ConvexControlPlaneTransport(
      client,
      options.workstationId,
      identity.instanceId,
    );
    await new ControlPlaneDriver(
      store,
      workspaces,
      runtimes,
      manager,
      transport,
      options.workstationId,
    ).tick();
  } finally {
    store.close();
  }
}
