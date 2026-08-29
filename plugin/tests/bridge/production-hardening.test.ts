import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteInboxRepository } from '../../src/durable/sqlite-repositories.js'
import { DurableTelegramRateLimiter } from '../../src/telegram/durable-rate-limiter.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function databaseFixture(): { path: string; database: Database } {
  const root = mkdtempSync(join(tmpdir(), 'dashi-production-chaos-'))
  roots.push(root)
  const path = join(root, 'bridge.sqlite3')
  return { path, database: openDurableDatabase(path) }
}

describe('M5 production fault gates', () => {
  test('survives a burst with duplicates and preserves every unique update', () => {
    const { database } = databaseFixture()
    const inbox = new SqliteInboxRepository(database)
    const count = 1_000
    for (let updateId = 1; updateId <= count; updateId += 1) {
      const first = inbox.ingest({
        botId: 'burst',
        updateId,
        chatId: '1',
        payload: { update_id: updateId, message: { text: 'burst' } },
        receivedAtMs: updateId,
      })
      const duplicate = inbox.ingest({
        botId: 'burst',
        updateId,
        chatId: '1',
        payload: { update_id: updateId, message: { text: 'duplicate' } },
        receivedAtMs: updateId + 1,
      })
      expect(first.created).toBeTrue()
      expect(duplicate.created).toBeFalse()
    }
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_updates',
    ).get()?.count).toBe(count)
    database.close()
  })

  test('keeps acknowledged rows intact when SQLite reports disk full', () => {
    const { path, database } = databaseFixture()
    const inbox = new SqliteInboxRepository(database)
    inbox.ingest({ botId: 'disk', updateId: 1, payload: { acknowledged: true } })
    const pageCount = Object.values(
      database.query<Record<string, number>, []>('PRAGMA page_count').get() ?? {},
    )[0]
    expect(pageCount).toBeNumber()
    database.run(`PRAGMA max_page_count = ${String(pageCount)}`)
    expect(() => inbox.ingest({
      botId: 'disk',
      updateId: 2,
      payload: { body: 'x'.repeat(2 * 1024 * 1024) },
    })).toThrow(/full/i)
    database.close()

    const reopened = openDurableDatabase(path)
    expect(reopened.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM telegram_updates WHERE bot_id='disk' AND update_id=1",
    ).get()?.count).toBe(1)
    reopened.close()
  })

  test('fails writes closed on a read-only SQLite connection', () => {
    const { path, database } = databaseFixture()
    new SqliteInboxRepository(database).ingest({
      botId: 'readonly',
      updateId: 1,
      payload: { persisted: true },
    })
    database.close()
    const readonly = new Database(path, { readonly: true, strict: true })
    expect(() => new SqliteInboxRepository(readonly).ingest({
      botId: 'readonly',
      updateId: 2,
      payload: { mustNotPersist: true },
    })).toThrow(/read.?only/i)
    expect(readonly.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_updates',
    ).get()?.count).toBe(1)
    readonly.close()
  })

  test('does not retry non-429 network timeouts forever', async () => {
    let attempts = 0
    const limiter = new DurableTelegramRateLimiter({
      maxAttempts: 10,
      sleep: async () => undefined,
    })
    const timeout = new DOMException('request timed out', 'TimeoutError')
    await expect(limiter.run('getUpdates', async () => {
      attempts += 1
      throw timeout
    })).rejects.toBe(timeout)
    expect(attempts).toBe(1)
  })
})
