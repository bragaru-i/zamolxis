import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NodeIdentity {
  readonly nodeId: string;
  readonly instanceId: string;
}

export interface StoredCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly status: "received" | "running" | "completed" | "failed";
  readonly payload: unknown;
  readonly result?: unknown;
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface StoredWorkspace {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly branch?: string;
  readonly headSha?: string;
  readonly dirty: boolean;
  readonly status: string;
}

export interface StoredRuntimeSession {
  readonly runId: string;
  readonly runtime: string;
  readonly nativeSessionId?: string;
  readonly processId?: number;
  readonly instructionDigest?: string;
  readonly workspaceId: string;
  readonly status: string;
}

export interface RepositoryLocation {
  readonly repositoryLocationId: string;
  readonly repositoryId: string;
  readonly workstationId: string;
  readonly path: string;
  readonly gitCommonDir: string;
  readonly remoteIdentity?: string;
  readonly status: "available" | "missing" | "invalid";
  readonly headSha: string;
  readonly branch?: string;
  readonly dirty: boolean;
}

export interface ManagedWorkspace extends StoredWorkspace {
  readonly repositoryLocationId: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly kind: "worktree" | "integration";
  readonly statusPorcelain?: string;
  readonly commitsSinceBase?: readonly string[];
}
export interface WorkspaceLease {
  readonly workspaceId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly acquiredAt: number;
  readonly renewedAt: number;
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS node_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_executions (
        command_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_outbox (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS event_outbox_pending
        ON event_outbox(acknowledged_at, created_at);

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT,
        head_sha TEXT,
        dirty INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        run_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        native_session_id TEXT,
        process_id INTEGER,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `CREATE TABLE repository_locations (
      location_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workstation_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      UNIQUE(repository_id, workstation_id)
    );`,
  },
  {
    version: 3,
    sql: `CREATE TABLE workspace_details (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id), metadata_json TEXT NOT NULL);
      CREATE TABLE workspace_leases (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
        run_id TEXT NOT NULL, instance_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL);`,
  },
  { version: 4, sql: "ALTER TABLE runtime_sessions ADD COLUMN instruction_digest TEXT;" },
] as const;

function stable(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, normalize(entry)]),
          )
        : item;
  return JSON.stringify(normalize(value));
}
export class LocalStateStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  getOrCreateIdentity(): NodeIdentity {
    const nodeId = this.#getState("nodeId") ?? randomUUID();
    const instanceId = randomUUID();
    this.#setState("nodeId", nodeId);
    this.#setState("instanceId", instanceId);
    return { nodeId, instanceId };
  }

  recordCommand(command: Omit<StoredCommand, "status">): StoredCommand {
    const existing = this.findCommandByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (existing.type !== command.type || stable(existing.payload) !== stable(command.payload))
        throw new Error("COMMAND_REQUEST_CONFLICT");
      return existing;
    }

    this.#db
      .prepare(`
      INSERT INTO command_executions
        (command_id, idempotency_key, type, status, payload_json, result_json, updated_at)
      VALUES (?, ?, ?, 'received', ?, ?, ?)
    `)
      .run(
        command.commandId,
        command.idempotencyKey,
        command.type,
        JSON.stringify(command.payload),
        command.result === undefined ? null : JSON.stringify(command.result),
        Date.now(),
      );
    return { ...command, status: "received" };
  }

  findCommandByIdempotencyKey(idempotencyKey: string): StoredCommand | undefined {
    const row = this.#db
      .prepare("SELECT * FROM command_executions WHERE idempotency_key = ?")
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      commandId: String(row.command_id),
      idempotencyKey: String(row.idempotency_key),
      type: String(row.type),
      status: String(row.status) as StoredCommand["status"],
      payload: JSON.parse(String(row.payload_json)),
      ...(row.result_json === null ? {} : { result: JSON.parse(String(row.result_json)) }),
    };
  }

  listInterruptedCommands(): StoredCommand[] {
    const rows = this.#db
      .prepare(
        "SELECT idempotency_key FROM command_executions WHERE status IN ('running','failed') ORDER BY updated_at LIMIT 101",
      )
      .all() as Array<{ idempotency_key: string }>;
    if (rows.length > 100) throw new Error("COMMAND_RECOVERY_LIMIT_EXCEEDED");
    return rows
      .map((row) => this.findCommandByIdempotencyKey(row.idempotency_key))
      .filter((item): item is StoredCommand => item !== undefined);
  }

  markCommandRunning(commandId: string): void {
    const result = this.#db
      .prepare(
        "UPDATE command_executions SET status='running',updated_at=? WHERE command_id=? AND status='received'",
      )
      .run(Date.now(), commandId);
    if (result.changes !== 1) throw new Error("COMMAND_STATE_CONFLICT");
  }
  completeCommandWithEvents(commandId: string, events: readonly OutboxEvent[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db
        .prepare(
          "UPDATE command_executions SET status='completed',updated_at=? WHERE command_id=? AND status='running'",
        )
        .run(Date.now(), commandId);
      if (result.changes !== 1) throw new Error("COMMAND_STATE_CONFLICT");
      for (const event of events) this.appendEvent(event);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(event: OutboxEvent): void {
    this.#db
      .prepare(`
      INSERT OR IGNORE INTO event_outbox (event_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
      .run(event.eventId, event.type, JSON.stringify(event.payload), event.createdAt);
  }

  listPendingEvents(limit = 100, type?: string): OutboxEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("INVALID_EVENT_LIMIT");
    const rows = this.#db
      .prepare(`
      SELECT event_id, type, payload_json, created_at
      FROM event_outbox
      WHERE acknowledged_at IS NULL AND (? IS NULL OR type = ?)
      ORDER BY created_at, event_id
      LIMIT ?
    `)
      .all(type ?? null, type ?? null, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      eventId: String(row.event_id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: Number(row.created_at),
    }));
  }

  acknowledgeEvent(eventId: string): void {
    this.#db
      .prepare("UPDATE event_outbox SET acknowledged_at = ? WHERE event_id = ?")
      .run(Date.now(), eventId);
  }

  upsertWorkspace(workspace: StoredWorkspace): void {
    this.#db
      .prepare(`
      INSERT INTO workspaces (workspace_id, repository_id, path, branch, head_sha, dirty, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        repository_id = excluded.repository_id,
        path = excluded.path,
        branch = excluded.branch,
        head_sha = excluded.head_sha,
        dirty = excluded.dirty,
        status = excluded.status,
        updated_at = excluded.updated_at
    `)
      .run(
        workspace.workspaceId,
        workspace.repositoryId,
        workspace.path,
        workspace.branch ?? null,
        workspace.headSha ?? null,
        workspace.dirty ? 1 : 0,
        workspace.status,
        Date.now(),
      );
  }

  getWorkspace(workspaceId: string): StoredWorkspace | undefined {
    const row = this.#db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      workspaceId: String(row.workspace_id),
      repositoryId: String(row.repository_id),
      path: String(row.path),
      ...(row.branch === null ? {} : { branch: String(row.branch) }),
      ...(row.head_sha === null ? {} : { headSha: String(row.head_sha) }),
      dirty: Number(row.dirty) === 1,
      status: String(row.status),
    };
  }

  upsertRuntimeSession(session: StoredRuntimeSession): void {
    this.#db
      .prepare(`
      INSERT INTO runtime_sessions (run_id, runtime, native_session_id, process_id, workspace_id, status, updated_at, instruction_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        runtime = excluded.runtime,
        native_session_id = excluded.native_session_id,
        process_id = excluded.process_id,
        workspace_id = excluded.workspace_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        instruction_digest = excluded.instruction_digest
    `)
      .run(
        session.runId,
        session.runtime,
        session.nativeSessionId ?? null,
        session.processId ?? null,
        session.workspaceId,
        session.status,
        Date.now(),
        session.instructionDigest ?? null,
      );
  }

  saveRepositoryLocation(location: RepositoryLocation): void {
    this.#db
      .prepare(`INSERT INTO repository_locations VALUES (?, ?, ?, ?)
      ON CONFLICT(location_id) DO UPDATE SET metadata_json = excluded.metadata_json
      WHERE repository_id = excluded.repository_id AND workstation_id = excluded.workstation_id`)
      .run(
        location.repositoryLocationId,
        location.repositoryId,
        location.workstationId,
        JSON.stringify(location),
      );
  }

  getRepositoryLocation(id: string): RepositoryLocation | undefined {
    const row = this.#db
      .prepare("SELECT metadata_json FROM repository_locations WHERE location_id = ?")
      .get(id) as { metadata_json: string } | undefined;
    return row ? (JSON.parse(row.metadata_json) as RepositoryLocation) : undefined;
  }

  saveManagedWorkspace(workspace: ManagedWorkspace): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertWorkspace(workspace);
      this.#db
        .prepare(`INSERT INTO workspace_details VALUES (?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET metadata_json = excluded.metadata_json`)
        .run(workspace.workspaceId, JSON.stringify(workspace));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getManagedWorkspace(id: string): ManagedWorkspace | undefined {
    const row = this.#db
      .prepare("SELECT metadata_json FROM workspace_details WHERE workspace_id = ?")
      .get(id) as { metadata_json: string } | undefined;
    return row ? (JSON.parse(row.metadata_json) as ManagedWorkspace) : undefined;
  }

  listManagedWorkspaces(): ManagedWorkspace[] {
    return (
      this.#db
        .prepare("SELECT metadata_json FROM workspace_details ORDER BY workspace_id")
        .all() as Array<{ metadata_json: string }>
    ).map((row) => JSON.parse(row.metadata_json) as ManagedWorkspace);
  }

  getWorkspaceLease(id: string): WorkspaceLease | undefined {
    const row = this.#db.prepare("SELECT * FROM workspace_leases WHERE workspace_id = ?").get(id) as
      | {
          workspace_id: string;
          run_id: string;
          instance_id: string;
          acquired_at: number;
          renewed_at: number;
        }
      | undefined;
    return row
      ? {
          workspaceId: row.workspace_id,
          runId: row.run_id,
          nodeInstanceId: row.instance_id,
          acquiredAt: row.acquired_at,
          renewedAt: row.renewed_at,
        }
      : undefined;
  }

  acquireWorkspaceLease(id: string, runId: string, instanceId: string): void {
    const now = Date.now();
    const result = this.#db
      .prepare(`INSERT INTO workspace_leases VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET renewed_at = excluded.renewed_at
      WHERE run_id = excluded.run_id AND instance_id = excluded.instance_id`)
      .run(id, runId, instanceId, now, now);
    if (result.changes !== 1) throw new Error("WORKSPACE_BUSY");
  }

  releaseWorkspaceLease(id: string, runId: string, instanceId: string): void {
    const result = this.#db
      .prepare(
        "DELETE FROM workspace_leases WHERE workspace_id = ? AND run_id = ? AND instance_id = ?",
      )
      .run(id, runId, instanceId);
    if (result.changes !== 1) throw new Error("LEASE_OWNER_MISMATCH");
  }

  getRuntimeSession(runId: string): StoredRuntimeSession | undefined {
    const row = this.#db.prepare("SELECT * FROM runtime_sessions WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      runId: String(row.run_id),
      runtime: String(row.runtime),
      workspaceId: String(row.workspace_id),
      status: String(row.status),
      ...(row.native_session_id === null ? {} : { nativeSessionId: String(row.native_session_id) }),
      ...(row.process_id === null ? {} : { processId: Number(row.process_id) }),
      ...(row.instruction_digest === null
        ? {}
        : { instructionDigest: String(row.instruction_digest) }),
    };
  }

  reserveRuntimeSession(session: StoredRuntimeSession): boolean {
    const result = this.#db
      .prepare(`INSERT OR IGNORE INTO runtime_sessions
      (run_id, runtime, native_session_id, process_id, workspace_id, status, updated_at, instruction_digest)
      VALUES (?, ?, NULL, NULL, ?, 'starting', ?, ?)`)
      .run(
        session.runId,
        session.runtime,
        session.workspaceId,
        Date.now(),
        session.instructionDigest ?? null,
      );
    return result.changes === 1;
  }

  #migrate(): void {
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
    );
    const applied = new Set(
      (
        this.#db.prepare("SELECT version FROM schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#db.exec(migration.sql);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, Date.now());
        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  #getState(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM node_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  #setState(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO node_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}
