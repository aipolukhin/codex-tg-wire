import type {
  FinalTextDelivery,
  CommandDelivery,
  IncomingCommand,
  IncomingInteractionResponse,
  IncomingTextMessage,
  PersonalAlphaCommandName,
  TelegramGateway,
} from '../bridge/contracts.js'
import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'
import { redactSecrets } from '../safety/redact.js'

export interface TelegramTextApi {
  answerCallbackQuery?(
    callbackQueryId: string,
    options: { text?: string },
  ): Promise<true>
  editMessageText?(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<unknown>
  sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }>
}

export interface TelegramInlineButton {
  text: string
  callback_data: string
}

export interface TelegramMessageOptions {
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] }
}

export interface DurableTelegramTextGatewayOptions {
  allowedUserIds: readonly (string | number)[]
  allowedChatIds: readonly (string | number)[]
  defaultProjectId: string
  extraSecrets?: readonly string[]
  maxTextLength?: number
  botUsername?: string
}

export type PreparedTextDelivery = {
  kind: 'send_text'
  jobId: string
  chatId: string
  text: string
  options: TelegramMessageOptions
} | {
  kind: 'edit'
  jobId: string
  chatId: string
  messageId: number
  text: string
  options: TelegramMessageOptions
} | {
  kind: 'answer_callback'
  jobId: string
  callbackQueryId: string
  text: string
}

interface TelegramMessagePayload {
  message?: {
    chat?: { id?: string | number; type?: string }
    from?: { id?: string | number; is_bot?: boolean }
    text?: string
  }
}

interface TelegramCallbackPayload {
  callback_query?: {
    id?: string
    data?: string
    from?: { id?: string | number; is_bot?: boolean }
    message?: {
      message_id?: number
      chat?: { id?: string | number; type?: string }
    }
  }
}

interface SendTextPayload {
  chatId?: unknown
  text?: unknown
  options?: unknown
}

interface EditTextPayload extends SendTextPayload {
  messageId?: unknown
}

interface AnswerCallbackPayload {
  action?: unknown
  callbackQueryId?: unknown
  text?: unknown
}

const TELEGRAM_TEXT_LIMIT = 4_096

function idSet(values: readonly (string | number)[]): Set<string> {
  return new Set(values.map(String))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMessageOptions(value: unknown): TelegramMessageOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || !isRecord(value.reply_markup)) {
    throw new TelegramDeliveryPayloadError('message options contain an invalid reply_markup')
  }
  const keyboard = value.reply_markup.inline_keyboard
  if (!Array.isArray(keyboard) || keyboard.length > 100) {
    throw new TelegramDeliveryPayloadError('inline keyboard must contain at most 100 rows')
  }
  const inline_keyboard = keyboard.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 8) {
      throw new TelegramDeliveryPayloadError('inline keyboard row has an invalid size')
    }
    return row.map((button) => {
      if (!isRecord(button) || typeof button.text !== 'string' || typeof button.callback_data !== 'string') {
        throw new TelegramDeliveryPayloadError('inline keyboard button is invalid')
      }
      if (button.text.length < 1 || button.text.length > 64) {
        throw new TelegramDeliveryPayloadError('inline keyboard button text is invalid')
      }
      if (Buffer.byteLength(button.callback_data, 'utf8') > 64) {
        throw new TelegramDeliveryPayloadError('inline keyboard callback_data exceeds 64 bytes')
      }
      return { text: button.text, callback_data: button.callback_data }
    })
  })
  return { reply_markup: { inline_keyboard } }
}

export class TelegramDeliveryPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramDeliveryPayloadError'
  }
}

export class DurableTelegramTextGateway implements TelegramGateway<PreparedTextDelivery> {
  private readonly allowedUsers: Set<string>
  private readonly allowedChats: Set<string>
  private readonly defaultProjectId: string
  private readonly extraSecrets: readonly string[]
  private readonly maxTextLength: number
  private readonly botUsername: string | null

  constructor(
    private readonly api: TelegramTextApi,
    options: DurableTelegramTextGatewayOptions,
  ) {
    this.allowedUsers = idSet(options.allowedUserIds)
    this.allowedChats = idSet(options.allowedChatIds)
    this.defaultProjectId = options.defaultProjectId
    this.extraSecrets = options.extraSecrets ?? []
    this.maxTextLength = options.maxTextLength ?? TELEGRAM_TEXT_LIMIT
    this.botUsername = options.botUsername?.replace(/^@/, '').toLowerCase() ?? null
    if (this.allowedUsers.size === 0 || this.allowedChats.size === 0) {
      throw new TypeError('Telegram gateway allowlists must not be empty')
    }
    if (this.defaultProjectId.trim().length === 0) {
      throw new TypeError('defaultProjectId must not be empty')
    }
    if (!Number.isSafeInteger(this.maxTextLength) || this.maxTextLength < 1) {
      throw new TypeError('maxTextLength must be a positive safe integer')
    }
  }

  extractText(update: InboxUpdate): IncomingTextMessage | null {
    const message = this.authorizedMessage(update)
    if (message === null) return null
    const trimmed = message.text.trim()
    if (trimmed.length === 0 || trimmed.startsWith('/')) return null
    return { chatId: message.chatId, projectId: this.defaultProjectId, text: message.text }
  }

  extractCommand(update: InboxUpdate): IncomingCommand | null {
    const message = this.authorizedMessage(update)
    if (message === null) return null
    const match = message.text.trim().match(/^\/(start|new|status|stop)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/i)
    if (match === null || match[1] === undefined) return null
    const addressedUsername = match[2]?.toLowerCase()
    if (addressedUsername !== undefined && addressedUsername !== this.botUsername) return null
    return {
      chatId: message.chatId,
      projectId: this.defaultProjectId,
      name: match[1].toLowerCase() as PersonalAlphaCommandName,
      args: match[3]?.trim() ?? '',
    }
  }

  extractInteractionResponse(update: InboxUpdate): IncomingInteractionResponse | null {
    if (!isRecord(update.payload)) return null
    const callback = (update.payload as TelegramCallbackPayload).callback_query
    if (callback !== undefined) {
      const chatId = callback.message?.chat?.id
      const senderId = callback.from?.id
      const messageId = callback.message?.message_id
      if (
        callback.message?.chat?.type !== 'private' ||
        callback.from?.is_bot === true ||
        chatId === undefined ||
        senderId === undefined ||
        typeof callback.id !== 'string' ||
        typeof callback.data !== 'string' ||
        !Number.isSafeInteger(messageId)
      ) {
        return null
      }
      const normalizedChatId = String(chatId)
      if (!this.allowedChats.has(normalizedChatId) || !this.allowedUsers.has(String(senderId))) {
        return null
      }
      const approval = callback.data.match(/^dx:a:([a-f0-9]{12}):(once|session|deny|cancel)$/)
      if (approval !== null && approval[1] !== undefined && approval[2] !== undefined) {
        const decision = approval[2] === 'once'
          ? 'accept'
          : approval[2] === 'session'
            ? 'acceptForSession'
            : approval[2] === 'deny'
              ? 'decline'
              : 'cancel'
        return {
          kind: 'approval',
          chatId: normalizedChatId,
          token: approval[1],
          decision,
          callbackQueryId: callback.id,
          callbackMessageId: messageId as number,
        }
      }
      const answer = callback.data.match(/^dx:q:([a-f0-9]{12}):(0|[1-9]\d?):(0|[1-9]\d?)$/)
      if (answer !== null && answer[1] !== undefined && answer[2] !== undefined && answer[3] !== undefined) {
        return {
          kind: 'user_input_option',
          chatId: normalizedChatId,
          token: answer[1],
          questionIndex: Number.parseInt(answer[2], 10),
          optionIndex: Number.parseInt(answer[3], 10),
          callbackQueryId: callback.id,
          callbackMessageId: messageId as number,
        }
      }
      return null
    }

    const message = this.authorizedMessage(update)
    if (message === null) return null
    const escapedUsername = this.botUsername?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const usernamePart = escapedUsername === null ? '' : `(?:@${escapedUsername})?`
    const answer = message.text.trim().match(
      new RegExp(`^/answer${usernamePart}\\s+([a-f0-9]{12})\\s+([1-9]\\d?)\\s+([\\s\\S]+)$`, 'i'),
    )
    if (answer === null || answer[1] === undefined || answer[2] === undefined || answer[3] === undefined) {
      return null
    }
    return {
      kind: 'user_input_text',
      chatId: message.chatId,
      token: answer[1].toLowerCase(),
      questionIndex: Number.parseInt(answer[2], 10) - 1,
      text: answer[3].trim(),
    }
  }

  buildFinalTextDelivery(input: FinalTextDelivery): DeliveryJobInput {
    return {
      sourceKey: input.sourceKey,
      kind: 'send_text',
      payload: { chatId: input.message.chatId, text: input.result.finalText },
      createdAtMs: input.nowMs,
    }
  }

  buildCommandDelivery(input: CommandDelivery): DeliveryJobInput {
    return {
      sourceKey: input.sourceKey,
      kind: 'send_text',
      payload: { chatId: input.command.chatId, text: input.result.text },
      createdAtMs: input.nowMs,
    }
  }

  async prepareDelivery(job: DeliveryJob): Promise<PreparedTextDelivery> {
    if (job.kind === 'reaction') {
      if (!isRecord(job.payload)) throw new TelegramDeliveryPayloadError('reaction payload must be an object')
      const payload = job.payload as AnswerCallbackPayload
      if (payload.action !== 'answer_callback' || typeof payload.callbackQueryId !== 'string') {
        throw new TelegramDeliveryPayloadError('reaction payload is not a callback answer')
      }
      if (payload.text !== undefined && typeof payload.text !== 'string') {
        throw new TelegramDeliveryPayloadError('callback answer text must be a string')
      }
      return {
        kind: 'answer_callback',
        jobId: job.id,
        callbackQueryId: payload.callbackQueryId,
        text: typeof payload.text === 'string' ? payload.text.slice(0, 200) : '',
      }
    }
    if (job.kind !== 'send_text' && job.kind !== 'edit') {
      throw new TelegramDeliveryPayloadError(`unsupported delivery kind: ${job.kind}`)
    }
    if (!isRecord(job.payload)) throw new TelegramDeliveryPayloadError('send_text payload must be an object')
    const payload = job.payload as EditTextPayload
    if (typeof payload.chatId !== 'string' || !this.allowedChats.has(payload.chatId)) {
      throw new TelegramDeliveryPayloadError('send_text chat is not allowlisted')
    }
    if (typeof payload.text !== 'string') {
      throw new TelegramDeliveryPayloadError('send_text text must be a string')
    }
    const text = redactSecrets(payload.text, this.extraSecrets)
    if (text.trim().length === 0) throw new TelegramDeliveryPayloadError('send_text text is empty')
    if (text.length > this.maxTextLength) {
      throw new TelegramDeliveryPayloadError(
        `send_text exceeds Telegram limit (${text.length} > ${this.maxTextLength})`,
      )
    }
    const options = parseMessageOptions(payload.options)
    if (job.kind === 'edit') {
      if (!Number.isSafeInteger(payload.messageId) || (payload.messageId as number) <= 0) {
        throw new TelegramDeliveryPayloadError('edit messageId must be a positive safe integer')
      }
      return {
        kind: 'edit',
        jobId: job.id,
        chatId: payload.chatId,
        messageId: payload.messageId as number,
        text,
        options,
      }
    }
    return { kind: 'send_text', jobId: job.id, chatId: payload.chatId, text, options }
  }

  async executeDelivery(prepared: PreparedTextDelivery): Promise<{ remoteId: string }> {
    if (prepared.kind === 'answer_callback') {
      if (this.api.answerCallbackQuery === undefined) {
        throw new TelegramDeliveryPayloadError('Telegram API cannot answer callback queries')
      }
      await this.api.answerCallbackQuery(
        prepared.callbackQueryId,
        prepared.text.length === 0 ? {} : { text: prepared.text },
      )
      return { remoteId: `telegram:callback:${prepared.callbackQueryId}` }
    }
    if (prepared.kind === 'edit') {
      if (this.api.editMessageText === undefined) {
        throw new TelegramDeliveryPayloadError('Telegram API cannot edit messages')
      }
      await this.api.editMessageText(
        prepared.chatId,
        prepared.messageId,
        prepared.text,
        prepared.options,
      )
      return { remoteId: `telegram:${prepared.messageId}` }
    }
    const sent = await this.api.sendMessage(prepared.chatId, prepared.text, prepared.options)
    if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
      throw new TelegramDeliveryPayloadError('Telegram returned an invalid message_id')
    }
    return { remoteId: `telegram:${sent.message_id}` }
  }

  private authorizedMessage(update: InboxUpdate): { chatId: string; text: string } | null {
    if (!isRecord(update.payload)) return null
    const payload = update.payload as TelegramMessagePayload
    const message = payload.message
    const chatId = message?.chat?.id
    const senderId = message?.from?.id
    const text = message?.text
    if (message?.chat?.type !== 'private' || message.from?.is_bot === true) return null
    if (chatId === undefined || senderId === undefined || typeof text !== 'string') return null
    const normalizedChatId = String(chatId)
    const normalizedSenderId = String(senderId)
    if (!this.allowedChats.has(normalizedChatId) || !this.allowedUsers.has(normalizedSenderId)) {
      return null
    }
    return { chatId: normalizedChatId, text }
  }
}
