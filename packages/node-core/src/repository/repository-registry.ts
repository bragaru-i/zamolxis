import { existsSync, realpathSync } from "node:fs";
import { inspectRepository, remoteIdentity } from "@zamolxis/git";
import type { LocalStateStore, RepositoryLocation } from "../persistence/local-state";

export interface RegisterRepositoryLocation {
  readonly repositoryLocationId: string;
  readonly repositoryId: string;
  readonly workstationId: string;
  readonly path: string;
  readonly expectedIdentity: { readonly remoteUrl: string } | { readonly gitCommonDir: string };
}

export class RepositoryRegistry {
  constructor(
    private readonly store: LocalStateStore,
    private readonly isGranted: (path: string) => boolean,
  ) {}

  register(input: RegisterRepositoryLocation): RepositoryLocation {
    const path = realpathSync.native(input.path);
    if (!this.isGranted(path)) throw new Error("REPOSITORY_DENIED");
    const snapshot = inspectRepository(path);
    const expected = input.expectedIdentity;
    if (
      "remoteUrl" in expected
        ? snapshot.remoteIdentity !== remoteIdentity(expected.remoteUrl)
        : snapshot.gitCommonDir !== realpathSync.native(expected.gitCommonDir)
    )
      throw new Error("REPOSITORY_IDENTITY_MISMATCH");
    const existing = this.store.getRepositoryLocation(input.repositoryLocationId);
    if (
      existing &&
      (existing.repositoryId !== input.repositoryId ||
        existing.workstationId !== input.workstationId ||
        existing.gitCommonDir !== snapshot.gitCommonDir ||
        existing.remoteIdentity !== snapshot.remoteIdentity)
    ) {
      throw new Error("LOCATION_ALREADY_REGISTERED");
    }
    const location: RepositoryLocation = {
      repositoryLocationId: input.repositoryLocationId,
      repositoryId: input.repositoryId,
      workstationId: input.workstationId,
      ...snapshot,
      status: "available",
    };
    this.store.saveRepositoryLocation(location);
    return location;
  }

  verify(id: string): RepositoryLocation {
    const location = this.store.getRepositoryLocation(id);
    if (!location) throw new Error("LOCATION_NOT_REGISTERED");
    if (!existsSync(location.path)) {
      this.store.saveRepositoryLocation({ ...location, status: "missing" });
      throw new Error("LOCATION_MISSING");
    }
    try {
      if (!this.isGranted(realpathSync.native(location.path))) throw new Error("REPOSITORY_DENIED");
      const snapshot = inspectRepository(location.path);
      if (
        snapshot.gitCommonDir !== location.gitCommonDir ||
        snapshot.remoteIdentity !== location.remoteIdentity
      ) {
        throw new Error("REPOSITORY_IDENTITY_MISMATCH");
      }
      const verified: RepositoryLocation = { ...location, ...snapshot, status: "available" };
      this.store.saveRepositoryLocation(verified);
      return verified;
    } catch (error) {
      this.store.saveRepositoryLocation({ ...location, status: "invalid" });
      throw error;
    }
  }
}
