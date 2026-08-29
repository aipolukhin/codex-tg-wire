import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { OutboxDeliveryWorker } from '../../src/bridge/outbox-delivery-worker.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'
import {
  DurableOutboundMediaStore,
  type PreparedLocalMedia,
  type TelegramMediaKind,
} from '../../src/telegram/durable-outbound-media.js'
import {
  DurableTelegramTextGateway,
  type TelegramAlbumUploadItem,
  type TelegramMediaOptions,
} from '../../src/telegram/durable-text-gateway.js'

const NOW = 1_800_000_000_000

class FakeMediaApi {
  readonly media: Array<{
    chatId: string
    kind: TelegramMediaKind
    path: string
    options: TelegramMediaOptions
  }> = []
  readonly albums: Array<{ chatId: string; items: readonly TelegramAlbumUploadItem[] }> = []
  failAlbum = false

  async sendMessage(): Promise<{ message_id: number }> {
    return { message_id: 1 }
  }

  async sendMedia(
    chatId: string,
    kind: TelegramMediaKind,
    media: PreparedLocalMedia,
    options: TelegramMediaOptions,
  ): Promise<{ message_id: number }> {
    this.media.push({ chatId, kind, path: media.path, options })
    return { message_id: 501 }
  }

  async sendMediaGroup(
    chatId: string,
    items: readonly TelegramAlbumUploadItem[],
  ): Promise<readonly { message_id: number }[]> {
    this.albums.push({ chatId, items })
    if (this.failAlbum) throw new Error('network result unknown')
    return items.map((_, index) => ({ message_id: 601 + index }))
  }
}

let root: string
let workspace: string
let spool: string
let filename: string
let database: Database
let outbox: SqliteOutboxRepository
let store: DurableOutboundMediaStore
let api: FakeMediaApi

function makeStore(): DurableOutboundMediaStore {
  return new DurableOutboundMediaStore({
    directory: spool,
    allowedRoots: [workspace],
    maxBytes: 1024 * 1024,
  })
}

function makeGateway(): DurableTelegramTextGateway {
  return new DurableTelegramTextGateway(api, {
    allowedUserIds: ['7001'],
    allowedChatIds: ['7001'],
    defaultProjectId: 'workspace',
    extraSecrets: ['private-marker'],
    outboundMediaStore: store,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-media-gateway-'))
  workspace = join(root, 'workspace')
  spool = join(root, 'spool')
  filename = join(root, 'bridge.sqlite3')
  mkdirSync(workspace, { recursive: true })
  database = openDurableDatabase(filename)
  outbox = new SqliteOutboxRepository(database)
  store = makeStore()
  api = new FakeMediaApi()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable outbound media gateway', () => {
  test('reopens a persisted media reference after restart and returns Telegram proof', async () => {
    const source = join(workspace, 'report.pdf')
    writeFileSync(source, '%PDF-report')
    const reference = await store.register({
      path: source, fileName: 'report.pdf', mimeType: 'application/pdf', kind: 'document',
    })
    outbox.enqueue({
      id: 'media-job',
      sourceKey: 'turn:media:1',
      kind: 'send_media',
      payload: {
        chatId: '7001', mediaKind: 'document', reference,
        caption: '**Report** private-marker',
      },
      createdAtMs: NOW,
    })
    database.close()
    database = openDurableDatabase(filename)
    outbox = new SqliteOutboxRepository(database)
    store = makeStore()
    const gateway = makeGateway()

    const job = outbox.claimNext({ workerId: 'media', nowMs: NOW, leaseDurationMs: 60_000 })!
    const prepared = await gateway.prepareDelivery(job)
    expect(prepared).toMatchObject({
      kind: 'send_media',
      media: { sha256: reference.sha256, fileName: 'report.pdf' },
      options: { caption: '<b>Report</b> [REDACTED]', parse_mode: 'HTML' },
    })
    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:501' })
    expect(api.media).toHaveLength(1)
  })

  test('sends an album as one mutation with one atomic delivery proof', async () => {
    const firstPath = join(workspace, 'one.jpg')
    const secondPath = join(workspace, 'two.jpg')
    writeFileSync(firstPath, 'jpeg-one')
    writeFileSync(secondPath, 'jpeg-two')
    const first = await store.register({
      path: firstPath, mimeType: 'image/jpeg', kind: 'photo',
    })
    const second = await store.register({
      path: secondPath, mimeType: 'image/jpeg', kind: 'photo',
    })
    outbox.enqueue({
      id: 'album-job',
      sourceKey: 'turn:album:1',
      kind: 'send_album',
      payload: {
        chatId: '7001',
        items: [
          { mediaKind: 'photo', reference: first, caption: '**One**' },
          { mediaKind: 'photo', reference: second },
        ],
      },
      createdAtMs: NOW,
    })
    const gateway = makeGateway()
    const job = outbox.claimNext({ workerId: 'album', nowMs: NOW, leaseDurationMs: 60_000 })!
    const prepared = await gateway.prepareDelivery(job)

    expect(await gateway.executeDelivery(prepared)).toEqual({
      remoteId: 'telegram-album:601,602',
    })
    expect(api.albums).toHaveLength(1)
    expect(api.albums[0]?.items).toHaveLength(2)
  })

  test('quarantines an uncertain album call and never retries the group automatically', async () => {
    const paths = [join(workspace, 'one.jpg'), join(workspace, 'two.jpg')]
    paths.forEach((path, index) => writeFileSync(path, `jpeg-${index}`))
    const references = await Promise.all(paths.map((path) => store.register({
      path, mimeType: 'image/jpeg', kind: 'photo',
    })))
    outbox.enqueue({
      id: 'ambiguous-album',
      sourceKey: 'turn:album:ambiguous',
      kind: 'send_album',
      payload: {
        chatId: '7001',
        items: references.map((reference) => ({ mediaKind: 'photo', reference })),
      },
      createdAtMs: NOW,
    })
    api.failAlbum = true
    const worker = new OutboxDeliveryWorker(outbox, makeGateway(), {
      workerId: 'album-worker', now: () => NOW,
    })

    expect(await worker.runOnce()).toMatchObject({ outcome: 'ambiguous', jobId: 'ambiguous-album' })
    expect(outbox.get('ambiguous-album')?.state).toBe('AMBIGUOUS')
    expect(await worker.runOnce()).toEqual({ outcome: 'idle' })
    expect(api.albums).toHaveLength(1)
  })

  test('detects spool tampering during preparation before send_started', async () => {
    const source = join(workspace, 'stable.txt')
    writeFileSync(source, 'stable bytes')
    const reference = await store.register({
      path: source, mimeType: 'text/plain', kind: 'document',
    })
    outbox.enqueue({
      id: 'tampered-media',
      sourceKey: 'turn:media:tampered',
      kind: 'send_media',
      payload: { chatId: '7001', mediaKind: 'document', reference },
      createdAtMs: NOW,
    })
    writeFileSync(reference.path, 'tamper bytes')
    const worker = new OutboxDeliveryWorker(outbox, makeGateway(), {
      workerId: 'media-worker', now: () => NOW,
    })

    expect(await worker.runOnce()).toMatchObject({ outcome: 'retry_wait', jobId: 'tampered-media' })
    expect(outbox.get('tampered-media')?.sendStartedAtMs).toBeNull()
    expect(api.media).toHaveLength(0)
  })
})
