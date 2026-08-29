import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { Database } from 'bun:sqlite'

interface Migration {
  version: number
  name: string
  statements: readonly string[]
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'durable_transport_core',
    statements: [
      `CREATE TABLE telegram_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        chat_id TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'RECEIVED'
          CHECK (state IN ('RECEIVED', 'LEASED', 'PROCESSED', 'RETRY_WAIT', 'FAILED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at_ms INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        processed_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (bot_id, update_id),
        CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
      )`,
      `CREATE INDEX telegram_updates_claim_idx
        ON telegram_updates (state, available_at_ms, update_id)`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'ARCHIVED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (bot_id, chat_id, project_id)
      )`,
      `CREATE TABLE thread_bindings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PROVISIONAL'
          CHECK (state IN ('PROVISIONAL', 'ACTIVE', 'ARCHIVED', 'BROKEN')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (backend, thread_id),
        UNIQUE (session_id, backend)
      )`,
      `CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        backend_turn_id TEXT,
        source_update_id INTEGER REFERENCES telegram_updates(id),
        state TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (state IN ('QUEUED', 'ACTIVE', 'COMPLETED', 'INTERRUPTED', 'FAILED', 'UNKNOWN')),
        request_json TEXT NOT NULL,
        final_response_json TEXT,
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        UNIQUE (session_id, backend_turn_id)
      )`,
      `CREATE INDEX turns_session_state_idx ON turns (session_id, state, created_at_ms)`,
      `CREATE TABLE delivery_jobs (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('send_text', 'send_media', 'send_album', 'edit', 'delete', 'reaction')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'LEASED', 'RETRY_WAIT', 'DELIVERED', 'AMBIGUOUS', 'FAILED', 'EXPIRED', 'ARCHIVED')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER,
        lease_owner TEXT,
        lease_expires_at_ms INTEGER,
        send_started_at_ms INTEGER,
        remote_id TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER,
        CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
        CHECK (state != 'DELIVERED' OR (remote_id IS NOT NULL AND length(remote_id) > 0))
      )`,
      `CREATE INDEX delivery_jobs_claim_idx
        ON delivery_jobs (state, available_at_ms, created_at_ms)`,
      `CREATE INDEX delivery_jobs_session_idx
        ON delivery_jobs (session_id, state, created_at_ms)`,
    ],
  },
  {
    version: 2,
    name: 'idempotent_turn_operations',
    statements: [
      'ALTER TABLE turns ADD COLUMN operation_key TEXT',
      `CREATE UNIQUE INDEX turns_operation_key_idx
        ON turns (operation_key) WHERE operation_key IS NOT NULL`,
    ],
  },
  {
    version: 3,
    name: 'telegram_poll_cursors',
    statements: [
      `CREATE TABLE telegram_poll_cursors (
        bot_id TEXT PRIMARY KEY,
        next_update_id INTEGER NOT NULL CHECK (next_update_id >= 0),
        updated_at_ms INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 4,
    name: 'codex_interactions',
    statements: [
      `CREATE TABLE codex_interactions (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        server_request_id_json TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('COMMAND_APPROVAL', 'FILE_APPROVAL', 'USER_INPUT')),
        request_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (state IN ('PENDING', 'RESOLVING', 'RESOLVED', 'EXTERNALLY_RESOLVED', 'STALE', 'EXPIRED', 'FAILED')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (connection_id, server_request_id_json)
      )`,
      `CREATE INDEX codex_interactions_pending_idx
        ON codex_interactions (state, expires_at_ms, created_at_ms)`,
      `CREATE INDEX codex_interactions_thread_idx
        ON codex_interactions (thread_id, state, created_at_ms)`,
    ],
  },
  {
    version: 5,
    name: 'telegram_update_routing',
    statements: [
      `ALTER TABLE telegram_updates ADD COLUMN routing_class TEXT NOT NULL DEFAULT 'OTHER'
        CHECK (routing_class IN ('CONTROL', 'MESSAGE', 'QUEUED_MESSAGE', 'OTHER'))`,
      `CREATE INDEX telegram_updates_routing_idx
        ON telegram_updates (bot_id, chat_id, routing_class, state, update_id)`,
    ],
  },
  {
    version: 6,
    name: 'delivery_problem_actions',
    statements: [
      `CREATE TABLE delivery_problem_actions (
        id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('RETRY', 'RESOLVE', 'ARCHIVE')),
        from_state TEXT NOT NULL CHECK (from_state IN ('FAILED', 'AMBIGUOUS', 'EXPIRED')),
        to_state TEXT NOT NULL CHECK (to_state IN ('PENDING', 'DELIVERED', 'ARCHIVED')),
        actor_bot_id TEXT NOT NULL,
        actor_chat_id TEXT NOT NULL,
        remote_id TEXT,
        created_at_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX delivery_problem_actions_job_idx
        ON delivery_problem_actions (job_id, created_at_ms)`,
    ],
  },
]

function ensureParentDirectory(filename: string): void {
  if (filename === ':memory:' || filename.length === 0) return
  mkdirSync(dirname(filename), { recursive: true })
}

function configureConnection(database: Database): void {
  database.run('PRAGMA foreign_keys = ON')
  database.run('PRAGMA busy_timeout = 5000')
  database.run('PRAGMA synchronous = NORMAL')
  database.run('PRAGMA journal_mode = WAL')
}

function migrate(database: Database): void {
  database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  )`)

  const appliedRows = database
    .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
    .all()
  const applied = new Set(appliedRows.map((row) => row.version))
  const newestKnownVersion = MIGRATIONS.at(-1)?.version ?? 0
  const newestAppliedVersion = appliedRows.at(-1)?.version ?? 0
  if (newestAppliedVersion > newestKnownVersion) {
    throw new Error(
      `database schema version ${newestAppliedVersion} is newer than supported version ${newestKnownVersion}`,
    )
  }

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue

    database.transaction(() => {
      const alreadyApplied = database
        .query<{ version: number }, [number]>(
          'SELECT version FROM schema_migrations WHERE version = ?',
        )
        .get(migration.version)
      if (alreadyApplied !== null) return

      for (const statement of migration.statements) database.run(statement)
      database.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()],
      )
    }).immediate()
  }
}

export function openDurableDatabase(filename: string): Database {
  ensureParentDirectory(filename)
  const database = new Database(filename, { create: true, readwrite: true, strict: true })

  try {
    configureConnection(database)
    migrate(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
