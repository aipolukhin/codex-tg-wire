import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { createDurableTextRuntime, type DurableTextRuntime } from '../../src/bridge/text-runtime.js'
import { CodexAppServerClient } from '../../src/codex/app-server-client.js'
import type { OutboundMessage } from '../../src/codex/protocol.js'
import type {
  AppServerTransport,
  TransportClose,
} from '../../src/codex/transport.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'
import type { TelegramAttachmentDownload } from '../../src/telegram/durable-attachment-store.js'

const NOW = 1_800_000_000_000

class FakeTransport implements AppServerTransport {
  readonly sent: OutboundMessage[] = []
  readonly messages = new Set<(message: unknown) => void>()
  readonly closes = new Set<(close: TransportClose) => void>()
  closed = false

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onClose(listener: (close: TransportClose) => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  emit(message: unknown): void {
    for (const listener of this.messages) listener(message)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closes) listener({ code: 0, signal: null })
  }
}

class FakeTelegramApi {
  readonly sent: Array<{ chatId: string; text: string }> = []
  readonly downloads = new Map<string, TelegramAttachmentDownload>()
  readonly downloadCalls: string[] = []

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    this.sent.push({ chatId, text })
    return { message_id: 901 }
  }

  async downloadAttachment(fileId: string): Promise<TelegramAttachmentDownload> {
    this.downloadCalls.push(fileId)
    const download = this.downloads.get(fileId)
    if (download === undefined) throw new Error('fake Telegram file is unavailable')
    return download
  }
}

async function waitForRequest(transport: FakeTransport, method: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = transport.sent.find(
      (message) => 'method' in message && 'id' in message && message.method === method,
    )
    if (request !== undefined && 'id' in request) return request
    await Bun.sleep(1)
  }
  throw new Error(`${method} request not observed`)
}

let root: string
let database: Database
let transport: FakeTransport
let client: CodexAppServerClient
let telegram: FakeTelegramApi
let runtime: DurableTextRuntime

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dashi-text-runtime-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  transport = new FakeTransport()
  client = new CodexAppServerClient(transport)
  const initializing = client.initialize({
    clientInfo: { name: 'test', title: 'Test', version: '0.0.0' },
    capabilities: null,
  })
  const request = await waitForRequest(transport, 'initialize')
  transport.emit({
    id: request.id,
    result: {
      userAgent: 'fake/1',
      codexHome: '/tmp/codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  })
  await initializing
  telegram = new FakeTelegramApi()
  runtime = createDurableTextRuntime({
    database,
    codexClient: client,
    telegramApi: telegram,
    botId: 'primary',
    projects: [
      { id: 'workspace', cwd: '/srv/workspace' },
      { id: 'other', cwd: '/srv/other' },
    ],
    telegram: {
      allowedUserIds: ['7001'],
      allowedChatIds: ['7001'],
      defaultProjectId: 'workspace',
      attachmentDirectory: join(root, 'attachments'),
    },
    inboxWorker: { now: () => NOW },
    outboxWorker: { now: () => NOW },
  })
})

afterEach(async () => {
  runtime.close()
  await client.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable text runtime composition', () => {
  test('runs Telegram → SQLite → Codex App Server → SQLite → Telegram', async () => {
    const update = {
      update_id: 801,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: 'ответь коротко',
      },
    }
    const accepted = runtime.ingest(update, NOW)
    expect(accepted.created).toBe(true)
    expect(accepted.update).toMatchObject({ chatId: '7001', routingClass: 'MESSAGE' })
    expect(runtime.ingest(update, NOW + 1).created).toBe(false)

    const processing = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    expect(threadStart).toMatchObject({ params: { cwd: '/srv/workspace' } })
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-live' } } })

    const turnStart = await waitForRequest(transport, 'turn/start')
    expect(turnStart).toMatchObject({
      params: {
        threadId: 'thread-live',
        clientUserMessageId: 'telegram:primary:801:turn',
        input: [{ type: 'text', text: 'ответь коротко', text_elements: [] }],
      },
    })
    transport.emit({ id: turnStart.id, result: { turn: { id: 'turn-live' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-live',
        turnId: 'turn-live',
        item: { type: 'agentMessage', id: 'answer', text: 'Готово.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-live', turn: { id: 'turn-live', status: 'completed', items: [] } },
    })

    expect((await processing).outcome).toBe('enqueued')
    expect(await runtime.deliverOutboundOnce()).toEqual({
      outcome: 'delivered',
      jobId: expect.any(String),
      remoteId: 'telegram:901',
    })
    expect(telegram.sent).toEqual([{ chatId: '7001', text: 'Готово.' }])

    expect(
      database.query<{ state: string }, []>('SELECT state FROM telegram_updates').get()?.state,
    ).toBe('PROCESSED')
    expect(
      database.query<{ state: string }, []>('SELECT state FROM delivery_jobs').get()?.state,
    ).toBe('DELIVERED')
    expect(database.query<{ state: string }, []>('SELECT state FROM turns').get()?.state).toBe(
      'COMPLETED',
    )
  })

  test('rejects malformed update ids before touching SQLite', () => {
    expect(() => runtime.ingest({ update_id: -1 }, NOW)).toThrow('non-negative safe integer')
    expect(
      database.query<{ count: number }, []>('SELECT count(*) AS count FROM telegram_updates').get()?.count,
    ).toBe(0)
  })

  test('fails fast when the default Telegram project is not configured', () => {
    expect(() =>
      createDurableTextRuntime({
        database,
        codexClient: client,
        telegramApi: telegram,
        botId: 'primary',
        projects: [{ id: 'other', cwd: '/srv/other' }],
        telegram: {
          allowedUserIds: ['7001'],
          allowedChatIds: ['7001'],
          defaultProjectId: 'missing',
        },
      }),
    ).toThrow('default Telegram project is not configured')
  })

  test('routes /start through inbox and outbox without starting Codex', async () => {
    const accepted = runtime.ingest({
      update_id: 802,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/start',
      },
    }, NOW)
    expect(accepted.update).toMatchObject({ chatId: '7001', routingClass: 'CONTROL' })

    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect(
      transport.sent.some((message) => 'method' in message && message.method === 'thread/start'),
    ).toBe(false)
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect(telegram.sent[0]?.text).toContain('/new')
  })

  test('routes /failed through the durable problem center without exposing payloads', async () => {
    const outbox = new SqliteOutboxRepository(database)
    const problemId = '44444444-4444-4444-8444-444444444444'
    outbox.enqueue({
      id: problemId,
      sourceKey: 'turn:problem:final',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'private body' },
      createdAtMs: NOW,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs: NOW, leaseDurationMs: 60_000 })
    outbox.failLease(problemId, 'sender-a', 'private failure detail', NOW)

    runtime.ingest({
      update_id: 803,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/failed',
      },
    }, NOW)
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect(telegram.sent[0]?.text).toContain(problemId)
    expect(telegram.sent[0]?.text).not.toContain('private body')
    expect(telegram.sent[0]?.text).not.toContain('private failure detail')
  })

  test('/cwd selects a configured project for the next durable turn', async () => {
    runtime.ingest({
      update_id: 804,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/cwd other',
      },
    }, NOW)
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect(telegram.sent[0]?.text).toContain('Текущий проект: other')

    runtime.ingest({
      update_id: 805,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: 'работай в другом проекте',
      },
    }, NOW)
    const processing = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    expect(threadStart).toMatchObject({ params: { cwd: '/srv/other' } })
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-other' } } })
    const turnStart = await waitForRequest(transport, 'turn/start')
    transport.emit({ id: turnStart.id, result: { turn: { id: 'turn-other' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-other',
        turnId: 'turn-other',
        item: { type: 'agentMessage', id: 'other-answer', text: 'Готово.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-other',
        turn: { id: 'turn-other', status: 'completed', items: [] },
      },
    })
    expect((await processing).outcome).toBe('enqueued')
    expect(
      database.query<{ project_id: string }, []>('SELECT project_id FROM sessions').get()?.project_id,
    ).toBe('other')
  })

  test('downloads a photo durably, sends localImage and journals unknown events', async () => {
    telegram.downloads.set('photo-large', {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      fileSize: 5,
      uniqueId: 'photo-u1',
    })
    const accepted = runtime.ingest({
      update_id: 806,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        caption: 'проверь макет',
        photo: [{
          file_id: 'photo-large',
          file_unique_id: 'photo-u1',
          width: 1280,
          height: 720,
          file_size: 5,
        }],
      },
    }, NOW)
    expect(accepted.update.routingClass).toBe('MESSAGE')

    const processing = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-image' } } })
    const turnStart = await waitForRequest(transport, 'turn/start')
    expect(turnStart).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'проверь макет', text_elements: [] },
          { type: 'localImage', path: expect.stringContaining('/attachments/') },
        ],
      },
    })
    transport.emit({ id: turnStart.id, result: { turn: { id: 'turn-image' } } })
    transport.emit({
      method: 'future/progress',
      params: {
        threadId: 'thread-image',
        turnId: 'turn-image',
        privatePayload: 'must-not-be-stored',
      },
    })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-image',
        turnId: 'turn-image',
        item: { type: 'agentMessage', id: 'image-answer', text: 'Вижу.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-image',
        turn: { id: 'turn-image', status: 'completed', items: [] },
      },
    })
    expect((await processing).outcome).toBe('enqueued')
    expect(telegram.downloadCalls).toEqual(['photo-large'])
    expect(
      database.query<{ state: string; actual_size: number }, []>(
        'SELECT state, actual_size FROM telegram_attachments',
      ).get(),
    ).toEqual({ state: 'READY', actual_size: 5 })
    expect(
      database.query<{
        method: string
        occurrence_count: number
        thread_id: string
        turn_id: string
      }, []>(
        `SELECT method, occurrence_count, thread_id, turn_id
         FROM codex_unhandled_notifications`,
      ).get(),
    ).toEqual({
      method: 'future/progress',
      occurrence_count: 1,
      thread_id: 'thread-image',
      turn_id: 'turn-image',
    })
    expect(
      JSON.stringify(database.query<Record<string, unknown>, []>(
        'SELECT * FROM codex_unhandled_notifications',
      ).all()),
    ).not.toContain('must-not-be-stored')
  })

  test('rejects a disallowed document through durable outbox before Codex', async () => {
    const accepted = runtime.ingest({
      update_id: 807,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        document: {
          file_id: 'binary-1',
          file_unique_id: 'binary-u1',
          file_name: 'payload.exe',
          mime_type: 'application/x-msdownload',
          file_size: 100,
        },
      },
    }, NOW)
    expect(accepted.update.routingClass).toBe('MESSAGE')
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect(
      transport.sent.some((message) => 'method' in message && message.method === 'thread/start'),
    ).toBe(false)
    expect(telegram.downloadCalls).toEqual([])
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect(telegram.sent[0]?.text).toContain('тип вложения запрещён')
    expect(
      database.query<{ state: string; rejection_reason: string }, []>(
        'SELECT state, rejection_reason FROM telegram_attachments',
      ).get(),
    ).toEqual({ state: 'REJECTED', rejection_reason: 'mime_not_allowed' })
  })
})
