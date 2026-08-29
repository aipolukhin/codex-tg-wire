import type { Database } from 'bun:sqlite'

import {
  LeaseConflictError,
  type DeliveryJob,
  type DeliveryJobInput,
  type DeliveryKind,
  type DeliveryState,
  type EnqueueResult,
  type InboxRepository,
  type InboxState,
  type InboxUpdate,
  type IngestResult,
  type LeaseFailure,
  type LeaseOptions,
  type OutboxRepository,
  type RecoveryResult,
  type TelegramUpdateInput,
} from './contracts.js'

interface InboxRow {
  id: number
  bot_id: string
  update_id: number
  chat_id: string | null
  payload_json: string
  state: InboxState
  attempt_count: number
  available_at_ms: number
  lease_owner: string | null
  lease_expires_at_ms: number | null
  received_at_ms: number
  processed_at_ms: number | null
  last_error: string | null
}

interface DeliveryRow {
  id: string
  source_key: string
  session_id: string | null
  kind: DeliveryKind
  payload_json: string
  state: DeliveryState
  attempt_count: number
  available_at_ms: number
  expires_at_ms: number | null
  lease_owner: string | null
  lease_expires_at_ms: number | null
  send_started_at_ms: number | null
  remote_id: string | null
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
  delivered_at_ms: number | null
}

function encodePayload(payload: unknown): string {
  const encoded = JSON.stringify(payload)
  if (encoded === undefined) throw new TypeError('payload must be JSON-serializable')
  return encoded
}

function validateLease(options: LeaseOptions): void {
  if (options.workerId.trim().length === 0) throw new TypeError('workerId must not be empty')
  if (!Number.isSafeInteger(options.nowMs)) throw new TypeError('nowMs must be a safe integer')
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
    throw new TypeError('leaseDurationMs must be a positive safe integer')
  }
}

function inboxFromRow(row: InboxRow): InboxUpdate {
  return {
    id: row.id,
    botId: row.bot_id,
    updateId: row.update_id,
    chatId: row.chat_id,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    attemptCount: row.attempt_count,
    availableAtMs: row.available_at_ms,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    receivedAtMs: row.received_at_ms,
    processedAtMs: row.processed_at_ms,
    lastError: row.last_error,
  }
}

function deliveryFromRow(row: DeliveryRow): DeliveryJob {
  return {
    id: row.id,
    sourceKey: row.source_key,
    sessionId: row.session_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    attemptCount: row.attempt_count,
    availableAtMs: row.available_at_ms,
    expiresAtMs: row.expires_at_ms,
    leaseOwner: row.lease_owner,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    sendStartedAtMs: row.send_started_at_ms,
    remoteId: row.remote_id,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    deliveredAtMs: row.delivered_at_ms,
  }
}

export class SqliteInboxRepository implements InboxRepository {
  constructor(private readonly database: Database) {}

  ingest(input: TelegramUpdateInput): IngestResult {
    const receivedAtMs = input.receivedAtMs ?? Date.now()
    const result = this.database.run(
      `INSERT INTO telegram_updates
        (bot_id, update_id, chat_id, payload_json, available_at_ms, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, update_id) DO NOTHING`,
      [
        input.botId,
        input.updateId,
        input.chatId ?? null,
        encodePayload(input.payload),
        receivedAtMs,
        receivedAtMs,
      ],
    )
    const row = this.database
      .query<InboxRow, [string, number]>(
        'SELECT * FROM telegram_updates WHERE bot_id = ? AND update_id = ?',
      )
      .get(input.botId, input.updateId)
    if (row === null) throw new Error('inbox insert did not produce a row')
    return { created: result.changes === 1, update: inboxFromRow(row) }
  }

  get(id: number): InboxUpdate | null {
    const row = this.database
      .query<InboxRow, [number]>('SELECT * FROM telegram_updates WHERE id = ?')
      .get(id)
    return row === null ? null : inboxFromRow(row)
  }

  claimNext(options: LeaseOptions): InboxUpdate | null {
    validateLease(options)
    return this.database.transaction(() => {
      const candidate = this.database
        .query<{ id: number }, [number]>(
          `SELECT id FROM telegram_updates
           WHERE state IN ('RECEIVED', 'RETRY_WAIT') AND available_at_ms <= ?
           ORDER BY update_id, id
           LIMIT 1`,
        )
        .get(options.nowMs)
      if (candidate === null) return null

      this.database.run(
        `UPDATE telegram_updates
         SET state = 'LEASED', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_expires_at_ms = ?, last_error = NULL
         WHERE id = ? AND state IN ('RECEIVED', 'RETRY_WAIT')`,
        [options.workerId, options.nowMs + options.leaseDurationMs, candidate.id],
      )
      return this.get(candidate.id)
    }).immediate()
  }

  markProcessed(id: number, workerId: string, nowMs: number): InboxUpdate {
    const result = this.database.run(
      `UPDATE telegram_updates
       SET state = 'PROCESSED', lease_owner = NULL, lease_expires_at_ms = NULL,
           processed_at_ms = ?, last_error = NULL
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
      [nowMs, id, workerId],
    )
    if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
    return this.require(id)
  }

  retry(id: number, workerId: string, error: string, availableAtMs: number): InboxUpdate {
    const result = this.database.run(
      `UPDATE telegram_updates
       SET state = 'RETRY_WAIT', available_at_ms = ?, lease_owner = NULL,
           lease_expires_at_ms = NULL, last_error = ?
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
      [availableAtMs, error, id, workerId],
    )
    if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
    return this.require(id)
  }

  fail(id: number, workerId: string, error: string, nowMs: number): InboxUpdate {
    const result = this.database.run(
      `UPDATE telegram_updates
       SET state = 'FAILED', lease_owner = NULL, lease_expires_at_ms = NULL,
           processed_at_ms = ?, last_error = ?
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
      [nowMs, error, id, workerId],
    )
    if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
    return this.require(id)
  }

  recoverExpiredLeases(nowMs: number): number {
    return this.database.run(
      `UPDATE telegram_updates
       SET state = 'RECEIVED', available_at_ms = ?, lease_owner = NULL,
           lease_expires_at_ms = NULL, last_error = 'worker lease expired'
       WHERE state = 'LEASED' AND lease_expires_at_ms <= ?`,
      [nowMs, nowMs],
    ).changes
  }

  private require(id: number): InboxUpdate {
    const update = this.get(id)
    if (update === null) throw new Error(`inbox update ${id} not found`)
    return update
  }
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly database: Database) {}

  enqueue(input: DeliveryJobInput): EnqueueResult {
    const createdAtMs = input.createdAtMs ?? Date.now()
    const id = input.id ?? crypto.randomUUID()
    const result = this.database.run(
      `INSERT INTO delivery_jobs
        (id, source_key, session_id, kind, payload_json, state, available_at_ms,
         expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
      [
        id,
        input.sourceKey,
        input.sessionId ?? null,
        input.kind,
        encodePayload(input.payload),
        input.availableAtMs ?? createdAtMs,
        input.expiresAtMs ?? null,
        createdAtMs,
        createdAtMs,
      ],
    )
    const job = this.getBySourceKey(input.sourceKey)
    if (job === null) throw new Error('outbox insert did not produce a row')
    return { created: result.changes === 1, job }
  }

  get(id: string): DeliveryJob | null {
    const row = this.database
      .query<DeliveryRow, [string]>('SELECT * FROM delivery_jobs WHERE id = ?')
      .get(id)
    return row === null ? null : deliveryFromRow(row)
  }

  getBySourceKey(sourceKey: string): DeliveryJob | null {
    const row = this.database
      .query<DeliveryRow, [string]>('SELECT * FROM delivery_jobs WHERE source_key = ?')
      .get(sourceKey)
    return row === null ? null : deliveryFromRow(row)
  }

  claimNext(options: LeaseOptions): DeliveryJob | null {
    validateLease(options)
    return this.database.transaction(() => {
      this.expireReady(options.nowMs)
      const candidate = this.database
        .query<{ id: string }, [number]>(
          `SELECT id FROM delivery_jobs
           WHERE state IN ('PENDING', 'RETRY_WAIT') AND available_at_ms <= ?
           ORDER BY created_at_ms, id
           LIMIT 1`,
        )
        .get(options.nowMs)
      if (candidate === null) return null

      this.database.run(
        `UPDATE delivery_jobs
         SET state = 'LEASED', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_expires_at_ms = ?, send_started_at_ms = NULL,
             last_error = NULL, updated_at_ms = ?
         WHERE id = ? AND state IN ('PENDING', 'RETRY_WAIT')`,
        [
          options.workerId,
          options.nowMs + options.leaseDurationMs,
          options.nowMs,
          candidate.id,
        ],
      )
      return this.get(candidate.id)
    }).immediate()
  }

  markSendStarted(id: string, workerId: string, nowMs: number): DeliveryJob {
    const result = this.database.run(
      `UPDATE delivery_jobs
       SET send_started_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?
         AND lease_expires_at_ms > ? AND send_started_at_ms IS NULL`,
      [nowMs, nowMs, id, workerId, nowMs],
    )
    if (result.changes !== 1) throw new LeaseConflictError('delivery job', id)
    return this.require(id)
  }

  markDelivered(id: string, workerId: string, remoteId: string, nowMs: number): DeliveryJob {
    if (remoteId.trim().length === 0) throw new TypeError('remoteId is required delivery proof')
    const result = this.database.run(
      `UPDATE delivery_jobs
       SET state = 'DELIVERED', remote_id = ?, delivered_at_ms = ?, updated_at_ms = ?,
           lease_owner = NULL, lease_expires_at_ms = NULL, last_error = NULL
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
      [remoteId, nowMs, nowMs, id, workerId],
    )
    if (result.changes !== 1) throw new LeaseConflictError('delivery job', id)
    return this.require(id)
  }

  failLease(
    id: string,
    workerId: string,
    error: string,
    nowMs: number,
    retryAtMs?: number,
  ): LeaseFailure {
    return this.database.transaction(() => {
      const job = this.require(id)
      if (job.state !== 'LEASED' || job.leaseOwner !== workerId) {
        throw new LeaseConflictError('delivery job', id)
      }

      const becameAmbiguous = job.sendStartedAtMs !== null
      const state: DeliveryState = becameAmbiguous
        ? 'AMBIGUOUS'
        : retryAtMs === undefined
          ? 'FAILED'
          : 'RETRY_WAIT'
      const availableAtMs = retryAtMs ?? job.availableAtMs
      this.database.run(
        `UPDATE delivery_jobs
         SET state = ?, available_at_ms = ?, lease_owner = NULL,
             lease_expires_at_ms = NULL, last_error = ?, updated_at_ms = ?
         WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
        [state, availableAtMs, error, nowMs, id, workerId],
      )
      return { job: this.require(id), becameAmbiguous }
    }).immediate()
  }

  recoverExpiredLeases(nowMs: number): RecoveryResult {
    return this.database.transaction(() => {
      let expired = this.expireReady(nowMs)
      expired += this.database.run(
        `UPDATE delivery_jobs
         SET state = 'EXPIRED', lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = 'delivery TTL expired before send', updated_at_ms = ?
         WHERE state = 'LEASED' AND lease_expires_at_ms <= ?
           AND send_started_at_ms IS NULL AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
        [nowMs, nowMs, nowMs],
      ).changes
      const retryable = this.database.run(
        `UPDATE delivery_jobs
         SET state = 'PENDING', available_at_ms = ?, lease_owner = NULL,
             lease_expires_at_ms = NULL, last_error = 'worker lease expired before send',
             updated_at_ms = ?
         WHERE state = 'LEASED' AND lease_expires_at_ms <= ? AND send_started_at_ms IS NULL
           AND (expires_at_ms IS NULL OR expires_at_ms > ?)`,
        [nowMs, nowMs, nowMs, nowMs],
      ).changes
      const ambiguous = this.database.run(
        `UPDATE delivery_jobs
         SET state = 'AMBIGUOUS', lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = 'worker lease expired after send started', updated_at_ms = ?
         WHERE state = 'LEASED' AND lease_expires_at_ms <= ? AND send_started_at_ms IS NOT NULL`,
        [nowMs, nowMs],
      ).changes
      return { retryable, ambiguous, expired }
    }).immediate()
  }

  private expireReady(nowMs: number): number {
    return this.database.run(
      `UPDATE delivery_jobs
       SET state = 'EXPIRED', last_error = 'delivery TTL expired', updated_at_ms = ?
       WHERE state IN ('PENDING', 'RETRY_WAIT') AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
      [nowMs, nowMs],
    ).changes
  }

  private require(id: string): DeliveryJob {
    const job = this.get(id)
    if (job === null) throw new Error(`delivery job ${id} not found`)
    return job
  }
}
