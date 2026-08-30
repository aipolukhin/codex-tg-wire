import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteTelegramMessageRouteRepository } from '../../src/durable/message-route-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
import {
  DurableTelegramTextGateway,
  TelegramDeliveryPayloadError,
  type TelegramMessageOptions,
  type TelegramRichMessageOptions,
} from '../../src/telegram/durable-text-gateway.js'

const NOW = 1_800_000_000_000

class FakeTelegramApi {
  readonly sends: Array<{ chatId: string; text: string }> = []
  readonly sendOptions: TelegramMessageOptions[] = []
  readonly richSends: Array<{ chatId: string; markdown: string; options: TelegramRichMessageOptions }> = []
  readonly richEdits: Array<{
    chatId: string
    messageId: number
    markdown: string
    options: TelegramRichMessageOptions
  }> = []
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly callbacks: Array<{ id: string; text?: string }> = []
  readonly deletes: Array<{ chatId: string; messageId: number }> = []
  messageId = 77
  nextMessageIds: number[] = []
  nextSendError: Error | undefined
  nextRichError: Error | undefined
  nextRichEditError: Error | undefined

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
    return { message_id: this.nextMessageIds.shift() ?? this.messageId }
  }

  async sendRichMessage(
    chatId: string,
    markdown: string,
    options: TelegramRichMessageOptions,
  ): Promise<{ message_id: number }> {
    if (this.nextRichError !== undefined) {
      const error = this.nextRichError
      this.nextRichError = undefined
      throw error
    }
    this.richSends.push({ chatId, markdown, options })
    return { message_id: this.nextMessageIds.shift() ?? this.messageId }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<true> {
    this.edits.push({ chatId, messageId, text })
    return true
  }

  async editRichMessage(
    chatId: string,
    messageId: number,
    markdown: string,
    options: TelegramRichMessageOptions,
  ): Promise<true> {
    if (this.nextRichEditError !== undefined) {
      const error = this.nextRichEditError
      this.nextRichEditError = undefined
      throw error
    }
    this.richEdits.push({ chatId, messageId, markdown, options })
    return true
  }

  async answerCallbackQuery(id: string, options: { text?: string }): Promise<true> {
    this.callbacks.push({ id, ...options })
    return true
  }

  async deleteMessage(chatId: string, messageId: number): Promise<true> {
    this.deletes.push({ chatId, messageId })
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

  test('normalizes a Premium rich post and preserves its inline media', () => {
    const update = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        rich_message: {
          blocks: [
            { type: 'heading', size: 2, text: 'План' },
            {
              type: 'paragraph',
              text: ['Сначала ', { type: 'bold', text: 'проверить' }, ' таблицу.'],
            },
            {
              type: 'photo',
              photo: [
                { file_id: 'rich-small', file_unique_id: 'rich-u1', width: 10, height: 10 },
                { file_id: 'rich-large', file_unique_id: 'rich-u2', width: 100, height: 80 },
              ],
              caption: { text: 'Схема' },
            },
          ],
        },
      },
    })

    expect(gateway.extractText(update)).toEqual({
      chatId: '7001',
      projectId: 'workspace',
      text: '## План\n\nСначала **проверить** таблицу.\n\n[Inline photo attachment #1]\nСхема',
      attachments: [{
        kind: 'image', fileId: 'rich-large', uniqueId: 'rich-u2', fileName: 'photo.jpg',
        mimeType: 'image/jpeg', declaredSize: null,
      }],
    })
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

  test('transcribes voice only after the durable audio path is available', async () => {
    const calls: string[] = []
    const voiceGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: [7001],
      defaultProjectId: 'workspace',
      attachmentStore: {
        materialize: async () => {
          calls.push('materialize')
          return {
            outcome: 'accepted',
            attachment: {
              kind: 'audio', path: '/safe/voice.ogg', fileName: 'voice.ogg',
              mimeType: 'audio/ogg', size: 12, sha256: '0'.repeat(64),
            },
          }
        },
      },
      voiceTranscriber: {
        transcribe: async (attachment) => {
          calls.push(`transcribe:${attachment.path}`)
          return { status: 'ok', transcript: 'проверь тесты' }
        },
      },
    })
    const update = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        voice: { file_id: 'voice-1', file_unique_id: 'voice-u1', mime_type: 'audio/ogg', file_size: 12 },
      },
    })
    const message = voiceGateway.extractText(update)
    expect(message).toMatchObject({
      text: '',
      attachments: [{ kind: 'audio', fileId: 'voice-1', transcribe: true }],
    })
    if (message === null) throw new Error('voice fixture was not extracted')
    expect(await voiceGateway.prepareInboundMessage(update, message)).toMatchObject({
      outcome: 'accepted',
      message: {
        text: expect.stringContaining('проверь тесты'),
        attachments: [{ kind: 'audio', path: '/safe/voice.ogg' }],
      },
    })
    expect(calls).toEqual(['materialize', 'transcribe:/safe/voice.ogg'])
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
            sha256: '0'.repeat(64),
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
          sha256: '0'.repeat(64),
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
    expect(gateway.extractCommand(make('/settings'))).toMatchObject({ name: 'settings' })
    expect(gateway.extractCommand(make('/sessions archived'))).toMatchObject({
      name: 'sessions', args: 'archived',
    })
    expect(gateway.extractCommand(make('/review base main'))).toMatchObject({
      name: 'review', args: 'base main',
    })
    expect(gateway.extractCommand(make('/plan on'))).toMatchObject({ name: 'plan', args: 'on' })
    expect(gateway.extractCommand(make('/stop@other_bot'))).toBeNull()
    expect(gateway.extractCommand(make('/unknown'))).toBeNull()
  })

  test('parses Groq onboarding and deletes its source only through a durable job', async () => {
    const update = acceptedUpdate({
      message: {
        message_id: 321,
        chat: { id: 7001, type: 'private' },
        from: { id: 7001, is_bot: false },
        text: '/groq gsk_private',
      },
    })
    const command = gateway.extractCommand(update)
    expect(command).toEqual({
      chatId: '7001', projectId: 'workspace', name: 'groq', args: 'gsk_private', messageId: 321,
    })
    const job = outbox.enqueue(gateway.buildCommandCleanupDelivery({
      update,
      command: command!,
      result: { text: 'saved', sensitiveInput: true, deleteSourceMessage: true },
      sourceKey: 'groq-command',
      nowMs: NOW,
    })).job
    expect(job.kind).toBe('delete')
    const prepared = await gateway.prepareDelivery(job)
    expect(prepared).toMatchObject({ kind: 'delete', chatId: '7001', messageId: 321 })
    await gateway.executeDelivery(prepared)
    expect(api.deletes).toEqual([{ chatId: '7001', messageId: 321 }])
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

    const busy = acceptedUpdate({
      callback_query: {
        id: 'cb-busy', data: 'dx:b:012345abcdef:replace', from: { id: 7001 },
        message: { message_id: 60, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(busy)).toMatchObject({
      kind: 'feature_action', feature: 'busy', token: '012345abcdef', action: 'replace',
    })
    const settings = acceptedUpdate({
      callback_query: {
        id: 'cb-settings', data: 'dx:s:set:sandbox:workspace-write', from: { id: 7001 },
        message: { message_id: 61, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(settings)).toMatchObject({
      kind: 'feature_action', feature: 'settings', action: 'set:sandbox:workspace-write',
    })
    const onboarding = acceptedUpdate({
      callback_query: {
        id: 'cb-onboarding', data: 'dx:o:begin', from: { id: 7001 },
        message: { message_id: 62, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(onboarding)).toMatchObject({
      kind: 'feature_action', feature: 'onboarding', action: 'begin', token: 'onboarding',
    })
    const git = acceptedUpdate({
      callback_query: {
        id: 'cb-git', data: 'dx:g:012345abcdef:0:commit-push', from: { id: 7001 },
        message: { message_id: 63, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(git)).toMatchObject({
      kind: 'feature_action', feature: 'git', token: '012345abcdef',
      action: '0:commit-push',
    })
    const turn = acceptedUpdate({
      callback_query: {
        id: 'cb-turn', data: 'dx:t:012345abcdef:confirm', from: { id: 7001 },
        message: { message_id: 64, chat: { id: 7001, type: 'private' } },
      },
    })
    expect(gateway.extractInteractionResponse(turn)).toMatchObject({
      kind: 'feature_action', feature: 'turn', token: '012345abcdef', action: 'confirm',
    })
    const revision = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: '/revise@my_bot 012345abcdef добавь rollback',
      },
    })
    expect(gateway.extractInteractionResponse(revision)).toEqual({
      kind: 'guided_plan_revision', chatId: '7001', token: '012345abcdef',
      text: 'добавь rollback',
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

  test('routes a reply to the thread that produced the replied-to Telegram message', () => {
    const routes = new SqliteTelegramMessageRouteRepository(database)
    routes.register({
      sourceKey: 'turn:route:final', botId: 'primary', chatId: '7001',
      projectId: 'other', threadId: 'thread-origin', createdAtMs: NOW,
    })
    routes.markDelivered('turn:route:final', 777, NOW + 1)
    const routedGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: ['7001'],
      defaultProjectId: 'workspace',
      messageRoutes: routes,
    })
    const update = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'продолжай именно это',
        reply_to_message: { message_id: 777 },
        quote: {
          text: 'после первого свежего события атомарно заменять его',
          position: 731,
          is_manual: true,
        },
      },
    })
    expect(routedGateway.extractText(update)).toEqual({
      chatId: '7001', projectId: 'other', text: 'продолжай именно это',
      quote: {
        replyToMessageId: 777,
        text: 'после первого свежего события атомарно заменять его',
        position: 731,
        isManual: true,
      },
      preferredThreadId: 'thread-origin',
    })
  })

  test('ignores a quote that is not attached to a valid Telegram reply', () => {
    const update = acceptedUpdate({
      message: {
        chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false },
        text: 'это не reply',
        quote: { text: 'поддельная цитата', position: 0, is_manual: true },
      },
    })
    expect(gateway.extractText(update)).toEqual({
      chatId: '7001', projectId: 'workspace', text: 'это не reply',
    })
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

  test('uses a short generated-image response as its Telegram caption', () => {
    const update = acceptedUpdate({ update_id: 899 })
    const common = {
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'draw it' },
      sourceKey: 'telegram:primary:899:turn:final',
      nowMs: NOW,
    }
    expect(gateway.buildFinalTextDeliveries({
      ...common,
      result: {
        threadId: 'thread-caption',
        turnId: 'turn-caption',
        finalText: '**Готово**, брат.',
        artifacts: [{ kind: 'generated_image' as const, path: '/tmp/avatar.png' }],
      },
    })).toEqual([])

    expect(gateway.buildFinalTextDeliveries({
      ...common,
      result: {
        threadId: 'thread-long-caption',
        turnId: 'turn-long-caption',
        finalText: 'длинная подпись '.repeat(100),
        artifacts: [{ kind: 'generated_image' as const, path: '/tmp/avatar.png' }],
      },
    })).toHaveLength(1)

    expect(gateway.buildFinalTextDeliveries({
      ...common,
      result: {
        threadId: 'thread-buttons',
        turnId: 'turn-buttons',
        finalText: 'Choose one',
        artifacts: [{ kind: 'generated_image' as const, path: '/tmp/avatar.png' }],
        buttons: [[{ text: 'Open', url: 'https://example.com' }]],
      },
    })).toHaveLength(1)
  })

  test('renders Markdown and emits long final replies as an ordered durable chain', () => {
    const update = acceptedUpdate({ update_id: 900 })
    const longBody = 'важный текст '.repeat(3_000)
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
        presentation: 'guided_plan',
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

  test('sends eligible answers as one durable rich message with buttons', async () => {
    const update = acceptedUpdate({ update_id: 902 })
    const [delivery] = gateway.buildFinalTextDeliveries({
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'question' },
      result: {
        threadId: 'thread-rich',
        turnId: 'turn-rich',
        finalText: '# Итог\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        buttons: [[{ text: 'Open', url: 'https://example.com' }]],
      },
      sourceKey: 'telegram:primary:902:turn:final',
      nowMs: NOW,
    })
    expect(delivery).toMatchObject({
      kind: 'send_text',
      payload: {
        format: 'rich',
        text: '# Итог\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      },
    })
    expect((delivery?.payload as { fallback?: unknown[] }).fallback).toHaveLength(1)
    const job = outbox.enqueue(delivery!).job
    const prepared = await gateway.prepareDelivery(job)
    expect(prepared).toMatchObject({ kind: 'send_rich', chatId: '7001' })
    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:77' })
    expect(api.richSends).toEqual([{
      chatId: '7001',
      markdown: '# Итог\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      options: {
        reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]] },
      },
    }])
    expect(api.sends).toHaveLength(0)
  })

  test('keeps an ordinary short answer quoteable through sendMessage', async () => {
    const update = acceptedUpdate({ update_id: 903 })
    const [delivery] = gateway.buildFinalTextDeliveries({
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'question' },
      result: {
        threadId: 'thread-quoteable',
        turnId: 'turn-quoteable',
        finalText: '# Итог\n\n**Готово.** Можно выделить и процитировать этот фрагмент.',
      },
      sourceKey: 'telegram:primary:903:turn:final',
      nowMs: NOW,
    })
    expect(delivery).toMatchObject({
      kind: 'send_text',
      payload: {
        chatId: '7001',
        options: { parse_mode: 'HTML' },
      },
    })
    expect((delivery?.payload as { format?: string }).format).toBeUndefined()

    const job = outbox.enqueue(delivery!).job
    const prepared = await gateway.prepareDelivery(job)
    expect(prepared).toMatchObject({ kind: 'send_text', chatId: '7001' })
    expect(await gateway.executeDelivery(prepared)).toEqual({ remoteId: 'telegram:77' })
    expect(api.richSends).toHaveLength(0)
    expect(api.sends).toHaveLength(1)
  })

  test('falls back atomically to stored HTML chunks and records every reply route', async () => {
    const routes = new SqliteTelegramMessageRouteRepository(database)
    const richGateway = new DurableTelegramTextGateway(api, {
      allowedUserIds: [7001],
      allowedChatIds: ['7001'],
      defaultProjectId: 'workspace',
      messageRoutes: routes,
    })
    const update = acceptedUpdate({ update_id: 903 })
    const [delivery] = richGateway.buildFinalTextDeliveries({
      update,
      message: { chatId: '7001', projectId: 'workspace', text: 'question' },
      result: {
        threadId: 'thread-fallback',
        turnId: 'turn-fallback',
        finalText: `**Result**\n\n${'plain fallback text '.repeat(900)}`,
      },
      sourceKey: 'telegram:primary:903:turn:final',
      nowMs: NOW,
    })
    const fallback = (delivery?.payload as { fallback?: unknown[] }).fallback
    if (fallback === undefined) throw new Error('expected durable rich fallback')
    expect(fallback?.length).toBeGreaterThan(1)
    const job = outbox.enqueue(delivery!).job
    const prepared = await richGateway.prepareDelivery(job)
    const parserError = new Error("Bad Request: can't parse rich message") as Error & {
      error_code: number
    }
    parserError.error_code = 400
    api.nextRichError = parserError
    api.nextMessageIds = fallback.map((_, index) => 81 + index)

    const proof = await richGateway.executeDelivery(prepared)
    expect(proof.remoteId).toMatch(/^telegram-batch:81,82/)
    expect(api.richSends).toHaveLength(0)
    expect(api.sends.length).toBe(fallback.length)
    richGateway.recordDelivery(job, proof, NOW + 1)
    expect(routes.findByTelegramMessage('primary', '7001', 81)).toMatchObject({
      sourceKey: 'telegram:primary:903:turn:final', threadId: 'thread-fallback',
    })
    expect(routes.findByTelegramMessage('primary', '7001', 82)).toMatchObject({
      sourceKey: 'telegram:primary:903:turn:final:fallback:2', threadId: 'thread-fallback',
    })
  })

  test('does not fall back after an ambiguous transient rich-send failure', async () => {
    outbox.enqueue({
      sourceKey: 'test:rich-transient',
      kind: 'send_text',
      payload: {
        chatId: '7001', text: '**hello**', format: 'rich',
        fallback: [{ text: '<b>hello</b>', options: { parse_mode: 'HTML' } }],
      },
      createdAtMs: NOW,
    })
    const job = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const prepared = await gateway.prepareDelivery(job)
    const transient = new Error('upstream timeout') as Error & { error_code: number }
    transient.error_code = 500
    api.nextRichError = transient

    await expect(gateway.executeDelivery(prepared)).rejects.toBe(transient)
    expect(api.sends).toHaveLength(0)
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
      sourceKey: 'test:rich-edit',
      kind: 'edit',
      payload: {
        chatId: '7001',
        messageId: 89,
        text: '## Progress\n\n- [x] First\n- [ ] Second',
        format: 'rich',
        options: { reply_markup: { inline_keyboard: [] } },
        fallback: [{
          text: '<b>Progress</b>\n\n☑️ First\n☐ Second',
          options: { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
        }],
      },
      createdAtMs: NOW,
    })
    const richEdit = outbox.claimNext({ workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000 })!
    const preparedRichEdit = await gateway.prepareDelivery(richEdit)
    expect(await gateway.executeDelivery(preparedRichEdit)).toEqual({ remoteId: 'telegram:89' })
    expect(api.richEdits).toEqual([{
      chatId: '7001', messageId: 89,
      markdown: '## Progress\n\n- [x] First\n- [ ] Second',
      options: { reply_markup: { inline_keyboard: [] } },
    }])

    outbox.failLease(richEdit.id, 'sender', 'test release', NOW)
    api.nextRichEditError = Object.assign(new Error('rich edit unsupported'), { error_code: 400 })
    outbox.enqueue({
      sourceKey: 'test:rich-edit-fallback',
      kind: 'edit',
      payload: {
        chatId: '7001', messageId: 90, text: '## Updated', format: 'rich',
        options: { reply_markup: { inline_keyboard: [] } },
        fallback: [{
          text: '<b>Updated</b>',
          options: { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
        }],
      },
      createdAtMs: NOW,
    })
    const richFallback = outbox.claimNext({
      workerId: 'sender', nowMs: NOW, leaseDurationMs: 60_000,
    })!
    expect(await gateway.executeDelivery(await gateway.prepareDelivery(richFallback))).toEqual({
      remoteId: 'telegram:90',
    })
    expect(api.edits.at(-1)).toEqual({ chatId: '7001', messageId: 90, text: '<b>Updated</b>' })

    outbox.failLease(richFallback.id, 'sender', 'test release', NOW)
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
