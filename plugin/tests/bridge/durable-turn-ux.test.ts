import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { DurableTurnUxProjector } from '../../src/bridge/durable-turn-ux.js'
import type { TextTurnOperation } from '../../src/bridge/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

let root: string
let database: Database
let sessions: SqliteSessionRepository
let outbox: SqliteOutboxRepository
let nowMs: number

const operation: TextTurnOperation = {
  operationKey: 'telegram:primary:701:turn',
  inboxUpdateId: 701,
  botId: 'primary',
  updateId: 701,
  chatId: '7001',
  projectId: 'workspace',
  text: 'private prompt must never enter UX state',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-turn-ux-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  sessions = new SqliteSessionRepository(database)
  outbox = new SqliteOutboxRepository(database)
  nowMs = NOW
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('DurableTurnUxProjector', () => {
  test('persists payload-free HUD facts and emits one ordered edit chain', () => {
    const ux = new DurableTurnUxProjector(database, outbox, sessions, {
      now: () => nowMs,
      chatStatusMessages: true,
      heartbeatAfterMs: 60_000,
      heartbeatIntervalMs: 60_000,
    })
    ux.onPreparing(operation, {
      model: 'gpt-test', effort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    })
    ux.onThreadReady(operation, 'thread-private-but-opaque')
    ux.onTurnStarted(operation, 'thread-private-but-opaque', 'turn-1')
    ux.onProgress(operation, {
      kind: 'plan', threadId: 'thread-private-but-opaque', turnId: 'turn-1',
      completed: 1, total: 3, atMs: nowMs,
    })
    ux.onProgress(operation, {
      kind: 'usage', threadId: 'thread-private-but-opaque', turnId: 'turn-1',
      totalTokens: 4_000, inputTokens: 3_000, cachedInputTokens: 2_500,
      outputTokens: 1_000, threadTotalTokens: 12_000,
      contextWindow: 20_000, atMs: nowMs,
    })
    nowMs += 61_000
    expect(ux.runHeartbeat()).toBe(1)
    ux.onCompleted(operation, {
      threadId: 'thread-private-but-opaque', turnId: 'turn-1', finalText: 'private final',
    })

    expect(ux.getStatus('primary', '7001', 'workspace')).toMatchObject({
      phase: 'COMPLETED',
      planCompleted: 1,
      planTotal: 3,
      totalTokens: 4_000,
      inputTokens: 3_000,
      cachedInputTokens: 2_500,
      threadTotalTokens: 12_000,
      contextWindow: 20_000,
    })
    const persisted = database.query<Record<string, unknown>, []>(
      'SELECT * FROM codex_turn_ux',
    ).get()
    expect(JSON.stringify(persisted)).not.toContain('private prompt')
    expect(JSON.stringify(persisted)).not.toContain('private final')

    const jobs = database.query<{
      source_key: string
      depends_on_source_key: string | null
      payload_json: string
    }, []>(
      `SELECT source_key, depends_on_source_key, payload_json
       FROM delivery_jobs ORDER BY created_at_ms, rowid`,
    ).all()
    expect(jobs.length).toBeGreaterThanOrEqual(6)
    expect(jobs[0]?.depends_on_source_key).toBeNull()
    for (let index = 1; index < jobs.length; index += 1) {
      expect(jobs[index]?.depends_on_source_key).toBe(jobs[index - 1]?.source_key)
    }
    expect(jobs.some((job) => job.payload_json.includes('Heartbeat:'))).toBe(true)
    expect(jobs.at(-1)?.payload_json).toContain('Codex · готово')
  })

  test('reconciles an active status to UNKNOWN after durable turn recovery', () => {
    const ux = new DurableTurnUxProjector(database, outbox, sessions, {
      now: () => nowMs,
      chatStatusMessages: true,
    })
    const accepted = new SqliteInboxRepository(database).ingest({
      botId: 'primary', updateId: 701, chatId: '7001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: nowMs,
    })
    const recoveredOperation = { ...operation, inboxUpdateId: accepted.update.id }
    const prepared = sessions.prepareTextOperation(recoveredOperation, 'codex', nowMs)
    ux.onPreparing(recoveredOperation, {})
    sessions.markDispatching(prepared.turn.id, 'codex', 'thread-1', true, nowMs)
    sessions.markBackendTurnStarted(prepared.turn.id, 'turn-1', 'codex', 'thread-1', nowMs)
    ux.onThreadReady(recoveredOperation, 'thread-1')
    ux.onTurnStarted(recoveredOperation, 'thread-1', 'turn-1')
    sessions.markTerminal(prepared.turn.id, 'UNKNOWN', 'AppServerClosedError', nowMs)

    expect(ux.recoverStartup()).toBe(1)
    expect(ux.getStatus('primary', '7001', 'workspace')?.phase).toBe('UNKNOWN')
    expect(database.query<{ payload_json: string }, []>(
      `SELECT payload_json FROM delivery_jobs ORDER BY rowid DESC LIMIT 1`,
    ).get()?.payload_json).toContain('Codex · нужна проверка')
  })

  test('keeps telemetry for /status without posting lifecycle cards by default', () => {
    const ux = new DurableTurnUxProjector(database, outbox, sessions, { now: () => nowMs })

    ux.onPreparing(operation, {
      model: 'gpt-test', effort: 'high', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    })
    ux.onThreadReady(operation, 'thread-1')
    ux.onTurnStarted(operation, 'thread-1', 'turn-1')
    ux.onProgress(operation, {
      kind: 'usage', threadId: 'thread-1', turnId: 'turn-1',
      totalTokens: 4_000, inputTokens: 3_000, cachedInputTokens: 2_500,
      outputTokens: 1_000, threadTotalTokens: 12_000,
      contextWindow: 20_000, atMs: nowMs,
    })
    ux.onCompleted(operation, { threadId: 'thread-1', turnId: 'turn-1', finalText: 'done' })

    expect(ux.getStatus('primary', '7001', 'workspace')).toMatchObject({
      phase: 'COMPLETED',
      totalTokens: 4_000,
      inputTokens: 3_000,
      cachedInputTokens: 2_500,
      threadTotalTokens: 12_000,
      contextWindow: 20_000,
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_jobs',
    ).get()?.count).toBe(0)
  })
})
