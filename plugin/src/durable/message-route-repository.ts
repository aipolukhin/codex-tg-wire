import type { Database } from 'bun:sqlite'

export interface TelegramMessageRoute {
  sourceKey: string
  botId: string
  chatId: string
  projectId: string
  threadId: string
  telegramMessageId: number | null
  createdAtMs: number
  deliveredAtMs: number | null
}

interface RouteRow {
  source_key: string
  bot_id: string
  chat_id: string
  project_id: string
  thread_id: string
  telegram_message_id: number | null
  created_at_ms: number
  delivered_at_ms: number | null
}

function fromRow(row: RouteRow): TelegramMessageRoute {
  return {
    sourceKey: row.source_key,
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    telegramMessageId: row.telegram_message_id,
    createdAtMs: row.created_at_ms,
    deliveredAtMs: row.delivered_at_ms,
  }
}

export class SqliteTelegramMessageRouteRepository {
  constructor(private readonly database: Database) {}

  register(input: Omit<TelegramMessageRoute, 'telegramMessageId' | 'deliveredAtMs'>): void {
    this.database.run(
      `INSERT INTO telegram_message_routes
        (source_key, bot_id, chat_id, project_id, thread_id, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
      [input.sourceKey, input.botId, input.chatId, input.projectId, input.threadId, input.createdAtMs],
    )
  }

  markDelivered(sourceKey: string, telegramMessageId: number, deliveredAtMs: number): void {
    if (!Number.isSafeInteger(telegramMessageId) || telegramMessageId <= 0) {
      throw new TypeError('telegramMessageId must be a positive safe integer')
    }
    const changed = this.database.run(
      `UPDATE telegram_message_routes
       SET telegram_message_id = ?, delivered_at_ms = ?
       WHERE source_key = ?
         AND (telegram_message_id IS NULL OR telegram_message_id = ?)`,
      [telegramMessageId, deliveredAtMs, sourceKey, telegramMessageId],
    ).changes
    if (changed > 1) throw new Error('message route update touched multiple rows')
  }

  getBySourceKey(sourceKey: string): TelegramMessageRoute | null {
    const row = this.database
      .query<RouteRow, [string]>(
        `SELECT * FROM telegram_message_routes
         WHERE source_key = ?`,
      )
      .get(sourceKey)
    return row === null ? null : fromRow(row)
  }

  findByTelegramMessage(
    botId: string,
    chatId: string,
    telegramMessageId: number,
  ): TelegramMessageRoute | null {
    const row = this.database
      .query<RouteRow, [string, string, number]>(
        `SELECT * FROM telegram_message_routes
         WHERE bot_id = ? AND chat_id = ? AND telegram_message_id = ?`,
      )
      .get(botId, chatId, telegramMessageId)
    return row === null ? null : fromRow(row)
  }
}
