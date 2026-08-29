import type { Database } from 'bun:sqlite'

import type { AgentLocalAttachment, IncomingTelegramAttachment } from '../bridge/contracts.js'

export type AttachmentState = 'PENDING' | 'READY' | 'REJECTED'

export interface AttachmentRecord {
  id: string
  sourceUpdateId: number
  ordinal: number
  kind: IncomingTelegramAttachment['kind']
  telegramFileId: string
  telegramUniqueId: string | null
  fileName: string
  mimeType: string
  declaredSize: number | null
  state: AttachmentState
  localPath: string | null
  actualSize: number | null
  contentSha256: string | null
  rejectionReason: string | null
  createdAtMs: number
  updatedAtMs: number
}

interface AttachmentRow {
  id: string
  source_update_id: number
  ordinal: number
  kind: IncomingTelegramAttachment['kind']
  telegram_file_id: string
  telegram_unique_id: string | null
  file_name: string
  mime_type: string
  declared_size: number | null
  state: AttachmentState
  local_path: string | null
  actual_size: number | null
  content_sha256: string | null
  rejection_reason: string | null
  created_at_ms: number
  updated_at_ms: number
}

function durableKind(kind: IncomingTelegramAttachment['kind']): 'image' | 'file' {
  return kind === 'audio' ? 'file' : kind
}

function fromRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    sourceUpdateId: row.source_update_id,
    ordinal: row.ordinal,
    kind: row.kind,
    telegramFileId: row.telegram_file_id,
    telegramUniqueId: row.telegram_unique_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    declaredSize: row.declared_size,
    state: row.state,
    localPath: row.local_path,
    actualSize: row.actual_size,
    contentSha256: row.content_sha256,
    rejectionReason: row.rejection_reason,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

export class SqliteAttachmentRepository {
  constructor(private readonly database: Database) {}

  getBySource(sourceUpdateId: number, ordinal: number): AttachmentRecord | null {
    const row = this.database
      .query<AttachmentRow, [number, number]>(
        `SELECT attachments.*, proofs.content_sha256
         FROM telegram_attachments AS attachments
         LEFT JOIN telegram_attachment_proofs AS proofs ON proofs.attachment_id = attachments.id
         WHERE attachments.source_update_id = ? AND attachments.ordinal = ?`,
      )
      .get(sourceUpdateId, ordinal)
    return row === null ? null : fromRow(row)
  }

  register(
    sourceUpdateId: number,
    ordinal: number,
    attachment: IncomingTelegramAttachment,
    fileName: string,
    nowMs: number,
  ): AttachmentRecord {
    const existing = this.getBySource(sourceUpdateId, ordinal)
    const storedKind = durableKind(attachment.kind)
    if (existing !== null) {
      if (
        existing.kind !== storedKind ||
        existing.telegramFileId !== attachment.fileId ||
        existing.telegramUniqueId !== attachment.uniqueId ||
        existing.fileName !== fileName ||
        existing.mimeType !== attachment.mimeType ||
        existing.declaredSize !== attachment.declaredSize
      ) {
        throw new Error(`attachment metadata conflict for update ${sourceUpdateId} ordinal ${ordinal}`)
      }
      return existing
    }
    const id = crypto.randomUUID()
    this.database.run(
      `INSERT INTO telegram_attachments
        (id, source_update_id, ordinal, kind, telegram_file_id, telegram_unique_id,
         file_name, mime_type, declared_size, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      [
        id,
        sourceUpdateId,
        ordinal,
        storedKind,
        attachment.fileId,
        attachment.uniqueId,
        fileName,
        attachment.mimeType,
        attachment.declaredSize,
        nowMs,
        nowMs,
      ],
    )
    const created = this.getBySource(sourceUpdateId, ordinal)
    if (created === null) throw new Error('attachment registration did not produce a row')
    return created
  }

  markReady(id: string, local: AgentLocalAttachment, nowMs: number): AttachmentRecord {
    this.database.transaction(() => {
      this.database.run(
        `UPDATE telegram_attachments SET
           state = 'READY', local_path = ?, actual_size = ?, rejection_reason = NULL,
           updated_at_ms = ?
         WHERE id = ?`,
        [local.path, local.size, nowMs, id],
      )
      this.database.run(
        `INSERT INTO telegram_attachment_proofs (attachment_id, content_sha256, verified_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (attachment_id) DO UPDATE SET
           content_sha256 = excluded.content_sha256,
           verified_at_ms = excluded.verified_at_ms`,
        [id, local.sha256, nowMs],
      )
    }).immediate()
    return this.require(id)
  }

  markRejected(id: string, reason: string, nowMs: number): AttachmentRecord {
    this.database.transaction(() => {
      this.database.run(
        `UPDATE telegram_attachments SET
           state = 'REJECTED', local_path = NULL, actual_size = NULL,
           rejection_reason = ?, updated_at_ms = ?
         WHERE id = ?`,
        [reason, nowMs, id],
      )
      this.database.run('DELETE FROM telegram_attachment_proofs WHERE attachment_id = ?', [id])
    }).immediate()
    return this.require(id)
  }

  private require(id: string): AttachmentRecord {
    const row = this.database
      .query<AttachmentRow, [string]>(
        `SELECT attachments.*, proofs.content_sha256
         FROM telegram_attachments AS attachments
         LEFT JOIN telegram_attachment_proofs AS proofs ON proofs.attachment_id = attachments.id
         WHERE attachments.id = ?`,
      )
      .get(id)
    if (row === null) throw new Error(`attachment ${id} not found`)
    return fromRow(row)
  }
}
