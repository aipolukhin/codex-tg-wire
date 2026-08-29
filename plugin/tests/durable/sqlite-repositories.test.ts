import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { LeaseConflictError } from '../../src/durable/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'

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
      'codex_interactions',
      'delivery_jobs',
      'schema_migrations',
      'sessions',
      'telegram_poll_cursors',
      'telegram_updates',
      'thread_bindings',
      'turns',
    ])

    database.close()
    database = openDurableDatabase(filename)
    const migrations = database
      .query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations')
      .get()
    expect(migrations?.count).toBe(5)
  })
})

describe('SqliteInboxRepository', () => {
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
