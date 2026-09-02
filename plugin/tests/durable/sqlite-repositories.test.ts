import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

import { LeaseConflictError } from '../../src/durable/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteCodexEventRepository } from '../../src/durable/codex-event-repository.js'
import { SqliteAgentSettingsRepository } from '../../src/durable/settings-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
import { embeddedForwardComment } from '../../src/telegram/forward-comment.js'

const NOW = 1_800_000_000_000
const LEASE_MS = 30_000

let root: string
let filename: string
let database: Database

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-durable-'))
  filename = join(root, 'state', 'bridge.sqlite3')
  database = openDurableDatabase(filename)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable database migrations', () => {
  test('creates the complete M1 schema in WAL mode and migrates idempotently', () => {
    const mode = database
      .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
      .get()
    expect(mode?.journal_mode).toBe('wal')

    const tables = database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual([
      'agent_project_settings',
      'codex_interactions',
      'codex_turn_diffs',
      'codex_turn_ux',
      'codex_unhandled_notifications',
      'delivery_jobs',
      'delivery_problem_actions',
      'guided_plan_preferences',
      'guided_plans',
      'product_decision_drafts',
      'product_decision_flows',
      'registered_projects',
      'schema_migrations',
      'sessions',
      'telegram_album_fragments',
      'telegram_album_groups',
      'telegram_attachment_proofs',
      'telegram_attachments',
      'telegram_busy_prompts',
      'telegram_chat_preferences',
      'telegram_message_routes',
      'telegram_poll_cursors',
      'telegram_status_pins',
      'telegram_turn_plan_cards',
      'telegram_updates',
      'thread_bindings',
      'thread_registry',
      'turn_recovery_attempts',
      'turn_task_workspaces',
      'turns',
    ])

    database.close()
    database = openDurableDatabase(filename)
    const migrations = database
      .query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations')
      .get()
    expect(migrations?.count).toBe(26)
  })

  test('migrates cumulative HUD totals without relabelling them as current context', () => {
    const legacyFilename = join(root, 'legacy-v17-token-usage.sqlite3')
    const legacy = new Database(legacyFilename, { create: true })
    legacy.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )`)
    for (let version = 1; version <= 17; version += 1) {
      legacy.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [version, `legacy-${version}`, NOW],
      )
    }
    legacy.run(`CREATE TABLE codex_turn_ux (
      operation_key TEXT PRIMARY KEY,
      total_tokens INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER
    )`)
    legacy.run(
      `INSERT INTO codex_turn_ux
        (operation_key, total_tokens, input_tokens, output_tokens)
       VALUES ('turn-1', 63296, 63138, 158)`,
    )
    legacy.close()

    const upgraded = openDurableDatabase(legacyFilename)
    expect(upgraded.query<{
      total_tokens: number | null
      input_tokens: number | null
      output_tokens: number | null
      cached_input_tokens: number | null
      thread_total_tokens: number | null
    }, []>(
      `SELECT total_tokens, input_tokens, output_tokens,
         cached_input_tokens, thread_total_tokens
       FROM codex_turn_ux WHERE operation_key = 'turn-1'`,
    ).get()).toEqual({
      total_tokens: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      thread_total_tokens: 63_296,
    })
    upgraded.close()
  })

  test('backfills an existing v6 binding into the thread registry', () => {
    const legacyFilename = join(root, 'legacy-v6.sqlite3')
    const legacy = new Database(legacyFilename, { create: true })
    legacy.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )`)
    for (let version = 1; version <= 6; version += 1) {
      legacy.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [version, `legacy-${version}`, NOW],
      )
    }
    legacy.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`)
    legacy.run(`CREATE TABLE thread_bindings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`)
    legacy.run(`CREATE TABLE delivery_jobs (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    legacy.run(`CREATE TABLE codex_interactions (
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
      state TEXT NOT NULL DEFAULT 'PENDING',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER,
      last_error TEXT,
      UNIQUE (connection_id, server_request_id_json)
    )`)
    legacy.run(
      `INSERT INTO sessions
        (id, bot_id, chat_id, project_id, state, created_at_ms, updated_at_ms)
       VALUES ('session-1', 'primary', '7001', 'workspace', 'ACTIVE', ?, ?)`,
      [NOW, NOW],
    )
    legacy.run(
      `INSERT INTO thread_bindings
        (id, session_id, backend, thread_id, state, created_at_ms, updated_at_ms)
       VALUES ('binding-1', 'session-1', 'codex', 'thread-existing', 'ACTIVE', ?, ?)`,
      [NOW, NOW + 1],
    )
    legacy.close()

    const upgraded = openDurableDatabase(legacyFilename)
    expect(upgraded.query<{
      session_id: string
      thread_id: string
      state: string
      last_used_at_ms: number
    }, []>('SELECT session_id, thread_id, state, last_used_at_ms FROM thread_registry').get()).toEqual({
      session_id: 'session-1',
      thread_id: 'thread-existing',
      state: 'AVAILABLE',
      last_used_at_ms: NOW + 1,
    })
    upgraded.close()
  })

  test('preserves existing interactions through permission and MCP interaction migrations', () => {
    const legacyFilename = join(root, 'legacy-v10.sqlite3')
    const legacy = new Database(legacyFilename, { create: true })
    legacy.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )`)
    for (let version = 1; version <= 10; version += 1) {
      legacy.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [version, `legacy-${version}`, NOW],
      )
    }
    legacy.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`)
    legacy.run(`CREATE TABLE delivery_jobs (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    legacy.run(`CREATE TABLE codex_interactions (
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
      state TEXT NOT NULL DEFAULT 'PENDING',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER,
      recovery_handled_at_ms INTEGER,
      last_error TEXT,
      UNIQUE (connection_id, server_request_id_json)
    )`)
    legacy.run(
      `INSERT INTO sessions
        (id, bot_id, chat_id, project_id, state, created_at_ms, updated_at_ms)
       VALUES ('session-v10', 'primary', '7001', 'workspace', 'ACTIVE', ?, ?)`,
      [NOW, NOW],
    )
    legacy.run(
      `INSERT INTO codex_interactions
        (id, token, connection_id, server_request_id_json, session_id, thread_id,
         turn_id, item_id, kind, request_json, answers_json, state, created_at_ms,
         updated_at_ms, expires_at_ms)
       VALUES ('interaction-v10', 'token-v10', 'connection-v10', '"request-v10"',
         'session-v10', 'thread-v10', 'turn-v10', 'item-v10', 'COMMAND_APPROVAL',
         '{}', '{}', 'PENDING', ?, ?, ?)`,
      [NOW, NOW, NOW + 60_000],
    )
    legacy.close()

    const upgraded = openDurableDatabase(legacyFilename)
    expect(upgraded.query<{
      id: string
      kind: string
      thread_id: string
      recovery_handled_at_ms: number | null
    }, []>(
      `SELECT id, kind, thread_id, recovery_handled_at_ms
       FROM codex_interactions WHERE id = 'interaction-v10'`,
    ).get()).toEqual({
      id: 'interaction-v10',
      kind: 'COMMAND_APPROVAL',
      thread_id: 'thread-v10',
      recovery_handled_at_ms: null,
    })
    const tableSql = upgraded.query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_interactions'`,
    ).get()?.sql
    expect(tableSql).toContain("'PERMISSIONS_APPROVAL'")
    expect(tableSql).toContain("'MCP_ELICITATION'")
    upgraded.close()
  })

  test('adds ordered delivery dependencies without rewriting existing v12 jobs', () => {
    const legacyFilename = join(root, 'legacy-v12.sqlite3')
    const legacy = new Database(legacyFilename, { create: true })
    legacy.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )`)
    for (let version = 1; version <= 12; version += 1) {
      legacy.run(
        'INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)',
        [version, `legacy-${version}`, NOW],
      )
    }
    legacy.run(`CREATE TABLE delivery_jobs (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`)
    legacy.run(
      `INSERT INTO delivery_jobs (id, source_key, state, created_at_ms)
       VALUES ('existing-job', 'existing:source', 'DELIVERED', ?)`,
      [NOW],
    )
    legacy.close()

    const upgraded = openDurableDatabase(legacyFilename)
    expect(upgraded.query<{
      id: string
      source_key: string
      depends_on_source_key: string | null
    }, []>(
      'SELECT id, source_key, depends_on_source_key FROM delivery_jobs',
    ).get()).toEqual({
      id: 'existing-job',
      source_key: 'existing:source',
      depends_on_source_key: null,
    })
    upgraded.close()
  })
})

describe('SqliteAgentSettingsRepository', () => {
  test('persists selected project and isolated per-project overrides across restart', () => {
    let settings = new SqliteAgentSettingsRepository(database)
    expect(settings.getSelectedProject('primary', '7001')).toBeNull()
    settings.selectProject('primary', '7001', 'other', NOW)
    settings.updateProjectSettings('primary', '7001', 'other', {
      model: 'gpt-fast',
      effort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
    }, NOW)
    settings.updateProjectSettings('primary', '7001', 'other', { effort: 'medium' }, NOW + 1)

    expect(settings.getTurnSettings('primary', '7001', 'other')).toEqual({
      model: 'gpt-fast',
      effort: 'medium',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
    })
    expect(settings.getTurnSettings('primary', '7001', 'workspace')).toEqual({})

    database.close()
    database = openDurableDatabase(filename)
    settings = new SqliteAgentSettingsRepository(database)
    expect(settings.getSelectedProject('primary', '7001')).toBe('other')
    expect(settings.getProjectSettings('primary', '7001', 'other')).toMatchObject({
      model: 'gpt-fast',
      effort: 'medium',
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      createdAtMs: NOW,
      updatedAtMs: NOW + 1,
    })
  })
})

describe('SqliteCodexEventRepository', () => {
  test('aggregates safe correlation metadata without persisting event payloads', () => {
    let nowMs = NOW
    let events = new SqliteCodexEventRepository(database, { now: () => nowMs })
    events.recordUnhandledNotification({
      method: 'future/progress',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        payload: 'private request body',
      },
    })
    nowMs += 1
    events.recordUnhandledNotification({
      method: 'future/progress',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        payload: 'another private body',
      },
    })
    expect(events.list()).toEqual([{
      method: 'future/progress',
      threadId: 'thread-1',
      turnId: 'turn-1',
      occurrenceCount: 2,
      firstSeenAtMs: NOW,
      lastSeenAtMs: NOW + 1,
    }])
    expect(
      JSON.stringify(database.query<Record<string, unknown>, []>(
        'SELECT * FROM codex_unhandled_notifications',
      ).all()),
    ).not.toContain('private body')

    database.close()
    database = openDurableDatabase(filename)
    events = new SqliteCodexEventRepository(database)
    expect(events.list()[0]?.occurrenceCount).toBe(2)
  })

  test('bounds unknown notification cardinality', () => {
    const events = new SqliteCodexEventRepository(database, {
      now: () => NOW,
      maxRows: 2,
    })
    for (const method of ['future/one', 'future/two', 'future/three']) {
      events.recordUnhandledNotification({ method })
    }
    expect(events.list().map((event) => event.method)).toEqual(['future/three', 'future/two'])
  })
})

describe('SqliteInboxRepository', () => {
  test('coalesces an immediate comment with the following forwarded update', () => {
    const inbox = new SqliteInboxRepository(database)
    const comment = inbox.ingest({
      botId: 'primary',
      updateId: 40,
      chatId: '7001',
      routingClass: 'MESSAGE',
      payload: {
        update_id: 40,
        message: {
          message_id: 400,
          chat: { id: 7001, type: 'private' },
          from: { id: 7001, is_bot: false },
          text: 'Сделай так, брат',
        },
      },
      receivedAtMs: NOW,
      availableAtMs: NOW + 1_500,
    })
    const forwarded = inbox.ingest({
      botId: 'primary',
      updateId: 41,
      chatId: '7001',
      routingClass: 'MESSAGE',
      payload: {
        update_id: 41,
        message: {
          message_id: 401,
          chat: { id: 7001, type: 'private' },
          from: { id: 7001, is_bot: false },
          forward_origin: { type: 'channel', chat: { id: -1001 }, message_id: 8 },
          caption: 'Пересланный пост',
          photo: [{ file_id: 'photo-1' }],
        },
      },
      receivedAtMs: NOW + 350,
    })

    expect(inbox.coalesceForwardComment(forwarded.update.id, 1_500, NOW + 350)).toBe(true)
    expect(inbox.get(comment.update.id)).toMatchObject({
      state: 'PROCESSED',
      lastError: 'coalesced with forwarded message',
    })
    expect(embeddedForwardComment(inbox.get(forwarded.update.id)?.payload)).toEqual({
      text: 'Сделай так, брат',
      sourceUpdateRowId: comment.update.id,
    })
    expect(inbox.claimNext({
      workerId: 'forward', nowMs: NOW + 350, leaseDurationMs: LEASE_MS,
    })?.id).toBe(forwarded.update.id)
  })

  test('does not coalesce a forward with another sender or an expired comment window', () => {
    const inbox = new SqliteInboxRepository(database)
    inbox.ingest({
      botId: 'primary', updateId: 50, chatId: '7001', routingClass: 'MESSAGE',
      payload: {
        message: {
          chat: { id: 7001, type: 'private' },
          from: { id: 7002, is_bot: false },
          text: 'foreign comment',
        },
      },
      receivedAtMs: NOW,
      availableAtMs: NOW + 1_500,
    })
    const wrongSender = inbox.ingest({
      botId: 'primary', updateId: 51, chatId: '7001', routingClass: 'MESSAGE',
      payload: {
        message: {
          chat: { id: 7001, type: 'private' },
          from: { id: 7001, is_bot: false },
          forward_origin: { type: 'user', sender_user: { id: 8 } },
          text: 'forward',
        },
      },
      receivedAtMs: NOW + 100,
    })
    expect(inbox.coalesceForwardComment(wrongSender.update.id, 1_500, NOW + 100)).toBe(false)

    const oldComment = inbox.ingest({
      botId: 'primary', updateId: 52, chatId: '7001', routingClass: 'MESSAGE',
      payload: {
        message: {
          chat: { id: 7001, type: 'private' },
          from: { id: 7001, is_bot: false },
          text: 'old comment',
        },
      },
      receivedAtMs: NOW + 200,
      availableAtMs: NOW + 1_700,
    })
    const lateForward = inbox.ingest({
      botId: 'primary', updateId: 53, chatId: '7001', routingClass: 'MESSAGE',
      payload: {
        message: {
          chat: { id: 7001, type: 'private' },
          from: { id: 7001, is_bot: false },
          forward_origin: { type: 'hidden_user', sender_user_name: 'Hidden' },
          text: 'late forward',
        },
      },
      receivedAtMs: NOW + 1_701,
    })
    expect(inbox.coalesceForwardComment(lateForward.update.id, 1_500, NOW + 1_701)).toBe(false)
    expect(inbox.get(oldComment.update.id)?.state).toBe('RECEIVED')
  })

  test('deduplicates before processing and preserves the first accepted payload', () => {
    const inbox = new SqliteInboxRepository(database)
    const first = inbox.ingest({
      botId: 'primary',
      updateId: 42,
      chatId: '1001',
      payload: { update_id: 42, message: { text: 'first' } },
      receivedAtMs: NOW,
    })
    const duplicate = inbox.ingest({
      botId: 'primary',
      updateId: 42,
      chatId: '1001',
      payload: { update_id: 42, message: { text: 'must not replace durable input' } },
      receivedAtMs: NOW + 1,
    })
    const otherBot = inbox.ingest({
      botId: 'secondary',
      updateId: 42,
      payload: { update_id: 42 },
      receivedAtMs: NOW,
    })

    expect(first.created).toBe(true)
    expect(duplicate.created).toBe(false)
    expect(duplicate.update.id).toBe(first.update.id)
    expect(duplicate.update.payload).toEqual({ update_id: 42, message: { text: 'first' } })
    expect(otherBot.created).toBe(true)
  })

  test('recovers an expired processing lease after restart without losing the update', () => {
    let inbox = new SqliteInboxRepository(database)
    const accepted = inbox.ingest({
      botId: 'primary',
      updateId: 43,
      payload: { update_id: 43, message: { text: 'survive me' } },
      receivedAtMs: NOW,
    })
    const firstLease = inbox.claimNext({ workerId: 'worker-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    expect(firstLease?.id).toBe(accepted.update.id)
    expect(firstLease?.attemptCount).toBe(1)
    expect(() => inbox.markProcessed(accepted.update.id, 'worker-b', NOW + 1)).toThrow(
      LeaseConflictError,
    )

    database.close()
    database = openDurableDatabase(filename)
    inbox = new SqliteInboxRepository(database)

    expect(inbox.recoverExpiredLeases(NOW + LEASE_MS + 1)).toBe(1)
    const recovered = inbox.claimNext({
      workerId: 'worker-b',
      nowMs: NOW + LEASE_MS + 1,
      leaseDurationMs: LEASE_MS,
    })
    expect(recovered?.id).toBe(accepted.update.id)
    expect(recovered?.attemptCount).toBe(2)

    const processed = inbox.markProcessed(accepted.update.id, 'worker-b', NOW + LEASE_MS + 2)
    expect(processed.state).toBe('PROCESSED')
    expect(processed.processedAtMs).toBe(NOW + LEASE_MS + 2)
    expect(inbox.claimNext({ workerId: 'worker-c', nowMs: NOW + 100_000, leaseDurationMs: LEASE_MS })).toBeNull()
  })

  test('keeps retry scheduling durable', () => {
    const inbox = new SqliteInboxRepository(database)
    const accepted = inbox.ingest({ botId: 'primary', updateId: 44, payload: {}, receivedAtMs: NOW })
    inbox.claimNext({ workerId: 'worker-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    inbox.retry(accepted.update.id, 'worker-a', 'backend unavailable', NOW + 60_000)

    expect(inbox.claimNext({ workerId: 'worker-b', nowMs: NOW + 59_999, leaseDurationMs: LEASE_MS })).toBeNull()
    expect(inbox.claimNext({ workerId: 'worker-b', nowMs: NOW + 60_000, leaseDurationMs: LEASE_MS })?.id).toBe(
      accepted.update.id,
    )
  })

  test('renews a live lease but never resurrects an expired one', () => {
    const inbox = new SqliteInboxRepository(database)
    const accepted = inbox.ingest({ botId: 'primary', updateId: 45, payload: {}, receivedAtMs: NOW })
    inbox.claimNext({ workerId: 'worker-a', nowMs: NOW, leaseDurationMs: LEASE_MS })

    const renewed = inbox.renewLease(accepted.update.id, {
      workerId: 'worker-a',
      nowMs: NOW + 20_000,
      leaseDurationMs: LEASE_MS,
    })
    expect(renewed.leaseExpiresAtMs).toBe(NOW + 50_000)
    expect(inbox.recoverExpiredLeases(NOW + LEASE_MS + 1)).toBe(0)
    expect(() =>
      inbox.renewLease(accepted.update.id, {
        workerId: 'worker-a',
        nowMs: NOW + 50_000,
        leaseDurationMs: LEASE_MS,
      }),
    ).toThrow(LeaseConflictError)
  })

  test('claims one durable leader for a complete album and processes every fragment atomically', () => {
    let inbox = new SqliteInboxRepository(database)
    const first = inbox.ingest({
      botId: 'primary', updateId: 70, chatId: '7001', routingClass: 'MESSAGE',
      payload: { message: { caption: 'album', photo: [{ file_id: 'one' }] } }, receivedAtMs: NOW,
    })
    const second = inbox.ingest({
      botId: 'primary', updateId: 71, chatId: '7001', routingClass: 'MESSAGE',
      payload: { message: { photo: [{ file_id: 'two' }] } }, receivedAtMs: NOW + 50,
    })
    inbox.registerAlbumFragment({
      updateRowId: first.update.id, mediaGroupId: 'media-1', readyAtMs: NOW + 2_000, nowMs: NOW,
    })
    inbox.registerAlbumFragment({
      updateRowId: second.update.id, mediaGroupId: 'media-1', readyAtMs: NOW + 2_050, nowMs: NOW + 50,
    })

    expect(inbox.claimNext({ workerId: 'early', nowMs: NOW + 2_049, leaseDurationMs: LEASE_MS })).toBeNull()
    database.close()
    database = openDurableDatabase(filename)
    inbox = new SqliteInboxRepository(database)

    const leader = inbox.claimNext({
      workerId: 'album', nowMs: NOW + 2_050, leaseDurationMs: LEASE_MS,
    })
    expect(leader?.id).toBe(first.update.id)
    expect(inbox.albumFragmentsFor(first.update.id).map((item) => item.updateId)).toEqual([70, 71])
    expect(inbox.claimNext({ workerId: 'sibling', nowMs: NOW + 2_050, leaseDurationMs: LEASE_MS })).toBeNull()

    inbox.markProcessed(first.update.id, 'album', NOW + 2_051)
    expect(inbox.get(first.update.id)?.state).toBe('PROCESSED')
    expect(inbox.get(second.update.id)?.state).toBe('PROCESSED')
    expect(database.query<{ state: string }, []>('SELECT state FROM telegram_album_groups').get()?.state)
      .toBe('PROCESSED')
  })

  test('releases an album as one unit on retry and expired lease recovery', () => {
    const inbox = new SqliteInboxRepository(database)
    const first = inbox.ingest({
      botId: 'primary', updateId: 80, chatId: '7001', routingClass: 'MESSAGE', payload: {},
      receivedAtMs: NOW,
    })
    const second = inbox.ingest({
      botId: 'primary', updateId: 81, chatId: '7001', routingClass: 'MESSAGE', payload: {},
      receivedAtMs: NOW,
    })
    for (const update of [first.update, second.update]) {
      inbox.registerAlbumFragment({
        updateRowId: update.id, mediaGroupId: 'media-retry', readyAtMs: NOW, nowMs: NOW,
      })
    }
    expect(inbox.claimNext({ workerId: 'first', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id)
      .toBe(first.update.id)
    inbox.retry(first.update.id, 'first', 'temporary', NOW + 500)
    expect(inbox.claimNext({ workerId: 'early', nowMs: NOW + 499, leaseDurationMs: LEASE_MS })).toBeNull()
    expect(inbox.claimNext({ workerId: 'second', nowMs: NOW + 500, leaseDurationMs: LEASE_MS })?.id)
      .toBe(first.update.id)

    expect(inbox.recoverExpiredLeases(NOW + 500 + LEASE_MS)).toBe(1)
    expect(inbox.claimNext({
      workerId: 'recovered', nowMs: NOW + 500 + LEASE_MS, leaseDurationMs: LEASE_MS,
    })?.id).toBe(first.update.id)
  })

  test('keeps a fragment that arrives after album processing as an isolated message', () => {
    const inbox = new SqliteInboxRepository(database)
    const first = inbox.ingest({
      botId: 'primary', updateId: 90, chatId: '7001', routingClass: 'MESSAGE', payload: {},
      receivedAtMs: NOW,
    })
    inbox.registerAlbumFragment({
      updateRowId: first.update.id, mediaGroupId: 'media-late', readyAtMs: NOW, nowMs: NOW,
    })
    inbox.claimNext({ workerId: 'album', nowMs: NOW, leaseDurationMs: LEASE_MS })

    const late = inbox.ingest({
      botId: 'primary', updateId: 91, chatId: '7001', routingClass: 'MESSAGE', payload: {},
      receivedAtMs: NOW + 1,
    })
    expect(inbox.registerAlbumFragment({
      updateRowId: late.update.id,
      mediaGroupId: 'media-late',
      readyAtMs: NOW + 2_001,
      nowMs: NOW + 1,
    })).toEqual({ grouped: false, leaderUpdateRowId: first.update.id })

    inbox.markProcessed(first.update.id, 'album', NOW + 2)
    expect(inbox.claimNext({ workerId: 'late', nowMs: NOW + 2, leaseDurationMs: LEASE_MS })?.id)
      .toBe(late.update.id)
  })

  test('prioritizes controls and preserves queued-message FIFO per chat', () => {
    let inbox = new SqliteInboxRepository(database)
    const first = inbox.ingest({
      botId: 'primary', updateId: 100, chatId: '7001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: NOW,
    })
    const second = inbox.ingest({
      botId: 'primary', updateId: 101, chatId: '7001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: NOW,
    })
    const third = inbox.ingest({
      botId: 'primary', updateId: 102, chatId: '7001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: NOW,
    })

    expect(inbox.claimNext({ workerId: 'active', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id).toBe(
      first.update.id,
    )
    expect(inbox.claimNext({ workerId: 'queue', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id).toBe(
      second.update.id,
    )
    const deferred = inbox.deferQueued(second.update.id, 'queue', NOW + 500)
    expect(deferred.routingClass).toBe('QUEUED_MESSAGE')
    expect(deferred.attemptCount).toBe(0)

    database.close()
    database = openDurableDatabase(filename)
    inbox = new SqliteInboxRepository(database)

    const otherChat = inbox.ingest({
      botId: 'primary', updateId: 103, chatId: '8001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: NOW,
    })
    const control = inbox.ingest({
      botId: 'primary', updateId: 104, chatId: '7001', routingClass: 'CONTROL',
      payload: {}, receivedAtMs: NOW,
    })
    expect(inbox.claimNext({ workerId: 'control', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id).toBe(
      control.update.id,
    )
    inbox.markProcessed(control.update.id, 'control', NOW)
    expect(inbox.claimNext({ workerId: 'other', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id).toBe(
      otherChat.update.id,
    )
    inbox.markProcessed(otherChat.update.id, 'other', NOW)
    expect(inbox.claimNext({ workerId: 'blocked', nowMs: NOW, leaseDurationMs: LEASE_MS })).toBeNull()

    const resumed = inbox.claimNext({
      workerId: 'queue-2', nowMs: NOW + 500, leaseDurationMs: LEASE_MS,
    })
    expect(resumed?.id).toBe(second.update.id)
    expect(resumed?.attemptCount).toBe(1)
    inbox.markProcessed(second.update.id, 'queue-2', NOW + 500)
    expect(inbox.claimNext({
      workerId: 'third', nowMs: NOW + 500, leaseDurationMs: LEASE_MS,
    })?.id).toBe(third.update.id)
  })
})

describe('SqliteOutboxRepository', () => {
  test('deduplicates logical sends by source key', () => {
    const outbox = new SqliteOutboxRepository(database)
    const first = outbox.enqueue({
      id: 'job-1',
      sourceKey: 'turn:abc:final',
      kind: 'send_text',
      payload: { chatId: '1001', text: 'first' },
      createdAtMs: NOW,
    })
    const duplicate = outbox.enqueue({
      id: 'job-2',
      sourceKey: 'turn:abc:final',
      kind: 'send_text',
      payload: { chatId: '1001', text: 'duplicate' },
      createdAtMs: NOW + 1,
    })

    expect(first.created).toBe(true)
    expect(duplicate.created).toBe(false)
    expect(duplicate.job.id).toBe('job-1')
    expect(duplicate.job.payload).toEqual({ chatId: '1001', text: 'first' })
  })

  test('leases a delivery chain strictly in order and waits on ambiguity', () => {
    const outbox = new SqliteOutboxRepository(database)
    expect(() => outbox.enqueue({
      sourceKey: 'turn:long:orphan',
      dependsOnSourceKey: 'turn:long:missing',
      kind: 'send_text',
      payload: { text: 'orphan' },
      createdAtMs: NOW,
    })).toThrow()
    const head = outbox.enqueue({
      id: 'chain-head',
      sourceKey: 'turn:long:final',
      kind: 'send_text',
      payload: { text: 'part 1' },
      createdAtMs: NOW,
    }).job
    const tail = outbox.enqueue({
      id: 'chain-tail',
      sourceKey: 'turn:long:final:chunk:2',
      dependsOnSourceKey: head.sourceKey,
      kind: 'send_text',
      payload: { text: 'part 2' },
      createdAtMs: NOW + 1,
    }).job
    expect(tail.dependsOnSourceKey).toBe(head.sourceKey)

    expect(outbox.claimNext({
      workerId: 'sender-head', nowMs: NOW, leaseDurationMs: LEASE_MS,
    })?.id).toBe(head.id)
    outbox.markSendStarted(head.id, 'sender-head', NOW)
    expect(outbox.failLease(head.id, 'sender-head', 'unknown result', NOW).becameAmbiguous).toBe(true)
    expect(outbox.claimNext({
      workerId: 'sender-tail', nowMs: NOW + 1, leaseDurationMs: LEASE_MS,
    })).toBeNull()

    expect(outbox.actOnProblem({
      operationKey: 'resolve-chain-head',
      jobId: head.id,
      action: 'RESOLVE',
      actorBotId: 'primary',
      actorChatId: '7001',
      remoteId: 'telegram:501',
      nowMs: NOW + 2,
    }).outcome).toBe('applied')
    expect(outbox.claimNext({
      workerId: 'sender-tail', nowMs: NOW + 2, leaseDurationMs: LEASE_MS,
    })?.id).toBe(tail.id)
  })

  test('archives every blocked descendant when a chain predecessor is abandoned', () => {
    const outbox = new SqliteOutboxRepository(database)
    const inputs = [
      { id: 'archive-head', sourceKey: 'archive:head', dependsOnSourceKey: null },
      { id: 'archive-middle', sourceKey: 'archive:middle', dependsOnSourceKey: 'archive:head' },
      { id: 'archive-tail', sourceKey: 'archive:tail', dependsOnSourceKey: 'archive:middle' },
    ]
    for (const input of inputs) {
      outbox.enqueue({
        ...input,
        kind: 'send_text',
        payload: { text: input.id },
        createdAtMs: NOW,
      })
    }
    outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.failLease('archive-head', 'sender', 'terminal failure', NOW)
    expect(outbox.actOnProblem({
      operationKey: 'archive-chain-head',
      jobId: 'archive-head',
      action: 'ARCHIVE',
      actorBotId: 'primary',
      actorChatId: '7001',
      nowMs: NOW + 1,
    }).outcome).toBe('applied')
    expect(outbox.get('archive-middle')?.state).toBe('ARCHIVED')
    expect(outbox.get('archive-tail')?.state).toBe('ARCHIVED')
  })

  test('lists and audits idempotent manual problem actions', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'failed-job',
      sourceKey: 'problem:failed',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'retry me' },
      expiresAtMs: NOW + 1,
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.failLease('failed-job', 'sender-a', 'bounded retries exhausted', NOW)

    expect(outbox.listProblems('FAILED')).toHaveLength(1)
    const retried = outbox.actOnProblem({
      operationKey: 'telegram:primary:200:command:retry',
      jobId: 'failed-job',
      action: 'RETRY',
      actorBotId: 'primary',
      actorChatId: '7001',
      nowMs: NOW + 10,
    })
    expect(retried).toMatchObject({
      outcome: 'applied',
      job: {
        id: 'failed-job',
        state: 'PENDING',
        attemptCount: 0,
        expiresAtMs: null,
      },
    })
    expect(outbox.actOnProblem({
      operationKey: 'telegram:primary:200:command:retry',
      jobId: 'failed-job',
      action: 'RETRY',
      actorBotId: 'primary',
      actorChatId: '7001',
      nowMs: NOW + 20,
    }).outcome).toBe('replayed')
    expect(() => outbox.actOnProblem({
      operationKey: 'telegram:primary:200:command:retry',
      jobId: 'failed-job',
      action: 'RETRY',
      actorBotId: 'primary',
      actorChatId: 'attacker',
      nowMs: NOW + 20,
    })).toThrow('replayed with different input')
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_problem_actions',
    ).get()?.count).toBe(1)
  })

  test('resolves or archives problems but never retries AMBIGUOUS implicitly', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'ambiguous-job', sourceKey: 'problem:ambiguous', kind: 'send_text',
      payload: { chatId: '7001', text: 'maybe sent' }, createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.markSendStarted('ambiguous-job', 'sender-a', NOW + 1)
    outbox.failLease('ambiguous-job', 'sender-a', 'connection lost', NOW + 2)

    const unsafeRetry = outbox.actOnProblem({
      operationKey: 'telegram:primary:201:command:retry',
      jobId: 'ambiguous-job',
      action: 'RETRY',
      actorBotId: 'primary',
      actorChatId: '7001',
      nowMs: NOW + 3,
    })
    expect(unsafeRetry).toMatchObject({ outcome: 'invalid_state', job: { state: 'AMBIGUOUS' } })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_problem_actions',
    ).get()?.count).toBe(0)

    expect(outbox.actOnProblem({
      operationKey: 'telegram:primary:202:command:resolved',
      jobId: 'ambiguous-job',
      action: 'RESOLVE',
      actorBotId: 'primary',
      actorChatId: '7001',
      remoteId: '991',
      nowMs: NOW + 4,
    })).toMatchObject({
      outcome: 'applied',
      job: { state: 'DELIVERED', remoteId: '991' },
    })

    outbox.enqueue({
      id: 'archived-job', sourceKey: 'problem:archive', kind: 'send_text',
      payload: { chatId: '7001', text: 'archive me' }, createdAtMs: NOW + 5,
    })
    outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 5, leaseDurationMs: LEASE_MS })
    outbox.failLease('archived-job', 'sender-b', 'invalid payload', NOW + 6)
    expect(outbox.actOnProblem({
      operationKey: 'telegram:primary:203:command:archive',
      jobId: 'archived-job',
      action: 'ARCHIVE',
      actorBotId: 'primary',
      actorChatId: '7001',
      nowMs: NOW + 7,
    })).toMatchObject({ outcome: 'applied', job: { state: 'ARCHIVED' } })
  })

  test('renews only a live delivery lease owned by the same worker', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'heartbeat',
      sourceKey: 'test:heartbeat',
      kind: 'send_text',
      payload: {},
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })

    expect(
      outbox.renewLease('heartbeat', {
        workerId: 'sender-a',
        nowMs: NOW + 20_000,
        leaseDurationMs: LEASE_MS,
      }).leaseExpiresAtMs,
    ).toBe(NOW + 50_000)
    expect(() =>
      outbox.renewLease('heartbeat', {
        workerId: 'sender-b',
        nowMs: NOW + 20_001,
        leaseDurationMs: LEASE_MS,
      }),
    ).toThrow(LeaseConflictError)
  })

  test('retries a crash before send_started but quarantines a crash after it', () => {
    let outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'before-send',
      sourceKey: 'test:before-send',
      kind: 'send_text',
      payload: { text: 'safe to retry' },
      createdAtMs: NOW,
    })
    outbox.enqueue({
      id: 'after-send',
      sourceKey: 'test:after-send',
      kind: 'send_text',
      payload: { text: 'outcome unknown' },
      createdAtMs: NOW + 1,
    })

    expect(outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })?.id).toBe(
      'before-send',
    )
    expect(outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 1, leaseDurationMs: LEASE_MS })?.id).toBe(
      'after-send',
    )
    outbox.markSendStarted('after-send', 'sender-b', NOW + 2)

    database.close()
    database = openDurableDatabase(filename)
    outbox = new SqliteOutboxRepository(database)

    const recovery = outbox.recoverExpiredLeases(NOW + LEASE_MS + 2)
    expect(recovery).toEqual({ retryable: 1, ambiguous: 1, expired: 0 })
    expect(outbox.get('before-send')?.state).toBe('PENDING')
    expect(outbox.get('after-send')?.state).toBe('AMBIGUOUS')

    expect(
      outbox.claimNext({ workerId: 'sender-c', nowMs: NOW + LEASE_MS + 2, leaseDurationMs: LEASE_MS })?.id,
    ).toBe('before-send')
    expect(outbox.claimNext({ workerId: 'sender-c', nowMs: NOW + 100_000, leaseDurationMs: LEASE_MS })).toBeNull()
  })

  test('requires remote proof for DELIVERED and persists it', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'delivered',
      sourceKey: 'test:delivered',
      kind: 'send_text',
      payload: { text: 'hello' },
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.markSendStarted('delivered', 'sender-a', NOW + 1)

    expect(() => outbox.markDelivered('delivered', 'sender-a', '   ', NOW + 2)).toThrow(
      'remoteId is required delivery proof',
    )
    const delivered = outbox.markDelivered('delivered', 'sender-a', 'telegram-message:987', NOW + 3)
    expect(delivered.state).toBe('DELIVERED')
    expect(delivered.remoteId).toBe('telegram-message:987')
    expect(delivered.leaseOwner).toBeNull()
  })

  test('never turns a post-send failure back into an automatic retry', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'uncertain',
      sourceKey: 'test:uncertain',
      kind: 'send_text',
      payload: {},
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.markSendStarted('uncertain', 'sender-a', NOW + 1)
    const failure = outbox.failLease(
      'uncertain',
      'sender-a',
      'connection reset after request write',
      NOW + 2,
      NOW + 60_000,
    )

    expect(failure.becameAmbiguous).toBe(true)
    expect(failure.job.state).toBe('AMBIGUOUS')
    expect(outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 60_000, leaseDurationMs: LEASE_MS })).toBeNull()
  })

  test('honours retry delay and TTL before leasing a job', () => {
    const outbox = new SqliteOutboxRepository(database)
    outbox.enqueue({
      id: 'retry-me',
      sourceKey: 'test:retry',
      kind: 'send_text',
      payload: {},
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    const failed = outbox.failLease('retry-me', 'sender-a', '429', NOW + 1, NOW + 5_000)
    expect(failed.becameAmbiguous).toBe(false)
    expect(failed.job.state).toBe('RETRY_WAIT')
    expect(outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 4_999, leaseDurationMs: LEASE_MS })).toBeNull()
    expect(outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 5_000, leaseDurationMs: LEASE_MS })?.id).toBe(
      'retry-me',
    )

    outbox.enqueue({
      id: 'expired',
      sourceKey: 'test:expired',
      kind: 'send_text',
      payload: {},
      createdAtMs: NOW + 10_000,
      expiresAtMs: NOW + 10_001,
    })
    outbox.recoverExpiredLeases(NOW + 10_001)
    expect(outbox.get('expired')?.state).toBe('EXPIRED')
  })

  test('expires a pre-send leased job at TTL but keeps a post-send job ambiguous', () => {
    const outbox = new SqliteOutboxRepository(database)
    for (const [index, id] of ['ttl-before-send', 'ttl-after-send'].entries()) {
      outbox.enqueue({
        id,
        sourceKey: `test:${id}`,
        kind: 'send_text',
        payload: {},
        createdAtMs: NOW + index,
        expiresAtMs: NOW + 1_000,
      })
    }
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: LEASE_MS })
    outbox.claimNext({ workerId: 'sender-b', nowMs: NOW + 1, leaseDurationMs: LEASE_MS })
    outbox.markSendStarted('ttl-after-send', 'sender-b', NOW + 1)

    expect(outbox.recoverExpiredLeases(NOW + LEASE_MS + 1)).toEqual({
      retryable: 0,
      ambiguous: 1,
      expired: 1,
    })
    expect(outbox.get('ttl-before-send')?.state).toBe('EXPIRED')
    expect(outbox.get('ttl-after-send')?.state).toBe('AMBIGUOUS')
  })
})
