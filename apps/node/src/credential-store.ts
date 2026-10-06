import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where the Node keeps its device credential. Production uses the macOS login
 * Keychain or a private local file on Linux; tests inject an in-memory store.
 */
export interface CredentialStore {
  read(account: string): string | undefined;
  write(account: string, secret: string): void;
  remove(account: string): void;
}

export const KEYCHAIN_SERVICE = "app.zamolxis.node";
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[a-f0-9]{64}$/;
export const isDeviceCredential = (value: unknown): value is string =>
  typeof value === "string" && SECRET.test(value);
/** Account for a credential created during pairing, before the Mac has a workstation id. */
export const pairingAccount = (pairingId: string) => `pairing-${pairingId}`;

function account(value: string) {
  if (!ACCOUNT.test(value)) throw new Error("INVALID_KEYCHAIN_ACCOUNT");
  return value;
}

export interface SecurityResult {
  status: number;
  stdout: string;
}
/** Runs /usr/bin/security; `input` is written to its stdin. */
export type SecurityRunner = (args: string[], input?: string) => SecurityResult;

const ITEM_NOT_FOUND = 44;

export const runSecurity: SecurityRunner = (args, input) => {
  try {
    const stdout = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { status: 0, stdout };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    // Never forward stdout/stderr: they could contain the secret.
    return { status: typeof status === "number" ? status : -1, stdout: "" };
  }
};

/**
 * Generic password items in the login Keychain: service `app.zamolxis.node`,
 * account = workstation id (or `pairing-<id>` while pairing is in progress).
 *
 * Writing passes the secret on stdin to `security -i` (interactive mode reading
 * commands from stdin) instead of `-w <secret>` on the command line, so the secret
 * does not appear in process listings. Reading uses `find-generic-password -w`, which
 * prints the secret on stdout only to this process. The item's access list trusts
 * /usr/bin/security (the creating tool), so the launchd agent can read it without a
 * dialog while the login Keychain is unlocked; any process running as this user can
 * do the same, as with every `security`-created item. That is weaker than a signed
 * app with its own access group, but the secret is encrypted at rest, locked with
 * the Keychain and no longer copied with config.json.
 */
export class KeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly run: SecurityRunner = runSecurity,
    private readonly platform: string = process.platform,
  ) {}
  private requireMac() {
    if (this.platform !== "darwin") throw new Error("KEYCHAIN_REQUIRES_MACOS");
  }
  read(name: string) {
    this.requireMac();
    const result = this.run([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account(name),
      "-w",
    ]);
    if (result.status === ITEM_NOT_FOUND) return undefined;
    if (result.status !== 0)
      throw new Error(
        `KEYCHAIN_UNAVAILABLE: could not read the device credential from the login Keychain (security exit ${result.status}). Unlock the login Keychain, then run pnpm zamolxis setup --repair`,
      );
    const secret = result.stdout.trim();
    if (!isDeviceCredential(secret)) throw new Error("KEYCHAIN_CREDENTIAL_MALFORMED");
    return secret;
  }
  write(name: string, secret: string) {
    this.requireMac();
    if (!isDeviceCredential(secret)) throw new Error("INVALID_DEVICE_CREDENTIAL");
    // Both values are validated to [A-Za-z0-9_-], so no quoting is needed.
    const result = this.run(
      ["-i"],
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account(name)} -l Zamolxis -w ${secret}\n`,
    );
    if (result.status !== 0)
      throw new Error(
        `KEYCHAIN_UNAVAILABLE: could not save the device credential in the login Keychain (security exit ${result.status})`,
      );
  }
  remove(name: string) {
    this.requireMac();
    const result = this.run([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account(name),
    ]);
    if (result.status !== 0 && result.status !== ITEM_NOT_FOUND)
      throw new Error(`KEYCHAIN_UNAVAILABLE: could not remove the old device credential`);
  }
}

/**
 * Linux fallback for hosts without the macOS Keychain. The file and its parent are
 * private to the current Unix user (0600/0700), symlinks are refused and updates are
 * atomic. This has the same trust boundary as the Node process itself; operators who
 * need encrypted-at-rest storage can protect the home volume or replace this adapter.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, string> {
    const stat = lstatSync(this.path, { throwIfNoEntry: false });
    if (!stat) return {};
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("LOCAL_CREDENTIAL_STORE_MUST_BE_PRIVATE");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("LOCAL_CREDENTIAL_STORE_MALFORMED");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("LOCAL_CREDENTIAL_STORE_MALFORMED");
    const items = parsed as Record<string, unknown>;
    for (const [name, secret] of Object.entries(items)) {
      account(name);
      if (!isDeviceCredential(secret)) throw new Error("LOCAL_CREDENTIAL_STORE_MALFORMED");
    }
    return items as Record<string, string>;
  }

  private save(items: Record<string, string>) {
    const directory = dirname(this.path);
    const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
    if (directoryStat?.isSymbolicLink() || (directoryStat && !directoryStat.isDirectory()))
      throw new Error("UNSAFE_CREDENTIAL_DIRECTORY");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  read(name: string) {
    return this.readAll()[account(name)];
  }
  write(name: string, secret: string) {
    if (!isDeviceCredential(secret)) throw new Error("INVALID_DEVICE_CREDENTIAL");
    this.save({ ...this.readAll(), [account(name)]: secret });
  }
  remove(name: string) {
    const items = this.readAll();
    const key = account(name);
    if (!(key in items)) return;
    delete items[key];
    this.save(items);
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly items = new Map<string, string>();
  read(name: string) {
    return this.items.get(account(name));
  }
  write(name: string, secret: string) {
    if (!isDeviceCredential(secret)) throw new Error("INVALID_DEVICE_CREDENTIAL");
    this.items.set(account(name), secret);
  }
  remove(name: string) {
    this.items.delete(account(name));
  }
}

/**
 * The credential the Node authenticates with: a legacy plaintext value from
 * config.json (until setup migrates it) or the local store item for this workstation.
 */
export function loadDeviceCredential(
  config: { workstationId?: string; credential?: string },
  store: CredentialStore,
): string {
  if (!config.workstationId) throw new Error("SETUP_REQUIRED");
  if (config.credential !== undefined) {
    if (!isDeviceCredential(config.credential)) throw new Error("INVALID_DEVICE_CREDENTIAL");
    return config.credential;
  }
  const secret = store.read(config.workstationId);
  if (!secret)
    throw new Error(
      "DEVICE_CREDENTIAL_MISSING: no device credential in the local credential store; run pnpm zamolxis setup and choose Pair again",
    );
  return secret;
}
