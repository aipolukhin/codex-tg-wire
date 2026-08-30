import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import type { TelegramAttachmentDownload } from '../../src/telegram/durable-attachment-store.js'
import type {
  PreparedLocalMedia,
  TelegramMediaKind,
} from '../../src/telegram/durable-outbound-media.js'
import type { TelegramMediaOptions } from '../../src/telegram/durable-text-gateway.js'

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
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly downloads = new Map<string, TelegramAttachmentDownload>()
  readonly downloadCalls: string[] = []
  readonly media: Array<{
    chatId: string
    kind: TelegramMediaKind
    fileName: string
    options: TelegramMediaOptions
  }> = []
  readonly reactions: Array<{ chatId: string; messageId: number; emoji: '👀' }> = []

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    this.sent.push({ chatId, text })
    return { message_id: 900 + this.sent.length }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<true> {
    this.edits.push({ chatId, messageId, text })
    return true
  }

  async setMessageReaction(chatId: string, messageId: number, emoji: '👀'): Promise<true> {
    this.reactions.push({ chatId, messageId, emoji })
    return true
  }

  async downloadAttachment(fileId: string): Promise<TelegramAttachmentDownload> {
    this.downloadCalls.push(fileId)
    const download = this.downloads.get(fileId)
    if (download === undefined) throw new Error('fake Telegram file is unavailable')
    return download
  }

  async sendMedia(
    chatId: string,
    kind: TelegramMediaKind,
    media: PreparedLocalMedia,
    options: TelegramMediaOptions,
  ): Promise<{ message_id: number }> {
    this.media.push({ chatId, kind, fileName: media.fileName, options })
    return { message_id: 990 }
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

async function waitForRequestNumber(transport: FakeTransport, method: string, number: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requests = transport.sent.filter(
      (message) => 'method' in message && 'id' in message && message.method === method,
    )
    const request = requests[number - 1]
    if (request !== undefined && 'id' in request) return request
    await Bun.sleep(1)
  }
  throw new Error(`${method} request #${number} not observed`)
}

let root: string
let database: Database
let transport: FakeTransport
let client: CodexAppServerClient
let telegram: FakeTelegramApi
let runtime: DurableTextRuntime
let clockNow: number

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
  clockNow = NOW
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
    inboxWorker: { now: () => clockNow },
    outboxWorker: { now: () => clockNow },
    ux: { receivedReaction: true },
    albumFlushMs: 100,
    voiceTranscriber: {
      transcribe: async (attachment) => ({
        status: 'ok',
        transcript: `транскрипт из ${attachment.fileName}`,
      }),
    },
    outboundMedia: {
      directory: join(root, 'outbound-media'),
      allowedRoots: [root],
    },
  })
})

afterEach(async () => {
  runtime.close()
  await client.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable text runtime composition', () => {
  test('acknowledges an authorized private message with a native eye reaction', async () => {
    runtime.ingest({
      update_id: 800,
      message: {
        message_id: 44,
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: 'принято?',
      },
    }, NOW)
    await Bun.sleep(0)
    expect(telegram.reactions).toEqual([{ chatId: '7001', messageId: 44, emoji: '👀' }])

    runtime.ingest({
      update_id: 801,
      message: {
        message_id: 45,
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/status',
      },
    }, NOW)
    await Bun.sleep(0)
    expect(telegram.reactions).toHaveLength(1)
  })

  test('registers and delivers a local file only through the durable outbox', async () => {
    const path = join(root, 'generated-report.pdf')
    writeFileSync(path, '%PDF-generated')
    const enqueued = await runtime.enqueueOutboundMedia({
      sourceKey: 'manual:report:1',
      chatId: '7001',
      path,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
      createdAtMs: NOW,
    })
    expect(enqueued.created).toBe(true)
    expect(await runtime.deliverOutboundOnce()).toEqual({
      outcome: 'delivered', jobId: enqueued.job.id, remoteId: 'telegram:990',
    })
    expect(telegram.media).toEqual([{
      chatId: '7001', kind: 'document', fileName: 'report.pdf', options: {},
    }])
  })

  test('runs text and generated images through the durable Telegram pipeline', async () => {
    const generatedImage = join(root, 'generated-avatar.png')
    writeFileSync(generatedImage, 'fake-png-bytes')
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
        item: {
          type: 'imageGeneration',
          id: 'generated-avatar',
          status: 'completed',
          revisedPrompt: null,
          result: 'large-inline-result',
          failure: null,
          savedPath: generatedImage,
        },
      },
    })
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if ((await runtime.deliverOutboundOnce()).outcome === 'idle') break
    }
    expect(telegram.sent).toEqual([])
    expect(telegram.media).toEqual([{
      chatId: '7001', kind: 'photo', fileName: 'generated-avatar.png',
      options: { caption: 'Готово.', parse_mode: 'HTML' },
    }])
    expect(telegram.edits).toEqual([])

    expect(
      database.query<{ kind: string; depends_on_source_key: string | null }, []>(
        `SELECT kind, depends_on_source_key FROM delivery_jobs WHERE kind = 'send_media'`,
      ).get(),
    ).toMatchObject({
      kind: 'send_media',
      depends_on_source_key: null,
    })

    expect(
      database.query<{ state: string }, []>('SELECT state FROM telegram_updates').get()?.state,
    ).toBe('PROCESSED')
    expect(
      database.query<{ count: number }, []>(
        `SELECT count(*) AS count FROM delivery_jobs WHERE state != 'DELIVERED'`,
      ).get()?.count,
    ).toBe(0)
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

    const processing = runtime.processInboundOnce()
    const accountRead = await waitForRequest(transport, 'account/read')
    transport.emit({
      id: accountRead.id,
      result: {
        account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    })
    expect((await processing).outcome).toBe('enqueued')
    expect(
      transport.sent.some((message) => 'method' in message && message.method === 'thread/start'),
    ).toBe(false)
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect(telegram.sent[0]?.text).toContain('Codex готов')
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

  test('runs Guided Plan as a durable confirm-before-execute flow', async () => {
    runtime.ingest({
      update_id: 820,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: '/plan on',
      },
    }, NOW)
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')

    runtime.ingest({
      update_id: 821,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'реализуй безопасный экспорт',
      },
    }, NOW + 1)
    clockNow = NOW + 2
    const planning = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-guided' } } })
    const planTurn = await waitForRequestNumber(transport, 'turn/start', 1)
    expect(planTurn).toMatchObject({
      params: {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        input: [{ type: 'text', text: expect.stringContaining('PLANNING ONLY') }],
      },
    })
    transport.emit({ id: planTurn.id, result: { turn: { id: 'turn-plan' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-guided', turnId: 'turn-plan',
        item: { type: 'agentMessage', id: 'plan-answer', text: '1. Изменить\n2. Проверить', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-guided', turn: { id: 'turn-plan', status: 'completed', items: [] } },
    })
    expect((await planning).outcome).toBe('enqueued')
    const plan = database.query<{ token: string; state: string }, []>(
      'SELECT token, state FROM guided_plans',
    ).get()
    expect(plan).toMatchObject({ state: 'AWAITING_CONFIRMATION' })
    if (plan === null) throw new Error('guided plan was not persisted')

    runtime.ingest({
      update_id: 822,
      callback_query: {
        id: 'confirm-guided', data: `dx:p:${plan.token}:go`, from: { id: 7001, is_bot: false },
        message: { message_id: 999, chat: { id: 7001, type: 'private' } },
      },
    }, NOW + 2)
    const executing = runtime.processInboundOnce()
    const resume = await waitForRequest(transport, 'thread/resume')
    expect(resume).toMatchObject({ params: { threadId: 'thread-guided', cwd: '/srv/workspace' } })
    transport.emit({ id: resume.id, result: { thread: { id: 'thread-guided' } } })
    const executeTurn = await waitForRequestNumber(transport, 'turn/start', 2)
    expect(executeTurn).toMatchObject({
      params: {
        sandboxPolicy: { type: 'workspaceWrite' },
        input: [{ type: 'text', text: expect.stringContaining('APPROVED PLAN') }],
      },
    })
    expect(
      ('params' in executeTurn
        ? executeTurn.params as { approvalPolicy?: string }
        : {}).approvalPolicy,
    ).not.toBe('never')
    transport.emit({ id: executeTurn.id, result: { turn: { id: 'turn-execute' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-guided', turnId: 'turn-execute',
        item: { type: 'agentMessage', id: 'execute-answer', text: 'Реализовано.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-guided', turn: { id: 'turn-execute', status: 'completed', items: [] },
      },
    })
    expect((await executing).outcome).toBe('enqueued')
    expect(database.query<{ state: string }, []>('SELECT state FROM guided_plans').get()?.state)
      .toBe('COMPLETED')
  })

  test('offers a durable busy choice and queues the prompt only after confirmation', async () => {
    runtime.ingest({
      update_id: 830,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'долгая первая задача',
      },
    }, NOW)
    const first = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-busy-runtime' } } })
    const firstTurn = await waitForRequestNumber(transport, 'turn/start', 1)
    transport.emit({ id: firstTurn.id, result: { turn: { id: 'turn-busy-runtime' } } })

    runtime.ingest({
      update_id: 831,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'вторая задача',
      },
    }, NOW + 1)
    clockNow = NOW + 2
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect(transport.sent.filter(
      (message) => 'method' in message && message.method === 'turn/start',
    )).toHaveLength(1)
    const busy = database.query<{ token: string; state: string }, []>(
      'SELECT token, state FROM telegram_busy_prompts',
    ).get()
    expect(busy).toMatchObject({ state: 'PENDING' })
    if (busy === null) throw new Error('busy prompt was not persisted')

    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-busy-runtime', turnId: 'turn-busy-runtime',
        item: { type: 'agentMessage', id: 'first-answer', text: 'Первая готова.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-busy-runtime',
        turn: { id: 'turn-busy-runtime', status: 'completed', items: [] },
      },
    })
    expect((await first).outcome).toBe('enqueued')

    runtime.ingest({
      update_id: 832,
      callback_query: {
        id: 'queue-busy', data: `dx:b:${busy.token}:queue`, from: { id: 7001, is_bot: false },
        message: { message_id: 998, chat: { id: 7001, type: 'private' } },
      },
    }, NOW + 3)
    clockNow = NOW + 4
    const queued = runtime.processInboundOnce()
    const resume = await waitForRequest(transport, 'thread/resume')
    transport.emit({ id: resume.id, result: { thread: { id: 'thread-busy-runtime' } } })
    const secondTurn = await waitForRequestNumber(transport, 'turn/start', 2)
    expect(secondTurn).toMatchObject({
      params: { input: [{ type: 'text', text: 'вторая задача', text_elements: [] }] },
    })
    transport.emit({ id: secondTurn.id, result: { turn: { id: 'turn-queued-runtime' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-busy-runtime', turnId: 'turn-queued-runtime',
        item: { type: 'agentMessage', id: 'second-answer', text: 'Вторая готова.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-busy-runtime',
        turn: { id: 'turn-queued-runtime', status: 'completed', items: [] },
      },
    })
    expect((await queued).outcome).toBe('enqueued')
    expect(database.query<{ state: string }, []>(
      'SELECT state FROM telegram_busy_prompts',
    ).get()?.state).toBe('COMPLETED')
  })

  test('materializes a busy photo and steers it into the active turn', async () => {
    runtime.ingest({
      update_id: 840,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'начни долгую проверку',
      },
    }, NOW)
    const first = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-image-steer' } } })
    const activeTurn = await waitForRequest(transport, 'turn/start')
    transport.emit({ id: activeTurn.id, result: { turn: { id: 'turn-image-steer' } } })

    telegram.downloads.set('steer-photo', {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      fileSize: 5,
      uniqueId: 'steer-photo-u1',
    })
    runtime.ingest({
      update_id: 841,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        caption: 'и вот эту картинку учти',
        photo: [{
          file_id: 'steer-photo', file_unique_id: 'steer-photo-u1',
          width: 800, height: 600, file_size: 5,
        }],
      },
    }, NOW + 1)
    clockNow = NOW + 2
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    const busy = database.query<{ token: string; state: string }, []>(
      'SELECT token, state FROM telegram_busy_prompts',
    ).get()
    expect(busy).toMatchObject({ state: 'PENDING' })
    if (busy === null) throw new Error('image busy prompt was not persisted')

    runtime.ingest({
      update_id: 842,
      callback_query: {
        id: 'steer-image', data: `dx:b:${busy.token}:steer`, from: { id: 7001, is_bot: false },
        message: { message_id: 999, chat: { id: 7001, type: 'private' } },
      },
    }, NOW + 3)
    clockNow = NOW + 4
    const steering = runtime.processInboundOnce()
    const steer = await waitForRequest(transport, 'turn/steer')
    expect(steer).toMatchObject({
      params: {
        threadId: 'thread-image-steer',
        expectedTurnId: 'turn-image-steer',
        input: [
          { type: 'text', text: 'и вот эту картинку учти', text_elements: [] },
          { type: 'localImage', path: expect.stringContaining('/attachments/') },
        ],
      },
    })
    transport.emit({ id: steer.id, result: { turnId: 'turn-image-steer' } })
    expect((await steering).outcome).toBe('enqueued')
    expect(database.query<{ state: string }, []>(
      'SELECT state FROM telegram_busy_prompts',
    ).get()?.state).toBe('STEERED')

    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-image-steer', turnId: 'turn-image-steer',
        item: { type: 'agentMessage', id: 'steered-answer', text: 'Учёл.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-image-steer',
        turn: { id: 'turn-image-steer', status: 'completed', items: [] },
      },
    })
    expect((await first).outcome).toBe('enqueued')
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

  test('turns a Telegram album into one Codex turn after the durable silence window', async () => {
    const firstBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01])
    const secondBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x02])
    telegram.downloads.set('album-photo-1', {
      bytes: firstBytes, fileSize: firstBytes.length, uniqueId: 'album-u1',
    })
    telegram.downloads.set('album-photo-2', {
      bytes: secondBytes, fileSize: secondBytes.length, uniqueId: 'album-u2',
    })
    runtime.ingest({
      update_id: 809,
      message: {
        media_group_id: 'album-809',
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        caption: 'сравни изображения',
        photo: [{ file_id: 'album-photo-1', file_unique_id: 'album-u1', width: 10, height: 10, file_size: 5 }],
      },
    }, NOW)
    runtime.ingest({
      update_id: 810,
      message: {
        media_group_id: 'album-809',
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        photo: [{ file_id: 'album-photo-2', file_unique_id: 'album-u2', width: 10, height: 10, file_size: 5 }],
      },
    }, NOW + 50)

    clockNow = NOW + 149
    expect(await runtime.processInboundOnce()).toEqual({ outcome: 'idle' })
    clockNow = NOW + 150
    const processing = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-album' } } })
    const turnStart = await waitForRequest(transport, 'turn/start')
    expect(turnStart).toMatchObject({
      params: {
        input: [
          { type: 'text', text: 'сравни изображения', text_elements: [] },
          { type: 'localImage', path: expect.stringContaining('/attachments/') },
          { type: 'localImage', path: expect.stringContaining('/attachments/') },
        ],
      },
    })
    transport.emit({ id: turnStart.id, result: { turn: { id: 'turn-album' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-album', turnId: 'turn-album',
        item: { type: 'agentMessage', id: 'album-answer', text: 'Сравнил.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-album', turn: { id: 'turn-album', status: 'completed', items: [] } },
    })
    expect((await processing).outcome).toBe('enqueued')
    expect(telegram.downloadCalls).toEqual(['album-photo-1', 'album-photo-2'])
    expect(database.query<{ count: number }, []>(
      `SELECT count(*) AS count FROM telegram_updates WHERE state = 'PROCESSED'`,
    ).get()?.count).toBe(2)
    expect(transport.sent.filter(
      (message) => 'method' in message && message.method === 'turn/start',
    )).toHaveLength(1)
  })

  test('materializes and transcribes Telegram voice before sending localAudio to Codex', async () => {
    const bytes = new TextEncoder().encode('OggSvoice-runtime')
    telegram.downloads.set('voice-runtime', {
      bytes, fileSize: bytes.length, uniqueId: 'voice-runtime-u1',
    })
    runtime.ingest({
      update_id: 811,
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        voice: {
          file_id: 'voice-runtime', file_unique_id: 'voice-runtime-u1',
          mime_type: 'audio/ogg', file_size: bytes.length,
        },
      },
    }, NOW)
    const processing = runtime.processInboundOnce()
    const threadStart = await waitForRequest(transport, 'thread/start')
    transport.emit({ id: threadStart.id, result: { thread: { id: 'thread-voice' } } })
    const turnStart = await waitForRequest(transport, 'turn/start')
    expect(turnStart).toMatchObject({
      params: {
        input: [
          { type: 'text', text: expect.stringContaining('транскрипт из voice.ogg') },
          { type: 'localAudio', path: expect.stringContaining('/attachments/') },
        ],
      },
    })
    transport.emit({ id: turnStart.id, result: { turn: { id: 'turn-voice' } } })
    transport.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-voice', turnId: 'turn-voice',
        item: { type: 'agentMessage', id: 'voice-answer', text: 'Услышал.', phase: 'final_answer' },
      },
    })
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-voice', turn: { id: 'turn-voice', status: 'completed', items: [] } },
    })
    expect((await processing).outcome).toBe('enqueued')
    expect(database.query<{ kind: string; state: string }, []>(
      'SELECT kind, state FROM telegram_attachments',
    ).get()).toEqual({ kind: 'file', state: 'READY' })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_attachment_proofs',
    ).get()?.count).toBe(1)
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

  test('runs startup reconciliation before replaying a completed accepted update', async () => {
    const recoveredImage = join(root, 'recovered-image.png')
    writeFileSync(recoveredImage, 'recovered-png-bytes')
    const update = {
      update_id: 808,
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: 'finish across restart',
      },
    }
    const accepted = runtime.ingest(update, NOW)
    const inbox = new SqliteInboxRepository(database)
    inbox.claimNext({ workerId: 'dead-worker', nowMs: NOW, leaseDurationMs: 60_000 })
    const sessions = new SqliteSessionRepository(database)
    const operationKey = 'telegram:primary:808:turn'
    const prepared = sessions.prepareTextOperation({
      operationKey,
      inboxUpdateId: accepted.update.id,
      botId: 'primary',
      updateId: 808,
      chatId: '7001',
      projectId: 'workspace',
      text: 'finish across restart',
    }, 'codex', NOW)
    sessions.markDispatching(prepared.turn.id, 'codex', 'thread-recovered', true, NOW)
    sessions.markBackendTurnStarted(
      prepared.turn.id,
      'turn-recovered',
      'codex',
      'thread-recovered',
      NOW,
    )

    const recovering = runtime.recoverStartup()
    const read = await waitForRequest(transport, 'thread/read')
    transport.emit({
      id: read.id,
      result: {
        thread: {
          id: 'thread-recovered',
          turns: [{
            id: 'turn-recovered',
            status: 'completed',
            error: null,
            items: [
              {
                type: 'agentMessage',
                id: 'answer-recovered',
                text: 'Recovered through runtime.',
                phase: 'final_answer',
              },
              {
                type: 'imageGeneration',
                id: 'image-recovered',
                status: 'completed',
                revisedPrompt: null,
                result: 'inline-result',
                failure: null,
                savedPath: recoveredImage,
              },
            ],
          }],
        },
      },
    })
    expect((await recovering).turns).toMatchObject({ candidates: 1, completed: 1 })
    expect((await runtime.processInboundOnce()).outcome).toBe('enqueued')
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('delivered')
    expect((await runtime.deliverOutboundOnce()).outcome).toBe('idle')
    expect(telegram.sent).toEqual([])
    expect(telegram.media.at(-1)).toEqual({
      chatId: '7001', kind: 'photo', fileName: 'recovered-image.png',
      options: { caption: 'Recovered through runtime.', parse_mode: 'HTML' },
    })
    expect(
      transport.sent.some((message) => 'method' in message && message.method === 'turn/start'),
    ).toBe(false)
  })
})
