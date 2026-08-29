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
} from '../../src/telegram/durable-text-gateway.js'

const NOW = 1_800_000_000_000

class FakeTelegramApi {
  readonly sends: Array<{ chatId: string; text: string }> = []
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly callbacks: Array<{ id: string; text?: string }> = []
  messageId = 77

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    this.sends.push({ chatId, text })
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
    expect(gateway.extractCommand(make('/stop@other_bot'))).toBeNull()
    expect(gateway.extractCommand(make('/threads'))).toBeNull()
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

  test('redacts secrets before the Telegram mutation and returns remote proof', async () => {
    const job = claimedJob('token 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi private-marker')
    const prepared = await gateway.prepareDelivery(job)
    expect(prepared.text).not.toContain('123456789:')
    expect(prepared.text).not.toContain('private-marker')

    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:77' })
    expect(api.sends).toEqual([{ chatId: '7001', text: prepared.text }])
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
      payload: { action: 'answer_callback', callbackQueryId: 'cb-9', text: 'Принято' },
      createdAtMs: NOW,
    })
    const callback = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const preparedCallback = await gateway.prepareDelivery(callback)
    expect(await gateway.executeDelivery(preparedCallback)).toEqual({
      remoteId: 'telegram:callback:cb-9',
    })
    expect(api.callbacks).toEqual([{ id: 'cb-9', text: 'Принято' }])
  })
})
