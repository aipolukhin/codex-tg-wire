import type {
  AgentLocalAttachment,
  FinalTextDelivery,
  CommandDelivery,
  InboundRejectionDelivery,
  IncomingCommand,
  IncomingInteractionResponse,
  IncomingTextMessage,
  PersonalAlphaCommandName,
  TelegramGateway,
} from '../bridge/contracts.js'
import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'
import { splitMessage } from '../format/chunk.js'
import {
  isTelegramHtmlParseError,
  markdownToTelegramHtml,
} from '../format/html.js'
import { redactSecrets } from '../safety/redact.js'
import { validateTelegramHtml } from '../safety/html-validator.js'
import type {
  InboundAttachmentStore,
  TelegramAttachmentDownload,
} from './durable-attachment-store.js'
import type {
  DurableMediaReference,
  DurableOutboundMediaStore,
  PreparedLocalMedia,
  TelegramAlbumMediaKind,
  TelegramMediaKind,
} from './durable-outbound-media.js'
import type { VoiceTranscriber } from './durable-voice-transcriber.js'

export interface TelegramMediaOptions {
  caption?: string
  parse_mode?: 'HTML'
}

export interface TelegramAlbumUploadItem {
  kind: TelegramAlbumMediaKind
  media: PreparedLocalMedia
  options: TelegramMediaOptions
}

export interface TelegramTextApi {
  downloadAttachment?(
    fileId: string,
    maxBytes: number,
  ): Promise<TelegramAttachmentDownload>
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
  sendMedia?(
    chatId: string,
    kind: TelegramMediaKind,
    media: PreparedLocalMedia,
    options: TelegramMediaOptions,
  ): Promise<{ message_id: number }>
  sendMediaGroup?(
    chatId: string,
    items: readonly TelegramAlbumUploadItem[],
  ): Promise<readonly { message_id: number }[]>
  sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }>
}

export type TelegramInlineButton =
  | { text: string; callback_data: string; url?: never }
  | { text: string; url: string; callback_data?: never }

export interface TelegramMessageOptions {
  parse_mode?: 'HTML'
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] }
}

export interface DurableTelegramTextGatewayOptions {
  allowedUserIds: readonly (string | number)[]
  allowedChatIds: readonly (string | number)[]
  defaultProjectId: string
  extraSecrets?: readonly string[]
  maxTextLength?: number
  botUsername?: string
  projectIdForChat?: (chatId: string) => string
  attachmentStore?: InboundAttachmentStore
  deliveryProofForSourceKey?: (sourceKey: string) => string | null
  outboundMediaStore?: DurableOutboundMediaStore
  albumSource?: { albumFragmentsFor(updateRowId: number): readonly InboxUpdate[] }
  voiceTranscriber?: VoiceTranscriber
}

export type PreparedTextDelivery = {
  kind: 'send_text'
  jobId: string
  chatId: string
  text: string
  options: TelegramMessageOptions
} | {
  kind: 'send_media'
  jobId: string
  chatId: string
  media: PreparedLocalMedia
  options: TelegramMediaOptions
} | {
  kind: 'send_album'
  jobId: string
  chatId: string
  items: readonly TelegramAlbumUploadItem[]
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
    caption?: string
    photo?: Array<{
      file_id?: string
      file_unique_id?: string
      file_size?: number
      width?: number
      height?: number
    }>
    document?: {
      file_id?: string
      file_unique_id?: string
      file_name?: string
      mime_type?: string
      file_size?: number
    }
    voice?: {
      file_id?: string
      file_unique_id?: string
      mime_type?: string
      file_size?: number
    }
    audio?: {
      file_id?: string
      file_unique_id?: string
      file_name?: string
      mime_type?: string
      file_size?: number
    }
    video?: {
      file_id?: string
      file_unique_id?: string
      file_name?: string
      mime_type?: string
      file_size?: number
    }
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
  targetSourceKey?: unknown
}

interface AnswerCallbackPayload {
  action?: unknown
  callbackQueryId?: unknown
  text?: unknown
}

interface SendMediaPayload {
  chatId?: unknown
  mediaKind?: unknown
  reference?: unknown
  caption?: unknown
}

interface SendAlbumPayload {
  chatId?: unknown
  items?: unknown
}

const TELEGRAM_TEXT_LIMIT = 4_096

function idSet(values: readonly (string | number)[]): Set<string> {
  return new Set(values.map(String))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMediaKind(value: unknown, album = false): TelegramMediaKind {
  const allowed: readonly TelegramMediaKind[] = album
    ? ['photo', 'document', 'audio', 'video']
    : ['photo', 'document', 'audio', 'video', 'voice']
  if (typeof value !== 'string' || !allowed.includes(value as TelegramMediaKind)) {
    throw new TelegramDeliveryPayloadError('delivery contains an invalid media kind')
  }
  return value as TelegramMediaKind
}

function parseMediaReference(value: unknown): DurableMediaReference {
  if (!isRecord(value)) throw new TelegramDeliveryPayloadError('media reference must be an object')
  if (
    typeof value.path !== 'string' ||
    typeof value.fileName !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    typeof value.sha256 !== 'string'
  ) {
    throw new TelegramDeliveryPayloadError('media reference is invalid')
  }
  return {
    path: value.path,
    fileName: value.fileName,
    mimeType: value.mimeType,
    size: value.size as number,
    sha256: value.sha256,
  }
}

function prepareMediaCaption(value: unknown, extraSecrets: readonly string[]): TelegramMediaOptions {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new TelegramDeliveryPayloadError('media caption must be a string')
  const rendered = markdownToTelegramHtml(value)
  const redacted = redactSecrets(rendered, extraSecrets)
  const validated = validateTelegramHtml(redacted)
  if (validated.text.length > 1_024) {
    throw new TelegramDeliveryPayloadError('media caption exceeds Telegram limit')
  }
  return {
    caption: validated.text,
    ...(validated.downgraded ? {} : { parse_mode: 'HTML' as const }),
  }
}

function parseMessageOptions(
  value: unknown,
  extraSecrets: readonly string[] = [],
): TelegramMessageOptions {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new TelegramDeliveryPayloadError('message options must be an object')
  }
  const options: TelegramMessageOptions = {}
  if (value.parse_mode !== undefined) {
    if (value.parse_mode !== 'HTML') {
      throw new TelegramDeliveryPayloadError('message options contain an invalid parse_mode')
    }
    options.parse_mode = 'HTML'
  }
  if (value.reply_markup === undefined) return options
  if (!isRecord(value.reply_markup)) {
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
      if (!isRecord(button) || typeof button.text !== 'string') {
        throw new TelegramDeliveryPayloadError('inline keyboard button is invalid')
      }
      if (button.text.length < 1 || button.text.length > 64) {
        throw new TelegramDeliveryPayloadError('inline keyboard button text is invalid')
      }
      const callbackData = button.callback_data
      const url = button.url
      const text = redactSecrets(button.text, extraSecrets)
      if (typeof callbackData === 'string' && url === undefined) {
        if (Buffer.byteLength(callbackData, 'utf8') > 64) {
          throw new TelegramDeliveryPayloadError('inline keyboard callback_data exceeds 64 bytes')
        }
        return { text, callback_data: callbackData }
      }
      if (typeof url === 'string' && callbackData === undefined) {
        try {
          const parsed = new URL(url)
          if (
            url.length > 4_096 ||
            parsed.protocol !== 'https:' ||
            parsed.username.length > 0 ||
            parsed.password.length > 0
          ) {
            throw new Error('unsafe URL')
          }
        } catch {
          throw new TelegramDeliveryPayloadError('inline keyboard URL is invalid')
        }
        return { text, url }
      }
      throw new TelegramDeliveryPayloadError('inline keyboard button must have exactly one action')
    })
  })
  return { ...options, reply_markup: { inline_keyboard } }
}

function withoutParseMode(options: TelegramMessageOptions): TelegramMessageOptions {
  const { parse_mode: _parseMode, ...fallback } = options
  return fallback
}

function withoutMediaParseMode(options: TelegramMediaOptions): TelegramMediaOptions {
  const { parse_mode: _parseMode, ...fallback } = options
  return fallback
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
  private readonly projectIdForChat: (chatId: string) => string
  private readonly attachmentStore: InboundAttachmentStore | undefined
  private readonly deliveryProofForSourceKey: ((sourceKey: string) => string | null) | undefined
  private readonly outboundMediaStore: DurableOutboundMediaStore | undefined
  private readonly albumSource: DurableTelegramTextGatewayOptions['albumSource']
  private readonly voiceTranscriber: VoiceTranscriber | undefined

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
    this.projectIdForChat = options.projectIdForChat ?? (() => this.defaultProjectId)
    this.attachmentStore = options.attachmentStore
    this.deliveryProofForSourceKey = options.deliveryProofForSourceKey
    this.outboundMediaStore = options.outboundMediaStore
    this.albumSource = options.albumSource
    this.voiceTranscriber = options.voiceTranscriber
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
    const album = this.albumSource?.albumFragmentsFor(update.id) ?? []
    const updates = album.length === 0 ? [update] : album
    const envelopes = updates.map((fragment) => this.authorizedEnvelope(fragment))
    if (envelopes.some((value) => value === null)) return null
    const authorized = envelopes[0]
    if (authorized === null || authorized === undefined) return null
    if (envelopes.some((value) => value?.chatId !== authorized.chatId)) return null
    const textParts: string[] = []
    const attachments = [] as NonNullable<IncomingTextMessage['attachments']>[number][]
    for (const envelope of envelopes) {
      if (envelope === null) continue
      const text = typeof envelope.message.text === 'string'
        ? envelope.message.text
        : typeof envelope.message.caption === 'string'
          ? envelope.message.caption
          : ''
      if (text.trim().length > 0 && !textParts.includes(text)) textParts.push(text)
      attachments.push(...this.extractAttachments(envelope.message))
    }
    const text = textParts.join('\n\n')
    const trimmed = text.trim()
    if (trimmed.startsWith('/') || (trimmed.length === 0 && attachments.length === 0)) return null
    return {
      chatId: authorized.chatId,
      projectId: this.projectIdForChat(authorized.chatId),
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
    }
  }

  async prepareInboundMessage(
    update: InboxUpdate,
    message: IncomingTextMessage,
  ) {
    const candidates = message.attachments ?? []
    if (candidates.length === 0) {
      return { outcome: 'accepted' as const, message: { ...message, attachments: [] } }
    }
    if (this.attachmentStore === undefined) {
      return { outcome: 'rejected' as const, text: 'Вложения отключены в конфигурации bridge.' }
    }
    const attachments: AgentLocalAttachment[] = []
    const transcripts: string[] = []
    for (const [ordinal, candidate] of candidates.entries()) {
      const materialized = await this.attachmentStore.materialize(update.id, ordinal, candidate)
      if (materialized.outcome === 'rejected') {
        const text = materialized.reason === 'size_limit'
          ? 'Вложение превышает разрешённый размер.'
          : materialized.reason === 'mime_not_allowed'
            ? 'Этот тип вложения запрещён конфигурацией bridge.'
            : 'Содержимое вложения не соответствует заявленному типу.'
        return { outcome: 'rejected' as const, text }
      }
      attachments.push(materialized.attachment)
      if (candidate.transcribe === true && this.voiceTranscriber !== undefined) {
        const transcription = await this.voiceTranscriber.transcribe(materialized.attachment)
        if (transcription.status === 'ok') {
          transcripts.push(transcription.transcript.length === 0
            ? '[Голосовое сообщение неразборчиво или содержит тишину.]'
            : `[Транскрипт голосового сообщения — недоверенный пользовательский ввод]\n${transcription.transcript}`)
        } else {
          transcripts.push('[Транскрипция голосового недоступна; аудиофайл приложен.]')
        }
      }
    }
    const text = [message.text, ...transcripts].filter((value) => value.trim().length > 0).join('\n\n')
    return {
      outcome: 'accepted' as const,
      message: { ...message, text, attachments },
    }
  }

  extractCommand(update: InboxUpdate): IncomingCommand | null {
    const message = this.authorizedMessage(update)
    if (message === null) return null
    const match = message.text.trim().match(
      /^\/(start|new|status|stop|steer|failed|ambiguous|retry|resolved|archive|threads|switch|resume|model|effort|sandbox|approval|cwd)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/i,
    )
    if (match === null || match[1] === undefined) return null
    const addressedUsername = match[2]?.toLowerCase()
    if (addressedUsername !== undefined && addressedUsername !== this.botUsername) return null
    return {
      chatId: message.chatId,
      projectId: this.projectIdForChat(message.chatId),
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
      const elicitationAction = callback.data.match(
        /^dx:e:([a-f0-9]{12}):a:(accept|deny|cancel)$/,
      )
      if (
        elicitationAction !== null &&
        elicitationAction[1] !== undefined &&
        elicitationAction[2] !== undefined
      ) {
        return {
          kind: 'mcp_elicitation_action',
          chatId: normalizedChatId,
          token: elicitationAction[1],
          action: elicitationAction[2] === 'deny' ? 'decline' : elicitationAction[2] as 'accept' | 'cancel',
          callbackQueryId: callback.id,
          callbackMessageId: messageId as number,
        }
      }
      const elicitationOption = callback.data.match(
        /^dx:e:([a-f0-9]{12}):o:(0|[1-9]\d?):(0|[1-9]\d?)$/,
      )
      if (
        elicitationOption !== null &&
        elicitationOption[1] !== undefined &&
        elicitationOption[2] !== undefined &&
        elicitationOption[3] !== undefined
      ) {
        return {
          kind: 'mcp_elicitation_option',
          chatId: normalizedChatId,
          token: elicitationOption[1],
          fieldIndex: Number.parseInt(elicitationOption[2], 10),
          optionIndex: Number.parseInt(elicitationOption[3], 10),
          callbackQueryId: callback.id,
          callbackMessageId: messageId as number,
        }
      }
      const elicitationFieldAction = callback.data.match(
        /^dx:e:([a-f0-9]{12}):(d|s):(0|[1-9]\d?)$/,
      )
      if (
        elicitationFieldAction !== null &&
        elicitationFieldAction[1] !== undefined &&
        elicitationFieldAction[2] !== undefined &&
        elicitationFieldAction[3] !== undefined
      ) {
        return {
          kind: elicitationFieldAction[2] === 'd'
            ? 'mcp_elicitation_done'
            : 'mcp_elicitation_skip',
          chatId: normalizedChatId,
          token: elicitationFieldAction[1],
          fieldIndex: Number.parseInt(elicitationFieldAction[3], 10),
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
    const normalizedText = message.text.trim()
    const elicitation = normalizedText.match(
      new RegExp(`^/elicit${usernamePart}\\s+([a-f0-9]{12})\\s+([1-9]\\d?)\\s+([\\s\\S]+)$`, 'i'),
    )
    if (
      elicitation !== null &&
      elicitation[1] !== undefined &&
      elicitation[2] !== undefined &&
      elicitation[3] !== undefined
    ) {
      return {
        kind: 'mcp_elicitation_text',
        chatId: message.chatId,
        token: elicitation[1].toLowerCase(),
        fieldIndex: Number.parseInt(elicitation[2], 10) - 1,
        text: elicitation[3].trim(),
      }
    }
    const answer = normalizedText.match(
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

  buildFinalTextDeliveries(input: FinalTextDelivery): readonly DeliveryJobInput[] {
    const rendered = markdownToTelegramHtml(input.result.finalText)
    const validated = validateTelegramHtml(rendered)
    const chunkLimit = Math.min(4_000, this.maxTextLength)
    const rawChunks = splitMessage(validated.text, chunkLimit)
    if (rawChunks.length === 0) throw new TelegramDeliveryPayloadError('final response is empty')
    const chunks = rawChunks.flatMap((chunk) => {
      if (validated.downgraded) return [{ text: chunk, html: false }]
      const checked = validateTelegramHtml(chunk)
      if (!checked.downgraded) return [{ text: checked.text, html: true }]
      // A pathological opening tag can itself cross a chunk boundary. Its
      // escaped plain-text downgrade may be longer than the original chunk,
      // so split it again before it becomes a durable delivery job.
      return splitMessage(checked.text, chunkLimit).map((text) => ({ text, html: false }))
    })
    const sourceKeys = chunks.map((_, index) => index === 0
      ? input.sourceKey
      : `${input.sourceKey}:chunk:${index + 1}`)
    return chunks.map((chunk, index) => ({
      sourceKey: sourceKeys[index] as string,
      ...(index === 0 ? {} : { dependsOnSourceKey: sourceKeys[index - 1] as string }),
      kind: 'send_text',
      payload: {
        chatId: input.message.chatId,
        text: chunk.text,
        ...(chunk.html ? { options: { parse_mode: 'HTML' } } : {}),
      },
      createdAtMs: input.nowMs + index,
    }))
  }

  buildCommandDelivery(input: CommandDelivery): DeliveryJobInput {
    return {
      sourceKey: input.sourceKey,
      kind: 'send_text',
      payload: { chatId: input.command.chatId, text: input.result.text },
      createdAtMs: input.nowMs,
    }
  }

  buildInboundRejectionDelivery(input: InboundRejectionDelivery): DeliveryJobInput {
    return {
      sourceKey: input.sourceKey,
      kind: 'send_text',
      payload: { chatId: input.message.chatId, text: input.text },
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
        text: typeof payload.text === 'string'
          ? redactSecrets(payload.text, this.extraSecrets).slice(0, 200)
          : '',
      }
    }
    if (job.kind === 'send_media') {
      if (this.outboundMediaStore === undefined) {
        throw new TelegramDeliveryPayloadError('outbound media is not configured')
      }
      if (!isRecord(job.payload)) throw new TelegramDeliveryPayloadError('send_media payload must be an object')
      const payload = job.payload as SendMediaPayload
      if (typeof payload.chatId !== 'string' || !this.allowedChats.has(payload.chatId)) {
        throw new TelegramDeliveryPayloadError('send_media chat is not allowlisted')
      }
      const kind = parseMediaKind(payload.mediaKind)
      const media = await this.outboundMediaStore.prepare(parseMediaReference(payload.reference), kind)
      return {
        kind: 'send_media',
        jobId: job.id,
        chatId: payload.chatId,
        media,
        options: prepareMediaCaption(payload.caption, this.extraSecrets),
      }
    }
    if (job.kind === 'send_album') {
      if (this.outboundMediaStore === undefined) {
        throw new TelegramDeliveryPayloadError('outbound media is not configured')
      }
      if (!isRecord(job.payload)) throw new TelegramDeliveryPayloadError('send_album payload must be an object')
      const payload = job.payload as SendAlbumPayload
      if (typeof payload.chatId !== 'string' || !this.allowedChats.has(payload.chatId)) {
        throw new TelegramDeliveryPayloadError('send_album chat is not allowlisted')
      }
      if (!Array.isArray(payload.items) || payload.items.length < 2 || payload.items.length > 10) {
        throw new TelegramDeliveryPayloadError('album must contain 2 to 10 items')
      }
      const items: TelegramAlbumUploadItem[] = []
      for (const value of payload.items) {
        if (!isRecord(value)) throw new TelegramDeliveryPayloadError('album item must be an object')
        const kind = parseMediaKind(value.mediaKind, true) as TelegramAlbumMediaKind
        items.push({
          kind,
          media: await this.outboundMediaStore.prepare(parseMediaReference(value.reference), kind),
          options: prepareMediaCaption(value.caption, this.extraSecrets),
        })
      }
      const kinds = new Set(items.map((item) => item.kind))
      if ((kinds.has('document') && kinds.size !== 1) || (kinds.has('audio') && kinds.size !== 1)) {
        throw new TelegramDeliveryPayloadError('album media kinds cannot be mixed')
      }
      return { kind: 'send_album', jobId: job.id, chatId: payload.chatId, items }
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
    let text = redactSecrets(payload.text, this.extraSecrets)
    if (text.trim().length === 0) throw new TelegramDeliveryPayloadError('send_text text is empty')
    let options = parseMessageOptions(payload.options, this.extraSecrets)
    if (options.parse_mode === 'HTML') {
      const validated = validateTelegramHtml(text)
      if (validated.downgraded) {
        text = validated.text
        options = withoutParseMode(options)
      }
    }
    if (text.length > this.maxTextLength) {
      throw new TelegramDeliveryPayloadError(
        `send_text exceeds Telegram limit (${text.length} > ${this.maxTextLength})`,
      )
    }
    if (job.kind === 'edit') {
      let messageId = Number.isSafeInteger(payload.messageId) && (payload.messageId as number) > 0
        ? payload.messageId as number
        : null
      if (messageId === null && typeof payload.targetSourceKey === 'string') {
        const proof = this.deliveryProofForSourceKey?.(payload.targetSourceKey) ?? null
        const match = proof?.match(/^telegram:([1-9]\d*)$/)
        if (match?.[1] !== undefined) messageId = Number.parseInt(match[1], 10)
      }
      if (messageId === null || !Number.isSafeInteger(messageId)) {
        throw new TelegramDeliveryPayloadError('edit target has no proven Telegram message_id')
      }
      return {
        kind: 'edit',
        jobId: job.id,
        chatId: payload.chatId,
        messageId,
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
    if (prepared.kind === 'send_media') {
      if (this.api.sendMedia === undefined) {
        throw new TelegramDeliveryPayloadError('Telegram API cannot send media')
      }
      let sent: { message_id: number }
      try {
        sent = await this.api.sendMedia(prepared.chatId, prepared.media.kind, prepared.media, prepared.options)
      } catch (error) {
        if (prepared.options.parse_mode !== 'HTML' || !isTelegramHtmlParseError(error)) throw error
        sent = await this.api.sendMedia(
          prepared.chatId,
          prepared.media.kind,
          prepared.media,
          withoutMediaParseMode(prepared.options),
        )
      }
      if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
        throw new TelegramDeliveryPayloadError('Telegram returned an invalid media message_id')
      }
      return { remoteId: `telegram:${sent.message_id}` }
    }
    if (prepared.kind === 'send_album') {
      if (this.api.sendMediaGroup === undefined) {
        throw new TelegramDeliveryPayloadError('Telegram API cannot send albums')
      }
      let sent: readonly { message_id: number }[]
      try {
        sent = await this.api.sendMediaGroup(prepared.chatId, prepared.items)
      } catch (error) {
        if (
          !prepared.items.some((item) => item.options.parse_mode === 'HTML') ||
          !isTelegramHtmlParseError(error)
        ) throw error
        sent = await this.api.sendMediaGroup(
          prepared.chatId,
          prepared.items.map((item) => ({
            ...item,
            options: withoutMediaParseMode(item.options),
          })),
        )
      }
      if (
        sent.length !== prepared.items.length ||
        sent.some((message) => !Number.isSafeInteger(message.message_id) || message.message_id <= 0)
      ) {
        throw new TelegramDeliveryPayloadError('Telegram returned invalid album delivery proof')
      }
      return { remoteId: `telegram-album:${sent.map((message) => message.message_id).join(',')}` }
    }
    if (prepared.kind === 'edit') {
      if (this.api.editMessageText === undefined) {
        throw new TelegramDeliveryPayloadError('Telegram API cannot edit messages')
      }
      try {
        await this.api.editMessageText(
          prepared.chatId,
          prepared.messageId,
          prepared.text,
          prepared.options,
        )
      } catch (error) {
        if (prepared.options.parse_mode !== 'HTML' || !isTelegramHtmlParseError(error)) throw error
        await this.api.editMessageText(
          prepared.chatId,
          prepared.messageId,
          prepared.text,
          withoutParseMode(prepared.options),
        )
      }
      return { remoteId: `telegram:${prepared.messageId}` }
    }
    let sent: { message_id: number }
    try {
      sent = await this.api.sendMessage(prepared.chatId, prepared.text, prepared.options)
    } catch (error) {
      if (prepared.options.parse_mode !== 'HTML' || !isTelegramHtmlParseError(error)) throw error
      sent = await this.api.sendMessage(
        prepared.chatId,
        prepared.text,
        withoutParseMode(prepared.options),
      )
    }
    if (!Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) {
      throw new TelegramDeliveryPayloadError('Telegram returned an invalid message_id')
    }
    return { remoteId: `telegram:${sent.message_id}` }
  }

  private authorizedMessage(update: InboxUpdate): { chatId: string; text: string } | null {
    const authorized = this.authorizedEnvelope(update)
    if (authorized === null || typeof authorized.message.text !== 'string') return null
    return { chatId: authorized.chatId, text: authorized.message.text }
  }

  private authorizedEnvelope(update: InboxUpdate): {
    chatId: string
    message: NonNullable<TelegramMessagePayload['message']>
  } | null {
    if (!isRecord(update.payload)) return null
    const message = (update.payload as TelegramMessagePayload).message
    const chatId = message?.chat?.id
    const senderId = message?.from?.id
    if (message?.chat?.type !== 'private' || message.from?.is_bot === true) return null
    if (chatId === undefined || senderId === undefined || message === undefined) return null
    const normalizedChatId = String(chatId)
    const normalizedSenderId = String(senderId)
    if (!this.allowedChats.has(normalizedChatId) || !this.allowedUsers.has(normalizedSenderId)) {
      return null
    }
    return { chatId: normalizedChatId, message }
  }

  private extractAttachments(
    message: NonNullable<TelegramMessagePayload['message']>,
  ): NonNullable<IncomingTextMessage['attachments']> {
    const photos = message.photo?.filter((photo) =>
      typeof photo.file_id === 'string' && photo.file_id.length > 0
    ) ?? []
    const photo = [...photos].sort((left, right) =>
      ((right.width ?? 0) * (right.height ?? 0)) - ((left.width ?? 0) * (left.height ?? 0))
    )[0]
    if (photo?.file_id !== undefined) {
      return [{
        kind: 'image',
        fileId: photo.file_id,
        uniqueId: typeof photo.file_unique_id === 'string' ? photo.file_unique_id : null,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        declaredSize: Number.isSafeInteger(photo.file_size) && (photo.file_size as number) >= 0
          ? photo.file_size as number
          : null,
      }]
    }
    const document = message.document
    if (typeof document?.file_id === 'string' && document.file_id.length > 0) {
      const mimeType = typeof document.mime_type === 'string'
        ? document.mime_type.toLowerCase().split(';', 1)[0]?.trim() || 'application/octet-stream'
        : 'application/octet-stream'
      return [{
        kind: mimeType.startsWith('image/') ? 'image' : 'file',
        fileId: document.file_id,
        uniqueId: typeof document.file_unique_id === 'string' ? document.file_unique_id : null,
        fileName: typeof document.file_name === 'string' ? document.file_name : null,
        mimeType,
        declaredSize: Number.isSafeInteger(document.file_size) && (document.file_size as number) >= 0
          ? document.file_size as number
          : null,
      }]
    }
    const voice = message.voice
    if (typeof voice?.file_id === 'string' && voice.file_id.length > 0) {
      return [{
        kind: 'audio',
        fileId: voice.file_id,
        uniqueId: typeof voice.file_unique_id === 'string' ? voice.file_unique_id : null,
        fileName: 'voice.ogg',
        mimeType: typeof voice.mime_type === 'string'
          ? voice.mime_type.toLowerCase().split(';', 1)[0]?.trim() || 'audio/ogg'
          : 'audio/ogg',
        declaredSize: Number.isSafeInteger(voice.file_size) && (voice.file_size as number) >= 0
          ? voice.file_size as number
          : null,
        transcribe: true,
      }]
    }
    const audio = message.audio
    if (typeof audio?.file_id === 'string' && audio.file_id.length > 0) {
      return [{
        kind: 'audio',
        fileId: audio.file_id,
        uniqueId: typeof audio.file_unique_id === 'string' ? audio.file_unique_id : null,
        fileName: typeof audio.file_name === 'string' ? audio.file_name : 'audio.bin',
        mimeType: typeof audio.mime_type === 'string'
          ? audio.mime_type.toLowerCase().split(';', 1)[0]?.trim() || 'application/octet-stream'
          : 'application/octet-stream',
        declaredSize: Number.isSafeInteger(audio.file_size) && (audio.file_size as number) >= 0
          ? audio.file_size as number
          : null,
      }]
    }
    const video = message.video
    if (typeof video?.file_id === 'string' && video.file_id.length > 0) {
      return [{
        kind: 'file',
        fileId: video.file_id,
        uniqueId: typeof video.file_unique_id === 'string' ? video.file_unique_id : null,
        fileName: typeof video.file_name === 'string' ? video.file_name : 'video.mp4',
        mimeType: typeof video.mime_type === 'string'
          ? video.mime_type.toLowerCase().split(';', 1)[0]?.trim() || 'video/mp4'
          : 'video/mp4',
        declaredSize: Number.isSafeInteger(video.file_size) && (video.file_size as number) >= 0
          ? video.file_size as number
          : null,
      }]
    }
    return []
  }
}
