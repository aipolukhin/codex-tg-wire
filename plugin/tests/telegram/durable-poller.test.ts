import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type { IngestResult } from '../../src/durable/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqlitePollCursorRepository } from '../../src/durable/poll-cursor-repository.js'
import { SqliteInboxRepository } from '../../src/durable/sqlite-repositories.js'
import {
  DurableTelegramPoller,
  type TelegramGetUpdatesOptions,
} from '../../src/telegram/durable-poller.js'

const NOW = 1_800_000_000_000

class FakeUpdateSource {
  readonly requests: TelegramGetUpdatesOptions[] = []
  batches: unknown[][] = []

  async getUpdates(options: TelegramGetUpdatesOptions): Promise<unknown[]> {
    this.requests.push(options)
    return this.batches.shift() ?? []
  }
}

let root: string
let filename: string
let database: Database
let inbox: SqliteInboxRepository
let cursors: SqlitePollCursorRepository
let source: FakeUpdateSource

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-durable-poller-'))
  filename = join(root, 'bridge.sqlite3')
  database = openDurableDatabase(filename)
  inbox = new SqliteInboxRepository(database)
  cursors = new SqlitePollCursorRepository(database)
  source = new FakeUpdateSource()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function sink(): { ingest(update: unknown, receivedAtMs?: number): IngestResult } {
  return {
    ingest(update, receivedAtMs) {
      const updateId = (update as { update_id: number }).update_id
      return inbox.ingest({
        botId: 'primary',
        updateId,
        payload: update,
        ...(receivedAtMs === undefined ? {} : { receivedAtMs }),
      })
    },
  }
}

describe('SqlitePollCursorRepository', () => {
  test('is monotonic and survives database restart', () => {
    expect(cursors.get('primary')).toBeNull()
    expect(cursors.advance('primary', 12, NOW).nextUpdateId).toBe(12)
    expect(cursors.advance('primary', 10, NOW + 1).nextUpdateId).toBe(12)

    database.close()
    database = openDurableDatabase(filename)
    inbox = new SqliteInboxRepository(database)
    cursors = new SqlitePollCursorRepository(database)
    expect(cursors.get('primary')?.nextUpdateId).toBe(12)
  })
})

describe('DurableTelegramPoller', () => {
  test('persists every update before advancing the SQLite cursor', async () => {
    source.batches = [
      [
        { update_id: 11, message: { text: 'second' } },
        { update_id: 10, message: { text: 'first' } },
      ],
      [],
    ]
    const poller = new DurableTelegramPoller('primary', source, sink(), cursors, {
      timeoutSeconds: 0,
      now: () => NOW,
    })

    expect(await poller.pollOnce()).toEqual({
      fetched: 2,
      inserted: 2,
      duplicates: 0,
      nextUpdateId: 12,
    })
    expect(cursors.get('primary')?.nextUpdateId).toBe(12)
    expect(
      database.query<{ count: number }, []>('SELECT count(*) AS count FROM telegram_updates').get()?.count,
    ).toBe(2)

    await poller.pollOnce()
    expect(source.requests).toEqual([
      { timeout: 0, allowed_updates: ['message', 'callback_query'] },
      { timeout: 0, allowed_updates: ['message', 'callback_query'], offset: 12 },
    ])
  })

  test('replays a callback safely after crash between durable insert and cursor advance', async () => {
    const update = {
      update_id: 20,
      callback_query: {
        id: 'callback-replay',
        data: 'dx:a:abcdef123456:once',
        from: { id: 100 },
        message: { message_id: 5, chat: { id: 100, type: 'private' } },
      },
    }
    source.batches = [[update], [update]]
    const realSink = sink()
    let crash = true
    const crashingSink = {
      ingest(value: unknown, receivedAtMs?: number): IngestResult {
        const accepted = realSink.ingest(value, receivedAtMs)
        if (crash) {
          crash = false
          throw new Error('simulated crash after inbox commit')
        }
        return accepted
      },
    }
    const first = new DurableTelegramPoller('primary', source, crashingSink, cursors, {
      timeoutSeconds: 0,
      now: () => NOW,
    })
    await expect(first.pollOnce()).rejects.toThrow('simulated crash')
    expect(cursors.get('primary')).toBeNull()
    expect(
      database.query<{ count: number }, []>('SELECT count(*) AS count FROM telegram_updates').get()?.count,
    ).toBe(1)

    const restarted = new DurableTelegramPoller('primary', source, realSink, cursors, {
      timeoutSeconds: 0,
      now: () => NOW + 1,
    })
    expect(await restarted.pollOnce()).toEqual({
      fetched: 1,
      inserted: 0,
      duplicates: 1,
      nextUpdateId: 21,
    })
    expect(cursors.get('primary')?.nextUpdateId).toBe(21)
  })

  test('does not write cursor or inbox rows for malformed Bot API data', async () => {
    source.batches = [[{ message: { text: 'missing id' } }]]
    const poller = new DurableTelegramPoller('primary', source, sink(), cursors, {
      timeoutSeconds: 0,
    })
    await expect(poller.pollOnce()).rejects.toThrow('invalid update_id')
    expect(cursors.get('primary')).toBeNull()
    expect(
      database.query<{ count: number }, []>('SELECT count(*) AS count FROM telegram_updates').get()?.count,
    ).toBe(0)
  })

  test('deduplicates stale updates without regressing the cursor', async () => {
    source.batches = [[{ update_id: 30 }, { update_id: 31 }], [{ update_id: 30 }, { update_id: 32 }]]
    const poller = new DurableTelegramPoller('primary', source, sink(), cursors, {
      timeoutSeconds: 0,
      now: () => NOW,
    })
    await poller.pollOnce()
    expect(await poller.pollOnce()).toEqual({
      fetched: 2,
      inserted: 1,
      duplicates: 1,
      nextUpdateId: 33,
    })
    expect(cursors.get('primary')?.nextUpdateId).toBe(33)
  })
})
