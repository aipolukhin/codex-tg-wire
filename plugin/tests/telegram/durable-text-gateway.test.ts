import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../../src/durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
import {
  DurableTelegramTextGateway,
  TelegramDeliveryPayloadError,
  type TelegramMessageOptions,
} from '../../src/telegram/durable-text-gateway.js'

const NOW = 1_800_000_000_000

class FakeTelegramApi {
  readonly sends: Array<{ chatId: string; text: string }> = []
  readonly sendOptions: TelegramMessageOptions[] = []
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly callbacks: Array<{ id: string; text?: string }> = []
  messageId = 77
  nextSendError: Error | undefined

  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }> {
    if (this.nextSendError !== undefined) {
      const error = this.nextSendError
      this.nextSendError = undefined
      throw error
    }
    this.sends.push({ chatId, text })
    this.sendOptions.push(options)
    return { message_id: this.messageId }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<true> {
    this.edits.push({ chatId, messageId, text })
    return true
  }

  async answerCallbackQuery(id: string, options: { text?: string }): Promise<true> {
    this.callbacks.push({ id, ...options })
    return true
  }
}

let root: string
let database: Database
let inbox: SqliteInboxRepository
let outbox: SqliteOutboxRepository
let api: FakeTelegramApi
let gateway: DurableTelegramTextGateway
let nextUpdateId: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-telegram-gateway-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  inbox = new SqliteInboxRepository(database)
  outbox = new SqliteOutboxRepository(database)
  api = new FakeTelegramApi()
  nextUpdateId = 1
  gateway = new DurableTelegramTextGateway(api, {
    allowedUserIds: [7001],
    allowedChatIds: ['7001'],
    defaultProjectId: 'workspace',
    extraSecrets: ['private-marker'],
    botUsername: 'my_bot',
  })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function acceptedUpdate(payload: unknown) {
  return inbox.ingest({
    botId: 'primary',
    updateId: nextUpdateId++,
    payload,
    receivedAtMs: NOW,
  }).update
}

describe('DurableTelegramTextGateway inbound', () => {
  test('accepts only allowlisted private human text and maps the project', () => {
    const update = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: 'проверь проект',
      },
    })
    expect(gateway.extractText(update)).toEqual({
      chatId: '7001',
      projectId: 'workspace',
      text: 'проверь проект',
    })
  })

  test('drops unauthorized, group, bot-authored and command updates', () => {
    const messages = [
      { chat: { id: 9999, type: 'private' }, from: { id: 9999 }, text: 'unauthorized' },
      { chat: { id: 7001, type: 'group' }, from: { id: 7001 }, text: 'group' },
      { chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: true }, text: 'bot' },
      { chat: { id: 7001, type: 'private' }, from: { id: 7001 }, text: '/status' },
    ]
    for (const message of messages) {
      expect(gateway.extractText(acceptedUpdate({ message }))).toBeNull()
    }
  })

  test('extracts the largest photo and allowlist-gated document messages', () => {
    const photo = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        caption: 'что на картинке?',
        photo: [
          { file_id: 'small', file_unique_id: 'u-small', width: 90, height: 90, file_size: 100 },
          { file_id: 'large', file_unique_id: 'u-large', width: 1280, height: 720, file_size: 500 },
        ],
      },
    })
    expect(gateway.extractText(photo)).toEqual({
      chatId: '7001',
      projectId: 'workspace',
      text: 'что на картинке?',
      attachments: [{
        kind: 'image',
        fileId: 'large',
        uniqueId: 'u-large',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        declaredSize: 500,
      }],
    })

    const document = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        document: {
          file_id: 'doc-1',
          file_unique_id: 'doc-u1',
          file_name: '../report.pdf',
          mime_type: 'application/pdf',
          file_size: 42,
        },
      },
    })
    expect(gateway.extractText(document)).toMatchObject({
      text: '',
      attachments: [{ kind: 'file', fileId: 'doc-1', mimeType: 'application/pdf' }],
    })

    expect(gateway.extractText(acceptedUpdate({
      message: {
        chat: { id: 9999, type: 'private' },
        from: { id: 9999 },
        photo: [{ file_id: 'foreign', width: 1, height: 1 }],
      },
    }))).toBeNull()
  })

  test('projects a durable album leader as one message with ordered attachments', () => {
    const first = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        caption: 'проверь альбом', photo: [{ file_id: 'photo-1', width: 10, height: 10 }],
      },
    })
    const second = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        document: { file_id: 'doc-2', file_name: 'notes.txt', mime_type: 'text/plain' },
      },
    })
    const albumGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: [7001],
      defaultProjectId: 'workspace',
      albumSource: { albumFragmentsFor: () => [first, second] },
    })

    expect(albumGateway.extractText(first)).toEqual({
      chatId: '7001',
      projectId: 'workspace',
      text: 'проверь альбом',
      attachments: [
        expect.objectContaining({ kind: 'image', fileId: 'photo-1' }),
        expect.objectContaining({ kind: 'file', fileId: 'doc-2', fileName: 'notes.txt' }),
      ],
    })
  })

  test('materializes accepted attachments and returns safe policy rejections', async () => {
    const update = acceptedUpdate({ update_id: 700 })
    const message = {
      chatId: '7001',
      projectId: 'workspace',
      text: '',
      attachments: [{
        kind: 'file' as const,
        fileId: 'doc-1',
        uniqueId: 'u1',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        declaredSize: 42,
      }],
    }
    const acceptedGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: [7001],
      defaultProjectId: 'workspace',
      attachmentStore: {
        materialize: async (sourceUpdateId, ordinal) => ({
          outcome: 'accepted',
          attachment: {
            kind: 'file',
            path: `/safe/${sourceUpdateId}-${ordinal}.pdf`,
            fileName: 'report.pdf',
            mimeType: 'application/pdf',
            size: 42,
          },
        }),
      },
    })
    expect(await acceptedGateway.prepareInboundMessage(update, message)).toEqual({
      outcome: 'accepted',
      message: {
        ...message,
        attachments: [{
          kind: 'file',
          path: `/safe/${update.id}-0.pdf`,
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          size: 42,
        }],
      },
    })

    const rejectedGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: [7001],
      defaultProjectId: 'workspace',
      attachmentStore: {
        materialize: async () => ({ outcome: 'rejected', reason: 'mime_not_allowed' }),
      },
    })
    expect(await rejectedGateway.prepareInboundMessage(update, message)).toEqual({
      outcome: 'rejected',
      text: 'Этот тип вложения запрещён конфигурацией bridge.',
    })
  })

  test('parses only supported commands addressed to this bot', () => {
    const make = (text: string) => acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text,
      },
    })
    expect(gateway.extractCommand(make('/status'))).toMatchObject({ name: 'status', args: '' })
    expect(gateway.extractCommand(make('/new@my_bot now'))).toMatchObject({ name: 'new', args: 'now' })
    expect(gateway.extractCommand(make('/steer@my_bot run tests'))).toMatchObject({
      name: 'steer',
      args: 'run tests',
    })
    expect(gateway.extractCommand(make('/failed'))).toMatchObject({ name: 'failed', args: '' })
    expect(gateway.extractCommand(make('/resolved@my_bot job-1 991'))).toMatchObject({
      name: 'resolved',
      args: 'job-1 991',
    })
    expect(gateway.extractCommand(make('/threads'))).toMatchObject({ name: 'threads', args: '' })
    expect(gateway.extractCommand(make('/switch@my_bot thread-1'))).toMatchObject({
      name: 'switch',
      args: 'thread-1',
    })
    expect(gateway.extractCommand(make('/model gpt-test'))).toMatchObject({
      name: 'model',
      args: 'gpt-test',
    })
    expect(gateway.extractCommand(make('/cwd@my_bot other'))).toMatchObject({
      name: 'cwd',
      args: 'other',
    })
    expect(gateway.extractCommand(make('/stop@other_bot'))).toBeNull()
    expect(gateway.extractCommand(make('/unknown'))).toBeNull()
  })

  test('authenticates and parses durable interaction callbacks and /answer', () => {
    const approval = acceptedUpdate({
      callback_query: {
        id: 'cb-1',
        data: 'dx:a:012345abcdef:once',
        from: { id: 7001, is_bot: false },
        message: { message_id: 55, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(approval)).toEqual({
      kind: 'approval',
      chatId: '7001',
      token: '012345abcdef',
      decision: 'accept',
      callbackQueryId: 'cb-1',
      callbackMessageId: 55,
    })

    const option = acceptedUpdate({
      callback_query: {
        id: 'cb-2',
        data: 'dx:q:012345abcdef:1:2',
        from: { id: 7001 },
        message: { message_id: 56, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(option)).toMatchObject({
      kind: 'user_input_option',
      questionIndex: 1,
      optionIndex: 2,
    })

    const text = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/answer@my_bot 012345abcdef 2 ship it',
      },
    })
    expect(gateway.extractInteractionResponse(text)).toEqual({
      kind: 'user_input_text',
      chatId: '7001',
      token: '012345abcdef',
      questionIndex: 1,
      text: 'ship it',
    })

    const mcpOption = acceptedUpdate({
      callback_query: {
        id: 'cb-mcp-option',
        data: 'dx:e:012345abcdef:o:3:4',
        from: { id: 7001 },
        message: { message_id: 58, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(mcpOption)).toMatchObject({
      kind: 'mcp_elicitation_option',
      token: '012345abcdef',
      fieldIndex: 3,
      optionIndex: 4,
    })

    const mcpDone = acceptedUpdate({
      callback_query: {
        id: 'cb-mcp-done',
        data: 'dx:e:012345abcdef:d:3',
        from: { id: 7001 },
        message: { message_id: 58, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(mcpDone)).toMatchObject({
      kind: 'mcp_elicitation_done',
      fieldIndex: 3,
    })

    const mcpDecline = acceptedUpdate({
      callback_query: {
        id: 'cb-mcp-decline',
        data: 'dx:e:012345abcdef:a:deny',
        from: { id: 7001 },
        message: { message_id: 59, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(mcpDecline)).toMatchObject({
      kind: 'mcp_elicitation_action',
      action: 'decline',
    })

    const mcpText = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/elicit@my_bot 012345abcdef 2 42',
      },
    })
    expect(gateway.extractInteractionResponse(mcpText)).toEqual({
      kind: 'mcp_elicitation_text',
      chatId: '7001',
      token: '012345abcdef',
      fieldIndex: 1,
      text: '42',
    })

    expect(gateway.extractInteractionResponse(acceptedUpdate({
      callback_query: {
        id: 'cb-bad',
        data: 'dx:a:012345abcdef:once',
        from: { id: 9999 },
        message: { message_id: 57, chat: { id: 7001, type: 'private' } },
      },
    }))).toBeNull()
  })
})

describe('DurableTelegramTextGateway outbound', () => {
  function claimedJob(text: string, chatId = '7001') {
    outbox.enqueue({
      id: `job-${text.length}-${chatId}`,
      sourceKey: `test:${text}:${chatId}`,
      kind: 'send_text',
      payload: { chatId, text },
      createdAtMs: NOW,
    })
    return outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
  }

  test('renders Markdown and emits long final replies as an ordered durable chain', () => {
    const update = acceptedUpdate({ update_id: 900 })
    const longBody = 'важный текст '.repeat(800)
    const deliveries = gateway.buildFinalTextDeliveries({
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'question' },
      result: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        finalText: `# Результат\n\n**Готово**\n\n${longBody}\n\n<script>unsafe</script>`,
      },
      sourceKey: 'telegram:primary:900:turn:final',
      nowMs: NOW,
    })

    expect(deliveries.length).toBeGreaterThan(2)
    for (const [index, delivery] of deliveries.entries()) {
      const payload = delivery.payload as {
        text: string
        options?: TelegramMessageOptions
      }
      expect(payload.text.length).toBeLessThanOrEqual(4_000)
      expect(payload.options).toEqual({ parse_mode: 'HTML' })
      expect(payload.text).not.toContain('<script>')
      expect(delivery.dependsOnSourceKey ?? null).toBe(
        index === 0 ? null : deliveries[index - 1]?.sourceKey ?? null,
      )
    }
    expect((deliveries[0]?.payload as { text: string }).text).toContain('<b>Результат</b>')
    expect(deliveries.some((delivery) =>
      (delivery.payload as { text: string }).text.includes('<b>Готово</b>'))).toBe(true)
  })

  test('re-chunks a plain-text downgrade that expands beyond the Telegram limit', () => {
    const update = acceptedUpdate({ update_id: 901 })
    const deliveries = gateway.buildFinalTextDeliveries({
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'question' },
      result: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        finalText: `[label](https://example.com/${'a'.repeat(4_500)})`,
      },
      sourceKey: 'telegram:primary:901:turn:final',
      nowMs: NOW,
    })

    expect(deliveries.length).toBeGreaterThan(1)
    for (const [index, delivery] of deliveries.entries()) {
      const payload = delivery.payload as {
        text: string
        options?: TelegramMessageOptions
      }
      expect(payload.text.length).toBeLessThanOrEqual(4_000)
      expect(payload.options).toBeUndefined()
      expect(delivery.dependsOnSourceKey ?? null).toBe(
        index === 0 ? null : deliveries[index - 1]?.sourceKey ?? null,
      )
    }
  })

  test('redacts secrets before the Telegram mutation and returns remote proof', async () => {
    const job = claimedJob('token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi private-marker')
    const prepared = await gateway.prepareDelivery(job)
    if (prepared.kind !== 'send_text') throw new Error('expected send_text')
    expect(prepared.text).not.toContain('123456789:')
    expect(prepared.text).not.toContain('private-marker')

    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:77' })
    expect(api.sends).toEqual([{ chatId: '7001', text: prepared.text }])
  })

  test('retries a definite Telegram HTML parse rejection once as plain text', async () => {
    outbox.enqueue({
      id: 'job-html-fallback',
      sourceKey: 'test:html-fallback',
      kind: 'send_text',
      payload: {
        chatId: '7001',
        text: '<b>formatted</b>',
        options: { parse_mode: 'HTML' },
      },
      createdAtMs: NOW,
    })
    const job = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const prepared = await gateway.prepareDelivery(job)
    if (prepared.kind !== 'send_text') throw new Error('expected send_text')
    expect(prepared.options).toEqual({ parse_mode: 'HTML' })
    api.nextSendError = new Error("Bad Request: can't parse entities")

    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:77' })
    expect(api.sends).toEqual([{ chatId: '7001', text: '<b>formatted</b>' }])
    expect(api.sendOptions).toEqual([{}])
  })

  test('resolves a durable edit target only from predecessor delivery proof', async () => {
    const proofGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: ['7001'],
      defaultProjectId: 'workspace',
      deliveryProofForSourceKey: (sourceKey) => outbox.getBySourceKey(sourceKey)?.remoteId ?? null,
    })
    const rootJob = outbox.enqueue({
      id: 'status-root-job',
      sourceKey: 'turn:status-root',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'starting' },
      createdAtMs: NOW,
    }).job
    expect(() => outbox.enqueue({
      id: 'status-early-edit',
      sourceKey: 'turn:status-early-edit',
      dependsOnSourceKey: rootJob.sourceKey,
      kind: 'edit',
      payload: { chatId: '7001', targetSourceKey: rootJob.sourceKey, text: 'working' },
      createdAtMs: NOW + 1,
    })).not.toThrow()
    const rootLease = outbox.claimNext({ workerId: 'root', nowMs: NOW, leaseDurationMs: 60_000 })!
    outbox.markSendStarted(rootLease.id, 'root', NOW)
    outbox.markDelivered(rootLease.id, 'root', 'telegram:345', NOW)

    const editLease = outbox.claimNext({ workerId: 'edit', nowMs: NOW + 1, leaseDurationMs: 60_000 })!
    const prepared = await proofGateway.prepareDelivery(editLease)
    expect(prepared).toMatchObject({ kind: 'edit', messageId: 345, text: 'working' })
  })

  test('rejects non-allowlisted destinations and oversized text before send_started', async () => {
    await expect(gateway.prepareDelivery(claimedJob('hello', '9999'))).rejects.toBeInstanceOf(
      TelegramDeliveryPayloadError,
    )

    const smallGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: ['7001'],
      allowedChatIds: ['7001'],
      defaultProjectId: 'workspace',
      maxTextLength: 5,
    })
    await expect(smallGateway.prepareDelivery(claimedJob('123456'))).rejects.toThrow(
      'exceeds Telegram limit',
    )
    expect(api.sends).toHaveLength(0)
  })

  test('accepts only credential-free HTTPS inline URL buttons', async () => {
    outbox.enqueue({
      sourceKey: 'test:url-button',
      kind: 'send_text',
      payload: {
        chatId: '7001',
        text: 'Authorize',
        options: {
          reply_markup: {
            inline_keyboard: [
              [{
                text: 'Open private-marker',
                url: 'https://accounts.example.com/authorize?state=opaque',
              }],
              [{
                text: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
                callback_data: 'safe-callback',
              }],
            ],
          },
        },
      },
      createdAtMs: NOW,
    })
    const valid = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const prepared = await gateway.prepareDelivery(valid)
    if (prepared.kind !== 'send_text') throw new Error('expected text delivery')
    expect(prepared.options).toEqual({
      reply_markup: {
        inline_keyboard: [
          [{
            text: 'Open [REDACTED]',
            url: 'https://accounts.example.com/authorize?state=opaque',
          }],
          [{ text: '[REDACTED]', callback_data: 'safe-callback' }],
        ],
      },
    })

    outbox.failLease(valid.id, 'sender', 'test release', NOW)
    outbox.enqueue({
      sourceKey: 'test:unsafe-url-button',
      kind: 'send_text',
      payload: {
        chatId: '7001',
        text: 'Unsafe',
        options: {
          reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'http://example.com' }]] },
        },
      },
      createdAtMs: NOW,
    })
    const unsafe = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    await expect(gateway.prepareDelivery(unsafe)).rejects.toThrow('inline keyboard URL is invalid')
  })

  test('requires a valid Telegram message_id as delivery proof', async () => {
    api.messageId = 0
    const prepared = await gateway.prepareDelivery(claimedJob('hello'))
    await expect(gateway.executeDelivery(prepared)).rejects.toThrow('invalid message_id')
  })

  test('executes durable edits and callback acknowledgements', async () => {
    outbox.enqueue({
      sourceKey: 'test:edit',
      kind: 'edit',
      payload: {
        chatId: '7001',
        messageId: 88,
        text: '✅ Resolved',
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: NOW,
    })
    const edit = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const preparedEdit = await gateway.prepareDelivery(edit)
    expect(await gateway.executeDelivery(preparedEdit)).toEqual({ remoteId: 'telegram:88' })
    expect(api.edits).toEqual([{ chatId: '7001', messageId: 88, text: '✅ Resolved' }])

    outbox.failLease(edit.id, 'sender', 'test release', NOW)
    outbox.enqueue({
      sourceKey: 'test:callback',
      kind: 'reaction',
      payload: {
        action: 'answer_callback',
        callbackQueryId: 'cb-9',
        text: 'Принято private-marker',
      },
      createdAtMs: NOW,
    })
    const callback = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const preparedCallback = await gateway.prepareDelivery(callback)
    expect(await gateway.executeDelivery(preparedCallback)).toEqual({
      remoteId: 'telegram:callback:cb-9',
    })
    expect(api.callbacks).toEqual([{ id: 'cb-9', text: 'Принято [REDACTED]' }])
  })
})
