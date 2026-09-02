import type { Database } from 'bun:sqlite'

import {
  forwardCommentCandidate,
  forwardedTelegramIdentity,
  isForwardedTelegramUpdate,
  withEmbeddedForwardComment,
} from '../telegram/forward-comment.js'

import {
  LeaseConflictError,
  type DeliveryJob,
  type DeliveryJobInput,
  type DeliveryKind,
  type DeliveryProblemActionInput,
  type DeliveryProblemActionResult,
  type DeliveryProblemState,
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
  type UpdateRoutingClass,
} from './contracts.js'

interface InboxRow {
  id: number
  bot_id: string
  update_id: number
  chat_id: string | null
  routing_class: UpdateRoutingClass
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
  depends_on_source_key: string | null
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

interface DeliveryProblemActionRow {
  operation_key: string
  job_id: string
  action: DeliveryProblemActionInput['action']
  actor_bot_id: string
  actor_chat_id: string
  remote_id: string | null
}

interface AlbumGroupRow {
  id: number
  leader_update_row_id: number
  state: 'COLLECTING' | 'PROCESSING' | 'PROCESSED' | 'FAILED'
}

export interface RegisterAlbumFragmentInput {
  updateRowId: number
  mediaGroupId: string
  readyAtMs: number
  nowMs: number
}

export interface RegisterAlbumFragmentResult {
  grouped: boolean
  leaderUpdateRowId: number | null
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
    routingClass: row.routing_class,
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
    dependsOnSourceKey: row.depends_on_source_key,
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
    const availableAtMs = input.availableAtMs ?? receivedAtMs
    if (!Number.isSafeInteger(receivedAtMs) || !Number.isSafeInteger(availableAtMs)) {
      throw new TypeError('inbox timestamps must be safe integers')
    }
    const result = this.database.run(
      `INSERT INTO telegram_updates
        (bot_id, update_id, chat_id, routing_class, payload_json, available_at_ms, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, update_id) DO NOTHING`,
      [
        input.botId,
        input.updateId,
        input.chatId ?? null,
        input.routingClass ?? 'OTHER',
        encodePayload(input.payload),
        availableAtMs,
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

  coalesceForwardComment(forwardUpdateRowId: number, windowMs: number, nowMs: number): boolean {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) return false
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer')
    return this.database.transaction(() => {
      const forwarded = this.database
        .query<InboxRow, [number]>('SELECT * FROM telegram_updates WHERE id = ?')
        .get(forwardUpdateRowId)
      if (forwarded === null || forwarded.state !== 'RECEIVED') return false
      const forwardedPayload = JSON.parse(forwarded.payload_json) as unknown
      if (!isForwardedTelegramUpdate(forwardedPayload)) return false
      const forwardedIdentity = forwardedTelegramIdentity(forwardedPayload)
      if (forwardedIdentity === null) return false

      const previous = this.database
        .query<InboxRow, [string, number]>(
          `SELECT * FROM telegram_updates
           WHERE bot_id = ? AND update_id < ?
           ORDER BY update_id DESC LIMIT 1`,
        )
        .get(forwarded.bot_id, forwarded.update_id)
      if (
        previous === null ||
        previous.state !== 'RECEIVED' ||
        forwarded.received_at_ms - previous.received_at_ms < 0 ||
        forwarded.received_at_ms - previous.received_at_ms > windowMs
      ) return false
      const comment = forwardCommentCandidate(JSON.parse(previous.payload_json) as unknown)
      if (
        comment === null ||
        comment.chatId !== forwardedIdentity.chatId ||
        comment.senderId !== forwardedIdentity.senderId
      ) return false

      const consumed = this.database.run(
        `UPDATE telegram_updates
         SET state = 'PROCESSED', processed_at_ms = ?, last_error = 'coalesced with forwarded message'
         WHERE id = ? AND state = 'RECEIVED'
           AND NOT EXISTS (SELECT 1 FROM turns WHERE source_update_id = telegram_updates.id)`,
        [nowMs, previous.id],
      )
      if (consumed.changes !== 1) return false
      const tagged = withEmbeddedForwardComment(forwardedPayload, {
        text: comment.text,
        sourceUpdateRowId: previous.id,
      })
      const attached = this.database.run(
        `UPDATE telegram_updates SET payload_json = ?
         WHERE id = ? AND state = 'RECEIVED'`,
        [encodePayload(tagged), forwarded.id],
      )
      if (attached.changes !== 1) throw new Error('forwarded update changed during comment coalescing')
      return true
    }).immediate()
  }

  releaseStrandedQueuedSources(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer')
    return this.database.transaction(() => {
      const candidates = this.database.query<{ source_update_id: number }, []>(
        `SELECT DISTINCT turns.source_update_id
         FROM turns
         JOIN telegram_updates source ON source.id = turns.source_update_id
         WHERE turns.state = 'QUEUED'
           AND turns.source_update_id IS NOT NULL
           AND source.state = 'PROCESSED'
         ORDER BY turns.source_update_id`,
      ).all()
      for (const candidate of candidates) {
        const album = this.albumForLeader(candidate.source_update_id)
        if (album === null) {
          this.database.run(
            `UPDATE telegram_updates
             SET state = 'RETRY_WAIT', routing_class = 'QUEUED_MESSAGE', attempt_count = 0,
                 available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
                 processed_at_ms = NULL, last_error = 'stranded queued turn recovered after restart'
             WHERE id = ? AND state = 'PROCESSED'`,
            [nowMs, candidate.source_update_id],
          )
          continue
        }
        this.database.run(
          `UPDATE telegram_updates
           SET state = 'RETRY_WAIT',
               routing_class = CASE WHEN id = ? THEN 'QUEUED_MESSAGE' ELSE routing_class END,
               attempt_count = 0, available_at_ms = ?, lease_owner = NULL,
               lease_expires_at_ms = NULL, processed_at_ms = NULL,
               last_error = 'stranded queued album recovered after restart'
           WHERE id IN (
             SELECT update_row_id FROM telegram_album_fragments WHERE group_id = ?
           ) AND state = 'PROCESSED'`,
          [candidate.source_update_id, nowMs, album.id],
        )
        this.database.run(
          `UPDATE telegram_album_groups
           SET state = 'COLLECTING', ready_at_ms = ?, processed_at_ms = NULL,
               updated_at_ms = ?, last_error = 'stranded queued album recovered after restart'
           WHERE id = ?`,
          [nowMs, nowMs, album.id],
        )
      }
      return candidates.length
    }).immediate()
  }

  get(id: number): InboxUpdate | null {
    const row = this.database
      .query<InboxRow, [number]>('SELECT * FROM telegram_updates WHERE id = ?')
      .get(id)
    return row === null ? null : inboxFromRow(row)
  }

  registerAlbumFragment(input: RegisterAlbumFragmentInput): RegisterAlbumFragmentResult {
    if (input.mediaGroupId.trim().length === 0) throw new TypeError('mediaGroupId must not be empty')
    if (!Number.isSafeInteger(input.readyAtMs) || !Number.isSafeInteger(input.nowMs)) {
      throw new TypeError('album timestamps must be safe integers')
    }
    return this.database.transaction(() => {
      const update = this.get(input.updateRowId)
      if (update === null) throw new Error(`inbox update ${input.updateRowId} not found`)
      if (update.chatId === null) throw new TypeError('album fragment must have a chat id')

      this.database.run(
        `INSERT INTO telegram_album_groups
          (bot_id, chat_id, media_group_id, leader_update_row_id, ready_at_ms,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, chat_id, media_group_id) DO NOTHING`,
        [
          update.botId,
          update.chatId,
          input.mediaGroupId,
          input.updateRowId,
          input.readyAtMs,
          input.nowMs,
          input.nowMs,
        ],
      )
      const group = this.database
        .query<AlbumGroupRow, [string, string, string]>(
          `SELECT id, leader_update_row_id, state
           FROM telegram_album_groups
           WHERE bot_id = ? AND chat_id = ? AND media_group_id = ?`,
        )
        .get(update.botId, update.chatId, input.mediaGroupId)
      if (group === null) throw new Error('album group insert did not produce a row')
      if (group.state !== 'COLLECTING') {
        return { grouped: false, leaderUpdateRowId: group.leader_update_row_id }
      }

      const fragment = this.database.run(
        `INSERT INTO telegram_album_fragments (group_id, update_row_id, created_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (update_row_id) DO NOTHING`,
        [group.id, input.updateRowId, input.nowMs],
      )
      if (fragment.changes === 1) {
        this.database.run(
          `UPDATE telegram_album_groups
           SET leader_update_row_id = CASE
                 WHEN ? < leader_update_row_id THEN ? ELSE leader_update_row_id END,
               ready_at_ms = CASE WHEN ? > ready_at_ms THEN ? ELSE ready_at_ms END,
               updated_at_ms = ?
           WHERE id = ? AND state = 'COLLECTING'`,
          [
            input.updateRowId,
            input.updateRowId,
            input.readyAtMs,
            input.readyAtMs,
            input.nowMs,
            group.id,
          ],
        )
      }
      const current = this.database
        .query<{ leader_update_row_id: number }, [number]>(
          'SELECT leader_update_row_id FROM telegram_album_groups WHERE id = ?',
        )
        .get(group.id)
      return { grouped: true, leaderUpdateRowId: current?.leader_update_row_id ?? input.updateRowId }
    }).immediate()
  }

  albumFragmentsFor(updateRowId: number): readonly InboxUpdate[] {
    const rows = this.database
      .query<InboxRow, [number]>(
        `SELECT updates.*
         FROM telegram_album_fragments AS requested
         JOIN telegram_album_groups AS album ON album.id = requested.group_id
         JOIN telegram_album_fragments AS fragment ON fragment.group_id = album.id
         JOIN telegram_updates AS updates ON updates.id = fragment.update_row_id
         WHERE requested.update_row_id = ?
           AND album.leader_update_row_id = requested.update_row_id
         ORDER BY updates.update_id, updates.id`,
      )
      .all(updateRowId)
    return rows.map(inboxFromRow)
  }

  claimNext(options: LeaseOptions): InboxUpdate | null {
    validateLease(options)
    return this.database.transaction(() => {
      const candidate = this.database
        .query<{ id: number }, [number, number]>(
          `SELECT current.id FROM telegram_updates AS current
           WHERE current.state IN ('RECEIVED', 'RETRY_WAIT')
             AND current.available_at_ms <= ?
             AND (
               NOT EXISTS (
                 SELECT 1 FROM telegram_album_fragments AS own_fragment
                 WHERE own_fragment.update_row_id = current.id
               )
               OR EXISTS (
                 SELECT 1
                 FROM telegram_album_fragments AS own_fragment
                 JOIN telegram_album_groups AS own_album ON own_album.id = own_fragment.group_id
                 WHERE own_fragment.update_row_id = current.id
                   AND own_album.leader_update_row_id = current.id
                   AND own_album.state = 'COLLECTING'
                   AND own_album.ready_at_ms <= ?
               )
             )
             AND (
               current.routing_class NOT IN ('MESSAGE', 'QUEUED_MESSAGE')
               OR NOT EXISTS (
                 SELECT 1 FROM telegram_updates AS earlier
                 WHERE earlier.bot_id = current.bot_id
                   AND earlier.chat_id IS current.chat_id
                   AND earlier.routing_class = 'QUEUED_MESSAGE'
                   AND earlier.state IN ('RECEIVED', 'RETRY_WAIT', 'LEASED')
                   AND earlier.update_id < current.update_id
               )
             )
           ORDER BY
             CASE current.routing_class
               WHEN 'CONTROL' THEN 0
               WHEN 'QUEUED_MESSAGE' THEN 1
               WHEN 'MESSAGE' THEN 2
               ELSE 3
             END,
             current.update_id,
             current.id
           LIMIT 1`,
        )
        .get(options.nowMs, options.nowMs)
      if (candidate === null) return null

      this.database.run(
        `UPDATE telegram_updates
         SET state = 'LEASED', attempt_count = attempt_count + 1,
             lease_owner = ?, lease_expires_at_ms = ?, last_error = NULL
         WHERE id = ? AND state IN ('RECEIVED', 'RETRY_WAIT')`,
        [options.workerId, options.nowMs + options.leaseDurationMs, candidate.id],
      )
      this.database.run(
        `UPDATE telegram_album_groups
         SET state = 'PROCESSING', updated_at_ms = ?, last_error = NULL
         WHERE leader_update_row_id = ? AND state = 'COLLECTING'`,
        [options.nowMs, candidate.id],
      )
      return this.get(candidate.id)
    }).immediate()
  }

  renewLease(id: number, options: LeaseOptions): InboxUpdate {
    validateLease(options)
    const result = this.database.run(
      `UPDATE telegram_updates
       SET lease_expires_at_ms = ?
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?
         AND lease_expires_at_ms > ?`,
      [options.nowMs + options.leaseDurationMs, id, options.workerId, options.nowMs],
    )
    if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
    return this.require(id)
  }

  markProcessed(id: number, workerId: string, nowMs: number): InboxUpdate {
    return this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE telegram_updates
         SET state = 'PROCESSED', lease_owner = NULL, lease_expires_at_ms = NULL,
             processed_at_ms = ?, last_error = NULL
         WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
        [nowMs, id, workerId],
      )
      if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
      const album = this.albumForLeader(id)
      if (album !== null) {
        this.database.run(
          `UPDATE telegram_updates
           SET state = 'PROCESSED', lease_owner = NULL, lease_expires_at_ms = NULL,
               processed_at_ms = ?, last_error = NULL
           WHERE id IN (
             SELECT update_row_id FROM telegram_album_fragments WHERE group_id = ?
           )`,
          [nowMs, album.id],
        )
        this.database.run(
          `UPDATE telegram_album_groups
           SET state = 'PROCESSED', processed_at_ms = ?, updated_at_ms = ?, last_error = NULL
           WHERE id = ?`,
          [nowMs, nowMs, album.id],
        )
      }
      return this.require(id)
    }).immediate()
  }

  scrubPayload(id: number, workerId: string): InboxUpdate {
    const result = this.database.run(
      `UPDATE telegram_updates
       SET payload_json = '{"redacted":"sensitive-command"}'
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
      [id, workerId],
    )
    if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
    return this.require(id)
  }

  retry(id: number, workerId: string, error: string, availableAtMs: number): InboxUpdate {
    return this.releaseLease(id, workerId, error, availableAtMs, 'RETRY_WAIT')
  }

  deferQueued(id: number, workerId: string, availableAtMs: number): InboxUpdate {
    return this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE telegram_updates
         SET state = 'RETRY_WAIT', routing_class = 'QUEUED_MESSAGE',
             attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
             available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = 'queued behind active turn'
         WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
        [availableAtMs, id, workerId],
      )
      if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
      this.releaseAlbum(id, availableAtMs, 'queued behind active turn')
      return this.require(id)
    }).immediate()
  }

  fail(id: number, workerId: string, error: string, nowMs: number): InboxUpdate {
    return this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE telegram_updates
         SET state = 'FAILED', lease_owner = NULL, lease_expires_at_ms = NULL,
             processed_at_ms = ?, last_error = ?
         WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
        [nowMs, error, id, workerId],
      )
      if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
      const album = this.albumForLeader(id)
      if (album !== null) {
        this.database.run(
          `UPDATE telegram_updates
           SET state = 'FAILED', lease_owner = NULL, lease_expires_at_ms = NULL,
               processed_at_ms = ?, last_error = ?
           WHERE id IN (
             SELECT update_row_id FROM telegram_album_fragments WHERE group_id = ?
           )`,
          [nowMs, error, album.id],
        )
        this.database.run(
          `UPDATE telegram_album_groups
           SET state = 'FAILED', processed_at_ms = ?, updated_at_ms = ?, last_error = ?
           WHERE id = ?`,
          [nowMs, nowMs, error, album.id],
        )
      }
      return this.require(id)
    }).immediate()
  }

  recoverExpiredLeases(nowMs: number): number {
    return this.database.transaction(() => {
      this.database.run(
        `UPDATE telegram_album_groups
         SET state = 'COLLECTING', ready_at_ms = ?, updated_at_ms = ?,
             last_error = 'worker lease expired'
         WHERE state = 'PROCESSING'
           AND leader_update_row_id IN (
             SELECT id FROM telegram_updates
             WHERE state = 'LEASED' AND lease_expires_at_ms <= ?
           )`,
        [nowMs, nowMs, nowMs],
      )
      return this.database.run(
        `UPDATE telegram_updates
         SET state = 'RECEIVED', available_at_ms = ?, lease_owner = NULL,
             lease_expires_at_ms = NULL, last_error = 'worker lease expired'
         WHERE state = 'LEASED' AND lease_expires_at_ms <= ?`,
        [nowMs, nowMs],
      ).changes
    }).immediate()
  }

  releaseForTurnRecovery(id: number, nowMs: number): InboxUpdate | null {
    return this.database.transaction(() => {
      this.database.run(
        `UPDATE telegram_updates
         SET state = 'RETRY_WAIT', routing_class = 'QUEUED_MESSAGE', attempt_count = 0,
             available_at_ms = ?,
             lease_owner = NULL, lease_expires_at_ms = NULL,
             processed_at_ms = NULL,
             last_error = 'completed Codex turn recovered after restart'
         WHERE id = ? AND state IN ('RECEIVED', 'LEASED', 'RETRY_WAIT', 'FAILED')`,
        [nowMs, id],
      )
      this.releaseAlbum(id, nowMs, 'completed Codex turn recovered after restart')
      return this.get(id)
    }).immediate()
  }

  releaseTurnRecoveryBlocked(nowMs: number): number {
    return this.database.transaction(() => this.database.run(
      `UPDATE telegram_updates
       SET state = 'RETRY_WAIT', routing_class = 'QUEUED_MESSAGE', attempt_count = 0,
           available_at_ms = ?, lease_owner = NULL, lease_expires_at_ms = NULL,
           processed_at_ms = NULL, last_error = 'turn recovery blocker resolved'
       WHERE state = 'FAILED'
         AND last_error = 'TurnRecoveryRequiredError'
         AND EXISTS (
           SELECT 1
           FROM turns queued
           WHERE queued.source_update_id = telegram_updates.id
             AND queued.state = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM turns blocker
               WHERE blocker.session_id = queued.session_id
                 AND blocker.id != queued.id
                 AND blocker.state IN ('ACTIVE', 'UNKNOWN')
             )
         )`,
      [nowMs],
    ).changes).immediate()
  }

  quarantineForTurnRecovery(id: number, reason: string, nowMs: number): InboxUpdate | null {
    return this.database.transaction(() => {
      const album = this.albumForLeader(id)
      if (album === null) {
        this.database.run(
          `UPDATE telegram_updates
           SET state = 'FAILED', lease_owner = NULL, lease_expires_at_ms = NULL,
               processed_at_ms = ?, last_error = ?
           WHERE id = ? AND state IN ('RECEIVED', 'LEASED', 'RETRY_WAIT')`,
          [nowMs, reason, id],
        )
      } else {
        this.database.run(
          `UPDATE telegram_updates
           SET state = 'FAILED', lease_owner = NULL, lease_expires_at_ms = NULL,
               processed_at_ms = ?, last_error = ?
           WHERE id IN (
             SELECT update_row_id FROM telegram_album_fragments WHERE group_id = ?
           ) AND state IN ('RECEIVED', 'LEASED', 'RETRY_WAIT')`,
          [nowMs, reason, album.id],
        )
        this.database.run(
          `UPDATE telegram_album_groups
           SET state = 'FAILED', processed_at_ms = ?, updated_at_ms = ?, last_error = ?
           WHERE id = ?`,
          [nowMs, nowMs, reason, album.id],
        )
      }
      return this.get(id)
    }).immediate()
  }

  private albumForLeader(id: number): AlbumGroupRow | null {
    return this.database
      .query<AlbumGroupRow, [number]>(
        `SELECT id, leader_update_row_id, state
         FROM telegram_album_groups WHERE leader_update_row_id = ?`,
      )
      .get(id)
  }

  private releaseAlbum(id: number, availableAtMs: number, error: string): void {
    this.database.run(
      `UPDATE telegram_album_groups
       SET state = 'COLLECTING', ready_at_ms = ?, updated_at_ms = ?, last_error = ?
       WHERE leader_update_row_id = ? AND state = 'PROCESSING'`,
      [availableAtMs, availableAtMs, error, id],
    )
  }

  private releaseLease(
    id: number,
    workerId: string,
    error: string,
    availableAtMs: number,
    state: 'RETRY_WAIT',
  ): InboxUpdate {
    return this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE telegram_updates
         SET state = ?, available_at_ms = ?, lease_owner = NULL,
             lease_expires_at_ms = NULL, last_error = ?
         WHERE id = ? AND state = 'LEASED' AND lease_owner = ?`,
        [state, availableAtMs, error, id, workerId],
      )
      if (result.changes !== 1) throw new LeaseConflictError('inbox update', id)
      this.releaseAlbum(id, availableAtMs, error)
      return this.require(id)
    }).immediate()
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
    const dependsOnSourceKey = input.dependsOnSourceKey ?? null
    if (dependsOnSourceKey !== null && dependsOnSourceKey === input.sourceKey) {
      throw new TypeError('delivery job cannot depend on itself')
    }
    const result = this.database.run(
      `INSERT INTO delivery_jobs
        (id, source_key, depends_on_source_key, session_id, kind, payload_json, state, available_at_ms,
         expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
       ON CONFLICT (source_key) DO NOTHING`,
      [
        id,
        input.sourceKey,
        dependsOnSourceKey,
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
          `SELECT job.id FROM delivery_jobs AS job
           WHERE job.state IN ('PENDING', 'RETRY_WAIT') AND job.available_at_ms <= ?
             AND (job.depends_on_source_key IS NULL OR EXISTS (
               SELECT 1 FROM delivery_jobs AS predecessor
               WHERE predecessor.source_key = job.depends_on_source_key
                 AND predecessor.state = 'DELIVERED'
             ))
           ORDER BY job.created_at_ms, job.id
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

  renewLease(id: string, options: LeaseOptions): DeliveryJob {
    validateLease(options)
    const result = this.database.run(
      `UPDATE delivery_jobs
       SET lease_expires_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND state = 'LEASED' AND lease_owner = ?
         AND lease_expires_at_ms > ?`,
      [
        options.nowMs + options.leaseDurationMs,
        options.nowMs,
        id,
        options.workerId,
        options.nowMs,
      ],
    )
    if (result.changes !== 1) throw new LeaseConflictError('delivery job', id)
    return this.require(id)
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

  retireBySourcePrefix(sourcePrefix: string, reason: string, nowMs: number): DeliveryJob[] {
    if (sourcePrefix.length === 0) throw new TypeError('sourcePrefix must not be empty')
    if (reason.length === 0) throw new TypeError('reason must not be empty')
    return this.database.transaction(() => {
      const rows = this.database
        .query<DeliveryRow, [number, string]>(
          `SELECT * FROM delivery_jobs
           WHERE substr(source_key, 1, ?) = ?
           ORDER BY created_at_ms, id`,
        )
        .all(sourcePrefix.length, sourcePrefix)
      this.database.run(
        `UPDATE delivery_jobs
         SET state = 'ARCHIVED', lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = ?, updated_at_ms = ?
         WHERE substr(source_key, 1, ?) = ?
           AND (state IN ('PENDING', 'RETRY_WAIT')
             OR (state = 'LEASED' AND send_started_at_ms IS NULL))`,
        [reason, nowMs, sourcePrefix.length, sourcePrefix],
      )
      this.database.run(
        `UPDATE delivery_jobs
         SET state = 'AMBIGUOUS', lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = 'interaction prompt send was in flight during restart', updated_at_ms = ?
         WHERE substr(source_key, 1, ?) = ?
           AND state = 'LEASED' AND send_started_at_ms IS NOT NULL`,
        [nowMs, sourcePrefix.length, sourcePrefix],
      )
      return rows.map((row) => this.require(row.id))
    }).immediate()
  }

  listProblems(state: DeliveryProblemState, limit = 10): DeliveryJob[] {
    if (state !== 'FAILED' && state !== 'AMBIGUOUS' && state !== 'EXPIRED') {
      throw new TypeError('invalid delivery problem state')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('problem list limit must be between 1 and 100')
    }
    return this.database
      .query<DeliveryRow, [DeliveryProblemState, number]>(
        `SELECT * FROM delivery_jobs
         WHERE state = ?
         ORDER BY updated_at_ms DESC, id DESC
         LIMIT ?`,
      )
      .all(state, limit)
      .map(deliveryFromRow)
  }

  actOnProblem(input: DeliveryProblemActionInput): DeliveryProblemActionResult {
    if (input.action !== 'RETRY' && input.action !== 'RESOLVE' && input.action !== 'ARCHIVE') {
      throw new TypeError('invalid delivery problem action')
    }
    if (input.operationKey.trim().length === 0) throw new TypeError('operationKey must not be empty')
    if (input.jobId.trim().length === 0) throw new TypeError('jobId must not be empty')
    if (input.actorBotId.trim().length === 0 || input.actorChatId.trim().length === 0) {
      throw new TypeError('problem action actor must not be empty')
    }
    if (!Number.isSafeInteger(input.nowMs)) throw new TypeError('nowMs must be a safe integer')
    const remoteId = input.remoteId?.trim()
    if (input.action === 'RESOLVE' && (remoteId === undefined || remoteId.length === 0)) {
      throw new TypeError('RESOLVE requires a remoteId')
    }

    return this.database.transaction((): DeliveryProblemActionResult => {
      const replay = this.database
        .query<DeliveryProblemActionRow, [string]>(
          `SELECT operation_key, job_id, action, actor_bot_id, actor_chat_id, remote_id
           FROM delivery_problem_actions WHERE operation_key = ?`,
        )
        .get(input.operationKey)
      if (replay !== null) {
        if (
          replay.job_id !== input.jobId ||
          replay.action !== input.action ||
          replay.actor_bot_id !== input.actorBotId ||
          replay.actor_chat_id !== input.actorChatId ||
          replay.remote_id !== (remoteId ?? null)
        ) {
          throw new Error(`problem operation ${input.operationKey} was replayed with different input`)
        }
        return { outcome: 'replayed', job: this.require(replay.job_id) }
      }

      const job = this.get(input.jobId)
      if (job === null) return { outcome: 'not_found', job: null }

      let targetState: 'PENDING' | 'DELIVERED' | 'ARCHIVED'
      let changes: number
      if (input.action === 'RETRY') {
        if (job.state !== 'FAILED' && job.state !== 'EXPIRED') {
          return { outcome: 'invalid_state', job }
        }
        targetState = 'PENDING'
        changes = this.database.run(
          `UPDATE delivery_jobs
           SET state = 'PENDING', attempt_count = 0, available_at_ms = ?, expires_at_ms = NULL,
               lease_owner = NULL, lease_expires_at_ms = NULL, send_started_at_ms = NULL,
               remote_id = NULL, delivered_at_ms = NULL,
               last_error = 'manual retry requested', updated_at_ms = ?
           WHERE id = ? AND state = ?`,
          [input.nowMs, input.nowMs, job.id, job.state],
        ).changes
      } else if (input.action === 'RESOLVE') {
        if (job.state !== 'AMBIGUOUS') return { outcome: 'invalid_state', job }
        targetState = 'DELIVERED'
        changes = this.database.run(
          `UPDATE delivery_jobs
           SET state = 'DELIVERED', remote_id = ?, delivered_at_ms = ?, updated_at_ms = ?,
               lease_owner = NULL, lease_expires_at_ms = NULL, last_error = NULL
           WHERE id = ? AND state = 'AMBIGUOUS'`,
          [remoteId as string, input.nowMs, input.nowMs, job.id],
        ).changes
      } else {
        if (job.state !== 'FAILED' && job.state !== 'AMBIGUOUS' && job.state !== 'EXPIRED') {
          return { outcome: 'invalid_state', job }
        }
        targetState = 'ARCHIVED'
        changes = this.database.run(
          `UPDATE delivery_jobs
           SET state = 'ARCHIVED', lease_owner = NULL, lease_expires_at_ms = NULL,
               updated_at_ms = ?
           WHERE id = ? AND state = ?`,
          [input.nowMs, job.id, job.state],
        ).changes
        this.archiveDependents(job.sourceKey, input.nowMs)
      }
      if (changes !== 1) throw new Error(`delivery job ${job.id} did not transition to ${targetState}`)

      this.database.run(
        `INSERT INTO delivery_problem_actions
          (id, operation_key, job_id, action, from_state, to_state,
           actor_bot_id, actor_chat_id, remote_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          input.operationKey,
          job.id,
          input.action,
          job.state,
          targetState,
          input.actorBotId,
          input.actorChatId,
          remoteId ?? null,
          input.nowMs,
        ],
      )
      return { outcome: 'applied', job: this.require(job.id) }
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

  private archiveDependents(sourceKey: string, nowMs: number): void {
    this.database.run(
      `WITH RECURSIVE dependents(source_key) AS (
         SELECT source_key FROM delivery_jobs WHERE depends_on_source_key = ?
         UNION ALL
         SELECT child.source_key
         FROM delivery_jobs AS child
         JOIN dependents AS parent ON child.depends_on_source_key = parent.source_key
       )
       UPDATE delivery_jobs
       SET state = 'ARCHIVED', lease_owner = NULL, lease_expires_at_ms = NULL,
           last_error = 'delivery predecessor was archived', updated_at_ms = ?
       WHERE source_key IN (SELECT source_key FROM dependents)
         AND state IN ('PENDING', 'RETRY_WAIT', 'FAILED', 'EXPIRED')`,
      [sourceKey, nowMs],
    )
  }

  private require(id: string): DeliveryJob {
    const job = this.get(id)
    if (job === null) throw new Error(`delivery job ${id} not found`)
    return job
  }
}
