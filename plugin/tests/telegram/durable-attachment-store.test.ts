import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type { IncomingTelegramAttachment } from '../../src/bridge/contracts.js'
import { SqliteAttachmentRepository } from '../../src/durable/attachment-repository.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteInboxRepository } from '../../src/durable/sqlite-repositories.js'
import {
  AttachmentDownloadLimitError,
  DurableAttachmentStore,
  type TelegramAttachmentDownload,
} from '../../src/telegram/durable-attachment-store.js'

const NOW = 1_800_000_000_000

class FakeAttachmentApi {
  calls = 0
  failure: Error | undefined
  download: TelegramAttachmentDownload = {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
    fileSize: 5,
    uniqueId: 'unique-1',
  }

  async downloadAttachment(): Promise<TelegramAttachmentDownload> {
    this.calls += 1
    if (this.failure !== undefined) throw this.failure
    return this.download
  }
}

let root: string
let filename: string
let database: Database
let sourceUpdateId: number
let api: FakeAttachmentApi

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-durable-attachment-'))
  filename = join(root, 'bridge.sqlite3')
  database = openDurableDatabase(filename)
  sourceUpdateId = new SqliteInboxRepository(database).ingest({
    botId: 'primary',
    updateId: 501,
    chatId: '7001',
    payload: { update_id: 501 },
    receivedAtMs: NOW,
  }).update.id
  api = new FakeAttachmentApi()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function image(overrides: Partial<IncomingTelegramAttachment> = {}): IncomingTelegramAttachment {
  return {
    kind: 'image',
    fileId: 'telegram-file-1',
    uniqueId: 'unique-1',
    fileName: '../../unsafe\nname.jpg',
    mimeType: 'image/jpeg',
    declaredSize: 5,
    ...overrides,
  }
}

function store(maxBytes = 1024): DurableAttachmentStore {
  return new DurableAttachmentStore(api, new SqliteAttachmentRepository(database), {
    directory: join(root, 'attachments'),
    maxBytes,
    now: () => NOW,
  })
}

describe('DurableAttachmentStore', () => {
  test('writes a validated attachment atomically with private permissions', async () => {
    const result = await store().materialize(sourceUpdateId, 0, image())
    expect(result.outcome).toBe('accepted')
    if (result.outcome !== 'accepted') return

    expect(result.attachment).toMatchObject({
      kind: 'image',
      fileName: 'unsafe_name.jpg',
      mimeType: 'image/jpeg',
      size: 5,
    })
    expect(result.attachment.path.startsWith(join(root, 'attachments'))).toBe(true)
    expect(statSync(result.attachment.path).mode & 0o777).toBe(0o600)
    expect(
      database.query<{ state: string; local_path: string }, []>(
        'SELECT state, local_path FROM telegram_attachments',
      ).get(),
    ).toEqual({ state: 'READY', local_path: result.attachment.path })
  })

  test('reuses durable READY proof after database restart without downloading again', async () => {
    const first = await store().materialize(sourceUpdateId, 0, image())
    expect(first.outcome).toBe('accepted')
    expect(api.calls).toBe(1)

    database.close()
    database = openDurableDatabase(filename)
    const second = await store().materialize(sourceUpdateId, 0, image())
    expect(second).toEqual(first)
    expect(api.calls).toBe(1)
  })

  test('does not trust a same-size READY file after its contents are replaced', async () => {
    const first = await store().materialize(sourceUpdateId, 0, image())
    if (first.outcome !== 'accepted') throw new Error('fixture attachment was rejected')
    writeFileSync(first.attachment.path, new Uint8Array([0, 0, 0, 0, 0]), { mode: 0o600 })

    const repaired = await store().materialize(sourceUpdateId, 0, image())
    expect(repaired).toEqual(first)
    expect(api.calls).toBe(2)
  })

  test('rejects disallowed MIME and declared/streamed oversize before Codex', async () => {
    expect(await store().materialize(sourceUpdateId, 0, image({
      kind: 'file',
      mimeType: 'application/x-msdownload',
    }))).toEqual({ outcome: 'rejected', reason: 'mime_not_allowed' })
    expect(api.calls).toBe(0)

    const nextUpdate = new SqliteInboxRepository(database).ingest({
      botId: 'primary',
      updateId: 502,
      payload: { update_id: 502 },
      receivedAtMs: NOW,
    }).update.id
    expect(await store(4).materialize(nextUpdate, 0, image())).toEqual({
      outcome: 'rejected',
      reason: 'size_limit',
    })
    expect(api.calls).toBe(0)

    const streamedUpdate = new SqliteInboxRepository(database).ingest({
      botId: 'primary',
      updateId: 503,
      payload: { update_id: 503 },
      receivedAtMs: NOW,
    }).update.id
    api.failure = new AttachmentDownloadLimitError()
    expect(await store().materialize(streamedUpdate, 0, image({ declaredSize: null }))).toEqual({
      outcome: 'rejected',
      reason: 'size_limit',
    })
  })

  test('rejects MIME spoofing but retries transient download failures from PENDING', async () => {
    api.download = {
      bytes: new TextEncoder().encode('MZ executable'),
      fileSize: 13,
      uniqueId: 'unique-1',
    }
    expect(await store().materialize(sourceUpdateId, 0, image({
      kind: 'file',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      declaredSize: 13,
    }))).toEqual({ outcome: 'rejected', reason: 'content_mismatch' })

    const nextUpdate = new SqliteInboxRepository(database).ingest({
      botId: 'primary',
      updateId: 504,
      payload: { update_id: 504 },
      receivedAtMs: NOW,
    }).update.id
    api.failure = new Error('temporary Telegram failure')
    await expect(store().materialize(nextUpdate, 0, image())).rejects.toThrow(
      'temporary Telegram failure',
    )
    expect(new SqliteAttachmentRepository(database).getBySource(nextUpdate, 0)?.state).toBe(
      'PENDING',
    )

    api.failure = undefined
    api.download = {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      fileSize: 5,
      uniqueId: 'unique-1',
    }
    expect((await store().materialize(nextUpdate, 0, image())).outcome).toBe('accepted')
  })
})
