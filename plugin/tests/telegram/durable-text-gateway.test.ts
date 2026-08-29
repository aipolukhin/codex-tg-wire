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
  messageId = 77

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    this.sends.push({ chatId, text })
    return { message_id: this.messageId }
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
    expect(gateway.extractCommand(make('/stop@other_bot'))).toBeNull()
    expect(gateway.extractCommand(make('/threads'))).toBeNull()
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
})
