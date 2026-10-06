import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  KeychainCredentialStore,
  loadDeviceCredential,
  MemoryCredentialStore,
  type SecurityRunner,
} from "./credential-store";

const secret = "a".repeat(64);

function recordingRunner(results: Array<{ status: number; stdout?: string }>) {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const run: SecurityRunner = (args, input) => {
    calls.push({ args, input });
    const next = results.shift() ?? { status: 0 };
    return { status: next.status, stdout: next.stdout ?? "" };
  };
  return { calls, run };
}

describe("KeychainCredentialStore", () => {
  it("writes through stdin so the secret never appears in process arguments", () => {
    const { calls, run } = recordingRunner([{ status: 0 }]);
    new KeychainCredentialStore(run, "darwin").write("ws123", secret);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.args.join(" ")).not.toContain(secret);
    expect(calls[0]?.input).toBe(
      `add-generic-password -U -s app.zamolxis.node -a ws123 -l Zamolxis -w ${secret}\n`,
    );
  });

  it("reads the item, treats a missing item as absent and reports other failures without the secret", () => {
    const { calls, run } = recordingRunner([
      { status: 0, stdout: `${secret}\n` },
      { status: 44 },
      { status: 51 },
    ]);
    const store = new KeychainCredentialStore(run, "darwin");
    expect(store.read("ws123")).toBe(secret);
    expect(calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "app.zamolxis.node",
      "-a",
      "ws123",
      "-w",
    ]);
    expect(store.read("ws123")).toBeUndefined();
    expect(() => store.read("ws123")).toThrow(/KEYCHAIN_UNAVAILABLE.*exit 51/);
  });

  it("ignores a missing item on removal and rejects unsafe accounts, secrets and platforms", () => {
    const { calls, run } = recordingRunner([{ status: 44 }]);
    const store = new KeychainCredentialStore(run, "darwin");
    store.remove("ws123");
    expect(calls[0]?.args).toEqual([
      "delete-generic-password",
      "-s",
      "app.zamolxis.node",
      "-a",
      "ws123",
    ]);
    expect(() => store.write("ws -w other", secret)).toThrow("INVALID_KEYCHAIN_ACCOUNT");
    expect(() => store.write("ws123", `${secret}\nadd-generic-password`)).toThrow(
      "INVALID_DEVICE_CREDENTIAL",
    );
    expect(calls).toHaveLength(1);
    expect(() => new KeychainCredentialStore(run, "linux").read("ws123")).toThrow(
      "KEYCHAIN_REQUIRES_MACOS",
    );
  });
});

describe("FileCredentialStore", () => {
  it("persists private credentials without the macOS Keychain", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-credentials-"));
    const path = join(root, "private", "credentials.json");
    try {
      const store = new FileCredentialStore(path);
      expect(store.read("ws123")).toBeUndefined();
      store.write("ws123", secret);
      expect(store.read("ws123")).toBe(secret);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      store.remove("ws123");
      expect(store.read("ws123")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses public or symlinked stores", () => {
    const root = mkdtempSync(join(tmpdir(), "zamolxis-credentials-"));
    const path = join(root, "credentials.json");
    try {
      const store = new FileCredentialStore(path);
      store.write("ws123", secret);
      chmodSync(path, 0o644);
      expect(() => store.read("ws123")).toThrow("MUST_BE_PRIVATE");
      rmSync(path);
      symlinkSync(join(root, "missing"), path);
      expect(() => store.write("ws123", secret)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadDeviceCredential", () => {
  it("prefers a legacy plaintext value, otherwise reads the Keychain item of the workstation", () => {
    const store = new MemoryCredentialStore();
    expect(() => loadDeviceCredential({}, store)).toThrow("SETUP_REQUIRED");
    expect(() => loadDeviceCredential({ workstationId: "ws1" }, store)).toThrow(
      "DEVICE_CREDENTIAL_MISSING",
    );
    store.write("ws1", secret);
    expect(loadDeviceCredential({ workstationId: "ws1" }, store)).toBe(secret);
    const legacy = "b".repeat(64);
    expect(loadDeviceCredential({ workstationId: "ws1", credential: legacy }, store)).toBe(legacy);
    expect(() =>
      loadDeviceCredential({ workstationId: "ws1", credential: "short" }, store),
    ).toThrow("INVALID_DEVICE_CREDENTIAL");
  });
});
