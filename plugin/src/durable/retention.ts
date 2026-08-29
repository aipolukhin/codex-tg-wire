import { existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { Database } from 'bun:sqlite'

const SCRUBBED_PAYLOAD = JSON.stringify({ scrubbed: true })
const TERMINAL_DELIVERY_STATES = "'DELIVERED', 'EXPIRED', 'ARCHIVED'"

export interface DurableRetentionOptions {
  payloadMaxAgeMs: number
  intervalMs: number
  attachmentDirectory?: string
  outboundMediaDirectory?: string
  now?: () => number
}

export interface DurableRetentionResult {
  ran: boolean
  updatesScrubbed: number
  turnsScrubbed: number
  deliveriesScrubbed: number
  interactionsScrubbed: number
  albumsScrubbed: number
  attachmentsScrubbed: number
  attachmentFilesRemoved: number
  outboundFilesRemoved: number
}

interface AttachmentRow {
  id: string
  local_path: string
}

interface DeliveryPayloadRow {
  payload_json: string
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function emptyResult(): DurableRetentionResult {
  return {
    ran: false,
    updatesScrubbed: 0,
    turnsScrubbed: 0,
    deliveriesScrubbed: 0,
    interactionsScrubbed: 0,
    albumsScrubbed: 0,
    attachmentsScrubbed: 0,
    attachmentFilesRemoved: 0,
    outboundFilesRemoved: 0,
  }
}

function containedRegularFile(root: string | undefined, candidate: string): string | null {
  if (root === undefined || !existsSync(root) || !existsSync(candidate)) return null
  try {
    const canonicalRoot = realpathSync(root)
    const stats = lstatSync(candidate)
    if (!stats.isFile() || stats.isSymbolicLink()) return null
    const canonicalCandidate = realpathSync(candidate)
    const child = relative(canonicalRoot, canonicalCandidate)
    if (
      child.length === 0 ||
      isAbsolute(child) ||
      child === '..' ||
      child.startsWith(`..${sep}`)
    ) {
      return null
    }
    return canonicalCandidate
  } catch {
    return null
  }
}

function removeContainedFile(root: string | undefined, candidate: string): boolean {
  const path = containedRegularFile(root, candidate)
  if (path === null) return false
  unlinkSync(path)
  return true
}

function mediaPaths(payloadJson: string): string[] {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson) as unknown
  } catch {
    return []
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const record = payload as Record<string, unknown>
  const paths: string[] = []
  const addReference = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const path = (value as Record<string, unknown>).path
    if (typeof path === 'string' && isAbsolute(path)) paths.push(resolve(path))
  }
  addReference(record.reference)
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        addReference((item as Record<string, unknown>).reference)
      }
    }
  }
  return paths
}

/** Periodically removes aged payload content while preserving durable idempotency keys. */
export class DurableDataRetention {
  private readonly payloadMaxAgeMs: number
  private readonly intervalMs: number
  private readonly attachmentDirectory: string | undefined
  private readonly outboundMediaDirectory: string | undefined
  private readonly now: () => number
  private lastRunAtMs: number | null = null

  constructor(
    private readonly database: Database,
    options: DurableRetentionOptions,
  ) {
    this.payloadMaxAgeMs = positiveSafeInteger(options.payloadMaxAgeMs, 'payloadMaxAgeMs')
    this.intervalMs = positiveSafeInteger(options.intervalMs, 'intervalMs')
    this.attachmentDirectory = options.attachmentDirectory === undefined
      ? undefined
      : resolve(options.attachmentDirectory)
    this.outboundMediaDirectory = options.outboundMediaDirectory === undefined
      ? undefined
      : resolve(options.outboundMediaDirectory)
    this.now = options.now ?? Date.now
  }

  runIfDue(): DurableRetentionResult {
    const nowMs = this.now()
    if (this.lastRunAtMs !== null && nowMs - this.lastRunAtMs < this.intervalMs) {
      return emptyResult()
    }
    const result = this.run(nowMs)
    this.lastRunAtMs = nowMs
    return result
  }

  run(nowMs = this.now()): DurableRetentionResult {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('retention timestamp must be a safe integer')
    const cutoffMs = nowMs - this.payloadMaxAgeMs
    const attachmentRows = this.database
      .query<AttachmentRow, [number]>(
        `SELECT a.id, a.local_path
         FROM telegram_attachments a
         JOIN telegram_updates u ON u.id = a.source_update_id
         WHERE a.state = 'READY'
           AND a.local_path IS NOT NULL
           AND u.state IN ('PROCESSED', 'FAILED')
           AND coalesce(u.processed_at_ms, u.received_at_ms) < ?`,
      )
      .all(cutoffMs)
    let attachmentFilesRemoved = 0
    for (const row of attachmentRows) {
      if (removeContainedFile(this.attachmentDirectory, row.local_path)) attachmentFilesRemoved += 1
    }

    const protectedOutboundPaths = new Set(
      this.database
        .query<DeliveryPayloadRow, [number]>(
          `SELECT payload_json FROM delivery_jobs
           WHERE NOT (state IN (${TERMINAL_DELIVERY_STATES}) AND updated_at_ms < ?)`,
        )
        .all(cutoffMs)
        .flatMap((row) => mediaPaths(row.payload_json)),
    )
    const expiredOutboundPaths = new Set(
      this.database
        .query<DeliveryPayloadRow, [number]>(
          `SELECT payload_json FROM delivery_jobs
           WHERE state IN (${TERMINAL_DELIVERY_STATES}) AND updated_at_ms < ?`,
        )
        .all(cutoffMs)
        .flatMap((row) => mediaPaths(row.payload_json)),
    )
    let outboundFilesRemoved = 0
    for (const path of expiredOutboundPaths) {
      if (!protectedOutboundPaths.has(path) && removeContainedFile(this.outboundMediaDirectory, path)) {
        outboundFilesRemoved += 1
      }
    }

    const counts = this.database.transaction(() => {
      for (const row of attachmentRows) {
        this.database.run('DELETE FROM telegram_attachment_proofs WHERE attachment_id = ?', [row.id])
      }
      const attachmentsScrubbed = this.database.run(
        `UPDATE telegram_attachments
         SET state = 'REJECTED', local_path = NULL, actual_size = NULL,
             telegram_file_id = '[scrubbed]', telegram_unique_id = NULL,
             file_name = '[scrubbed]', declared_size = NULL,
             rejection_reason = 'retention_expired', updated_at_ms = ?
         WHERE id IN (
           SELECT a.id FROM telegram_attachments a
           JOIN telegram_updates u ON u.id = a.source_update_id
           WHERE a.state = 'READY'
             AND u.state IN ('PROCESSED', 'FAILED')
             AND coalesce(u.processed_at_ms, u.received_at_ms) < ?
         )`,
        [nowMs, cutoffMs],
      ).changes
      const updatesScrubbed = this.database.run(
        `UPDATE telegram_updates
         SET payload_json = ?, last_error = NULL
         WHERE state IN ('PROCESSED', 'FAILED')
           AND coalesce(processed_at_ms, received_at_ms) < ?
           AND payload_json != ?`,
        [SCRUBBED_PAYLOAD, cutoffMs, SCRUBBED_PAYLOAD],
      ).changes
      const turnsScrubbed = this.database.run(
        `UPDATE turns
         SET request_json = ?, final_response_json = NULL
         WHERE state IN ('COMPLETED', 'INTERRUPTED', 'FAILED', 'UNKNOWN')
           AND coalesce(finished_at_ms, created_at_ms) < ?
           AND (request_json != ? OR final_response_json IS NOT NULL)`,
        [SCRUBBED_PAYLOAD, cutoffMs, SCRUBBED_PAYLOAD],
      ).changes
      const deliveriesScrubbed = this.database.run(
        `UPDATE delivery_jobs
         SET payload_json = ?, last_error = NULL
         WHERE state IN (${TERMINAL_DELIVERY_STATES})
           AND updated_at_ms < ?
           AND (payload_json != ? OR last_error IS NOT NULL)`,
        [SCRUBBED_PAYLOAD, cutoffMs, SCRUBBED_PAYLOAD],
      ).changes
      const interactionsScrubbed = this.database.run(
        `UPDATE codex_interactions
         SET request_json = ?, answers_json = '{}', response_json = NULL, last_error = NULL
         WHERE state NOT IN ('PENDING', 'RESOLVING')
           AND updated_at_ms < ?
           AND (request_json != ? OR answers_json != '{}' OR response_json IS NOT NULL OR last_error IS NOT NULL)`,
        [SCRUBBED_PAYLOAD, cutoffMs, SCRUBBED_PAYLOAD],
      ).changes
      const albumsScrubbed = this.database.run(
        `UPDATE telegram_album_groups
         SET last_error = NULL
         WHERE state IN ('PROCESSED', 'FAILED') AND updated_at_ms < ? AND last_error IS NOT NULL`,
        [cutoffMs],
      ).changes
      return {
        updatesScrubbed,
        turnsScrubbed,
        deliveriesScrubbed,
        interactionsScrubbed,
        albumsScrubbed,
        attachmentsScrubbed,
      }
    }).immediate()

    return {
      ran: true,
      ...counts,
      attachmentFilesRemoved,
      outboundFilesRemoved,
    }
  }
}
