import { createHash } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import type { AgentEventDiagnostics } from '../bridge/contracts.js'

export interface CodexUnhandledNotificationRecord {
  method: string
  threadId: string | null
  turnId: string | null
  occurrenceCount: number
  firstSeenAtMs: number
  lastSeenAtMs: number
}

interface EventRow {
  method: string
  thread_id: string
  turn_id: string
  occurrence_count: number
  first_seen_at_ms: number
  last_seen_at_ms: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (/^[A-Za-z0-9._:/-]{1,160}$/.test(value)) return value
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16)
  return `${label}:sha256:${digest}`
}

function methodValue(value: string): string {
  if (/^[A-Za-z0-9._/-]{1,200}$/.test(value)) return value
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16)
  return `unknown:sha256:${digest}`
}

export class SqliteCodexEventRepository implements AgentEventDiagnostics {
  private readonly now: () => number
  private readonly maxRows: number

  constructor(
    private readonly database: Database,
    options: { now?: () => number; maxRows?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxRows = options.maxRows ?? 1_000
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1 || this.maxRows > 10_000) {
      throw new TypeError('diagnostic event maxRows must be between 1 and 10000')
    }
  }

  recordUnhandledNotification(notification: { method: string; params?: unknown }): void {
    const params = isRecord(notification.params) ? notification.params : null
    const turn = params !== null && isRecord(params.turn) ? params.turn : null
    const method = methodValue(notification.method)
    const threadId = safeValue(params?.threadId, 'thread')
    const turnId = safeValue(params?.turnId ?? turn?.id, 'turn')
    const nowMs = this.now()
    this.database.run(
      `INSERT INTO codex_unhandled_notifications
        (method, thread_id, turn_id, occurrence_count, first_seen_at_ms, last_seen_at_ms)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (method, thread_id, turn_id) DO UPDATE SET
         occurrence_count = occurrence_count + 1,
         last_seen_at_ms = excluded.last_seen_at_ms`,
      [method, threadId, turnId, nowMs, nowMs],
    )
    this.database.run(
      `DELETE FROM codex_unhandled_notifications
       WHERE id NOT IN (
         SELECT id FROM codex_unhandled_notifications
         ORDER BY last_seen_at_ms DESC, id DESC LIMIT ?
       )`,
      [this.maxRows],
    )
  }

  list(limit = 100): CodexUnhandledNotificationRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('diagnostic event limit must be between 1 and 1000')
    }
    return this.database
      .query<EventRow, [number]>(
        `SELECT method, thread_id, turn_id, occurrence_count,
                first_seen_at_ms, last_seen_at_ms
         FROM codex_unhandled_notifications
         ORDER BY last_seen_at_ms DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        method: row.method,
        threadId: row.thread_id || null,
        turnId: row.turn_id || null,
        occurrenceCount: row.occurrence_count,
        firstSeenAtMs: row.first_seen_at_ms,
        lastSeenAtMs: row.last_seen_at_ms,
      }))
  }
}
