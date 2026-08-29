import type { Api } from 'grammy'
import type { Update } from 'grammy/types'

import type { TelegramMessageOptions, TelegramTextApi } from './durable-text-gateway.js'
import type {
  TelegramGetUpdatesOptions,
  TelegramUpdateSource,
} from './durable-poller.js'

type AllowedUpdate = Exclude<keyof Update, 'update_id'>

/** Keeps all raw grammY calls behind the durable transport boundaries. */
export class GrammyDurableAdapter implements TelegramTextApi, TelegramUpdateSource {
  constructor(private readonly api: Api) {}

  sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }> {
    return this.api.sendMessage(chatId, text, options)
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<unknown> {
    return this.api.editMessageText(chatId, messageId, text, options)
  }

  answerCallbackQuery(callbackQueryId: string, options: { text?: string }): Promise<true> {
    return this.api.answerCallbackQuery(callbackQueryId, options)
  }

  getUpdates(options: TelegramGetUpdatesOptions, signal?: AbortSignal): Promise<unknown[]> {
    return this.api.getUpdates(
      {
        timeout: options.timeout,
        allowed_updates: options.allowed_updates as readonly AllowedUpdate[],
        ...(options.offset === undefined ? {} : { offset: options.offset }),
      },
      signal,
    )
  }
}
