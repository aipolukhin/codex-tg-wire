import type {
  FinalTextDelivery,
  CommandDelivery,
  IncomingCommand,
  IncomingTextMessage,
  PersonalAlphaCommandName,
  TelegramGateway,
} from '../bridge/contracts.js'
import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'
import { redactSecrets } from '../safety/redact.js'

export interface TelegramTextApi {
  sendMessage(
    chatId: string,
    text: string,
    options: Record<string, never>,
  ): Promise<{ message_id: number }>
}

export interface DurableTelegramTextGatewayOptions {
  allowedUserIds: readonly (string | number)[]
  allowedChatIds: readonly (string | number)[]
  defaultProjectId: string
  extraSecrets?: readonly string[]
  maxTextLength?: number
  botUsername?: string
}

export interface PreparedTextDelivery {
  jobId: string
  chatId: string
  text: string
}

interface TelegramMessagePayload {
  message?: {
    chat?: { id?: string | number; type?: string }
    from?: { id?: string | number; is_bot?: boolean }
    text?: string
  }
}

interface SendTextPayload {
  chatId?: unknown
  text?: unknown
}

const TELEGRAM_TEXT_LIMIT = 4_096

function idSet(values: readonly (string | number)[]): Set<string> {
  return new Set(values.map(String))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    if (job.kind !== 'send_text') {
      throw new TelegramDeliveryPayloadError(`unsupported delivery kind: ${job.kind}`)
    }
    if (!isRecord(job.payload)) throw new TelegramDeliveryPayloadError('send_text payload must be an object')
    const payload = job.payload as SendTextPayload
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
    return { jobId: job.id, chatId: payload.chatId, text }
  }

  async executeDelivery(prepared: PreparedTextDelivery): Promise<{ remoteId: string }> {
    const sent = await this.api.sendMessage(prepared.chatId, prepared.text, {})
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
