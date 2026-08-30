import { InputFile, type Api } from 'grammy'
import type {
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
  Update,
} from 'grammy/types'

import type {
  TelegramAlbumUploadItem,
  TelegramMediaOptions,
  TelegramMessageOptions,
  TelegramTextApi,
} from './durable-text-gateway.js'
import type { PreparedLocalMedia, TelegramMediaKind } from './durable-outbound-media.js'
import type {
  TelegramGetUpdatesOptions,
  TelegramUpdateSource,
} from './durable-poller.js'
import {
  AttachmentDownloadLimitError,
  type TelegramAttachmentDownload,
} from './durable-attachment-store.js'
import type { DurableTelegramRateLimiter } from './durable-rate-limiter.js'

type AllowedUpdate = Exclude<keyof Update, 'update_id'>

/** Keeps all raw grammY calls behind the durable transport boundaries. */
export class GrammyDurableAdapter implements TelegramTextApi, TelegramUpdateSource {
  constructor(
    private readonly api: Api,
    private readonly token?: string,
    private readonly apiRoot = 'https://api.telegram.org',
    private readonly limiter?: DurableTelegramRateLimiter,
  ) {}

  async downloadAttachment(
    fileId: string,
    maxBytes: number,
  ): Promise<TelegramAttachmentDownload> {
    if (this.token === undefined) throw new Error('Telegram attachment download is not configured')
    const file = await this.run('getFile', () => this.api.getFile(fileId))
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new AttachmentDownloadLimitError()
    }
    if (file.file_path === undefined) throw new Error('Telegram returned no attachment path')
    let response: Response
    try {
      const root = this.apiRoot.replace(/\/+$/, '')
      response = await this.run('downloadAttachment', async () => {
        const fetched = await fetch(`${root}/file/bot${this.token}/${file.file_path}`)
        if (fetched.status === 429) {
          await fetched.body?.cancel().catch(() => undefined)
          const error = new Error('Telegram attachment download rate limited') as Error & {
            error_code: number
            parameters: { retry_after: number }
          }
          error.error_code = 429
          error.parameters = {
            retry_after: Number.parseInt(fetched.headers.get('retry-after') ?? '1', 10) || 1,
          }
          throw error
        }
        return fetched
      })
    } catch {
      throw new Error('Telegram attachment download failed')
    }
    if (!response.ok) throw new Error(`Telegram attachment download failed with HTTP ${response.status}`)
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new AttachmentDownloadLimitError()
    }
    if (response.body === null) throw new Error('Telegram attachment response has no body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new AttachmentDownloadLimitError()
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return {
      bytes,
      fileSize: size,
      uniqueId: file.file_unique_id ?? null,
    }
  }

  sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }> {
    return this.runSend(chatId, 'sendMessage', () => this.api.sendMessage(chatId, text, options))
  }

  deleteMessage(chatId: string, messageId: number): Promise<true> {
    return this.run('deleteMessage', () => this.api.deleteMessage(chatId, messageId))
  }

  sendChatAction(chatId: string, action: 'typing'): Promise<true> {
    return this.run('sendChatAction', () => this.api.sendChatAction(chatId, action))
  }

  setMessageReaction(chatId: string, messageId: number, emoji: '👀'): Promise<true> {
    return this.run('setMessageReaction', () => this.api.setMessageReaction(
      chatId,
      messageId,
      [{ type: 'emoji', emoji }],
      { is_big: false },
    ))
  }

  pinChatMessage(chatId: string, messageId: number): Promise<true> {
    return this.run('pinChatMessage', () => this.api.pinChatMessage(
      chatId,
      messageId,
      { disable_notification: true },
    ))
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<unknown> {
    return this.run('editMessageText', () => this.api.editMessageText(chatId, messageId, text, options))
  }

  answerCallbackQuery(callbackQueryId: string, options: { text?: string }): Promise<true> {
    return this.run('answerCallbackQuery', () => this.api.answerCallbackQuery(callbackQueryId, options))
  }

  sendMedia(
    chatId: string,
    kind: TelegramMediaKind,
    media: PreparedLocalMedia,
    options: TelegramMediaOptions,
  ): Promise<{ message_id: number }> {
    return this.runSend<{ message_id: number }>(chatId, `sendMedia:${kind}`, async () => {
      const input = new InputFile(media.path, media.fileName)
      switch (kind) {
        case 'photo': return await this.api.sendPhoto(chatId, input, options)
        case 'document': return await this.api.sendDocument(chatId, input, options)
        case 'audio': return await this.api.sendAudio(chatId, input, options)
        case 'video': return await this.api.sendVideo(chatId, input, options)
        case 'voice': return await this.api.sendVoice(chatId, input, options)
      }
    })
  }

  sendMediaGroup(
    chatId: string,
    items: readonly TelegramAlbumUploadItem[],
  ): Promise<readonly { message_id: number }[]> {
    const media: Array<InputMediaAudio | InputMediaDocument | InputMediaPhoto | InputMediaVideo> =
      items.map((item) => ({
        type: item.kind,
        media: new InputFile(item.media.path, item.media.fileName),
        ...item.options,
      }) as InputMediaAudio | InputMediaDocument | InputMediaPhoto | InputMediaVideo)
    return this.runSend(chatId, 'sendMediaGroup', () => this.api.sendMediaGroup(chatId, media))
  }

  getUpdates(options: TelegramGetUpdatesOptions, signal?: AbortSignal): Promise<unknown[]> {
    return this.run('getUpdates', () =>
      this.api.getUpdates(
        {
          timeout: options.timeout,
          allowed_updates: options.allowed_updates as readonly AllowedUpdate[],
          ...(options.offset === undefined ? {} : { offset: options.offset }),
        },
        signal,
      ),
    )
  }

  private run<T>(method: string, operation: () => Promise<T>): Promise<T> {
    return this.limiter?.run(method, operation) ?? operation()
  }

  private runSend<T>(chatId: string, method: string, operation: () => Promise<T>): Promise<T> {
    return this.limiter?.runSend(chatId, method, operation) ?? operation()
  }
}
