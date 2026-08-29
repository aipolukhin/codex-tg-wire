import type { IngestResult } from '../durable/contracts.js'
import type { SqlitePollCursorRepository } from '../durable/poll-cursor-repository.js'

export interface TelegramGetUpdatesOptions {
  offset?: number
  timeout: number
  allowed_updates: readonly string[]
}

export interface TelegramUpdateSource {
  getUpdates(options: TelegramGetUpdatesOptions, signal?: AbortSignal): Promise<unknown[]>
}

export interface DurableUpdateSink {
  ingest(update: unknown, receivedAtMs?: number): IngestResult
}

export interface DurablePollResult {
  fetched: number
  inserted: number
  duplicates: number
  nextUpdateId: number | null
}

export interface DurableTelegramPollerOptions {
  timeoutSeconds?: number
  allowedUpdates?: readonly string[]
  now?: () => number
}

const DEFAULT_ALLOWED_UPDATES = ['message', 'callback_query'] as const

function updateId(update: unknown): number {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    throw new TypeError('Telegram getUpdates returned a non-object update')
  }
  const value = (update as { update_id?: unknown }).update_id
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('Telegram getUpdates returned an invalid update_id')
  }
  return value as number
}

export class DurableTelegramPoller {
  private readonly timeoutSeconds: number
  private readonly allowedUpdates: readonly string[]
  private readonly now: () => number

  constructor(
    private readonly botId: string,
    private readonly source: TelegramUpdateSource,
    private readonly sink: DurableUpdateSink,
    private readonly cursors: SqlitePollCursorRepository,
    options: DurableTelegramPollerOptions = {},
  ) {
    if (botId.trim().length === 0) throw new TypeError('botId must not be empty')
    this.timeoutSeconds = options.timeoutSeconds ?? 30
    this.allowedUpdates = options.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.timeoutSeconds) || this.timeoutSeconds < 0) {
      throw new TypeError('timeoutSeconds must be a non-negative safe integer')
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<DurablePollResult> {
    const current = this.cursors.get(this.botId)
    const request: TelegramGetUpdatesOptions = {
      timeout: this.timeoutSeconds,
      allowed_updates: this.allowedUpdates,
      ...(current === null ? {} : { offset: current.nextUpdateId }),
    }
    const fetched = await this.source.getUpdates(request, signal)
    const ordered = fetched
      .map((update) => ({ update, updateId: updateId(update) }))
      .sort((left, right) => left.updateId - right.updateId)

    let inserted = 0
    let duplicates = 0
    let nextUpdateId = current?.nextUpdateId ?? null
    for (const item of ordered) {
      const accepted = this.sink.ingest(item.update, this.now())
      if (accepted.created) inserted += 1
      else duplicates += 1

      const cursor = this.cursors.advance(this.botId, item.updateId + 1, this.now())
      nextUpdateId = cursor.nextUpdateId
    }
    return { fetched: fetched.length, inserted, duplicates, nextUpdateId }
  }
}
