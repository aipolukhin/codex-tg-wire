const FORWARD_COMMENT_FIELD = '__codex_tg_wire_forward_comment'

interface TelegramMessageEnvelope {
  message?: Record<string, unknown>
}

export interface EmbeddedForwardComment {
  text: string
  sourceUpdateRowId: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null
  const message = (payload as TelegramMessageEnvelope).message
  return isRecord(message) ? message : null
}

function hasForwardMarker(message: Record<string, unknown>): boolean {
  return isRecord(message.forward_origin) ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined ||
    message.forward_date !== undefined ||
    message.is_automatic_forward === true
}

export function isForwardedTelegramUpdate(payload: unknown): boolean {
  const message = messageFromPayload(payload)
  return message !== null && hasForwardMarker(message)
}

export function forwardCommentCandidate(payload: unknown): {
  text: string
  chatId: string
  senderId: string
} | null {
  const message = messageFromPayload(payload)
  if (message === null || hasForwardMarker(message)) return null
  if (message.reply_to_message !== undefined || message.media_group_id !== undefined) return null
  if (
    message.photo !== undefined || message.document !== undefined || message.voice !== undefined ||
    message.audio !== undefined || message.video !== undefined || message.animation !== undefined ||
    message.sticker !== undefined || message.rich_message !== undefined
  ) return null
  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (text.length === 0 || text.startsWith('/')) return null
  const chat = isRecord(message.chat) ? message.chat : null
  const from = isRecord(message.from) ? message.from : null
  if (chat?.id === undefined || from?.id === undefined || from.is_bot === true) return null
  return { text, chatId: String(chat.id), senderId: String(from.id) }
}

export function forwardedTelegramIdentity(payload: unknown): {
  chatId: string
  senderId: string
} | null {
  const message = messageFromPayload(payload)
  if (message === null || !hasForwardMarker(message)) return null
  const chat = isRecord(message.chat) ? message.chat : null
  const from = isRecord(message.from) ? message.from : null
  if (chat?.id === undefined || from?.id === undefined || from.is_bot === true) return null
  return { chatId: String(chat.id), senderId: String(from.id) }
}

export function withEmbeddedForwardComment(
  payload: unknown,
  comment: EmbeddedForwardComment,
): unknown {
  if (!isRecord(payload)) throw new TypeError('forwarded update payload must be an object')
  return {
    ...payload,
    [FORWARD_COMMENT_FIELD]: {
      text: comment.text,
      source_update_row_id: comment.sourceUpdateRowId,
    },
  }
}

export function embeddedForwardComment(payload: unknown): EmbeddedForwardComment | null {
  if (!isRecord(payload)) return null
  const value = payload[FORWARD_COMMENT_FIELD]
  if (!isRecord(value) || typeof value.text !== 'string') return null
  if (!Number.isSafeInteger(value.source_update_row_id) || (value.source_update_row_id as number) <= 0) {
    return null
  }
  const text = value.text.trim()
  if (text.length === 0) return null
  return { text, sourceUpdateRowId: value.source_update_row_id as number }
}
