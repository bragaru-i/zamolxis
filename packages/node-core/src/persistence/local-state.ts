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
] as const;

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
    if (existing) return existing;

    this.#db.prepare(`
      INSERT INTO command_executions
        (command_id, idempotency_key, type, status, payload_json, result_json, updated_at)
      VALUES (?, ?, ?, 'received', ?, ?, ?)
    `).run(
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
    const row = this.#db.prepare("SELECT * FROM command_executions WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
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

  appendEvent(event: OutboxEvent): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO event_outbox (event_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(event.eventId, event.type, JSON.stringify(event.payload), event.createdAt);
  }

  listPendingEvents(limit = 100): OutboxEvent[] {
    const rows = this.#db.prepare(`
      SELECT event_id, type, payload_json, created_at
      FROM event_outbox
      WHERE acknowledged_at IS NULL
      ORDER BY created_at, event_id
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      eventId: String(row.event_id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: Number(row.created_at),
    }));
  }

  acknowledgeEvent(eventId: string): void {
    this.#db.prepare("UPDATE event_outbox SET acknowledged_at = ? WHERE event_id = ?").run(Date.now(), eventId);
  }

  upsertWorkspace(workspace: StoredWorkspace): void {
    this.#db.prepare(`
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
    `).run(
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
    const row = this.#db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as Record<string, unknown> | undefined;
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
    this.#db.prepare(`
      INSERT INTO runtime_sessions (run_id, runtime, native_session_id, process_id, workspace_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        runtime = excluded.runtime,
        native_session_id = excluded.native_session_id,
        process_id = excluded.process_id,
        workspace_id = excluded.workspace_id,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      session.runId,
      session.runtime,
      session.nativeSessionId ?? null,
      session.processId ?? null,
      session.workspaceId,
      session.status,
      Date.now(),
    );
  }

  saveRepositoryLocation(location: RepositoryLocation): void {
    this.#db.prepare(`INSERT INTO repository_locations VALUES (?, ?, ?, ?)
      ON CONFLICT(location_id) DO UPDATE SET metadata_json = excluded.metadata_json
      WHERE repository_id = excluded.repository_id AND workstation_id = excluded.workstation_id`)
      .run(location.repositoryLocationId, location.repositoryId, location.workstationId, JSON.stringify(location));
  }

  getRepositoryLocation(id: string): RepositoryLocation | undefined {
    const row = this.#db.prepare("SELECT metadata_json FROM repository_locations WHERE location_id = ?")
      .get(id) as { metadata_json: string } | undefined;
    return row ? JSON.parse(row.metadata_json) as RepositoryLocation : undefined;
  }

  #migrate(): void {
    this.#db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
    const applied = new Set(
      (this.#db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#db.exec(migration.sql);
        this.#db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  #getState(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM node_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  #setState(key: string, value: string): void {
    this.#db.prepare("INSERT INTO node_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
