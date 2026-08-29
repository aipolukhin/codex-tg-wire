import type { Database } from 'bun:sqlite'

export interface PollCursor {
  botId: string
  nextUpdateId: number
  updatedAtMs: number
}

interface PollCursorRow {
  bot_id: string
  next_update_id: number
  updated_at_ms: number
}

function fromRow(row: PollCursorRow): PollCursor {
  return {
    botId: row.bot_id,
    nextUpdateId: row.next_update_id,
    updatedAtMs: row.updated_at_ms,
  }
}

export class SqlitePollCursorRepository {
  constructor(private readonly database: Database) {}

  get(botId: string): PollCursor | null {
    const row = this.database
      .query<PollCursorRow, [string]>(
        'SELECT * FROM telegram_poll_cursors WHERE bot_id = ?',
      )
      .get(botId)
    return row === null ? null : fromRow(row)
  }

  advance(botId: string, nextUpdateId: number, nowMs: number): PollCursor {
    if (botId.trim().length === 0) throw new TypeError('botId must not be empty')
    if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) {
      throw new TypeError('nextUpdateId must be a non-negative safe integer')
    }
    this.database.run(
      `INSERT INTO telegram_poll_cursors (bot_id, next_update_id, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (bot_id) DO UPDATE SET
         next_update_id = excluded.next_update_id,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.next_update_id > telegram_poll_cursors.next_update_id`,
      [botId, nextUpdateId, nowMs],
    )
    const cursor = this.get(botId)
    if (cursor === null) throw new Error(`poll cursor for ${botId} was not persisted`)
    return cursor
  }
}
