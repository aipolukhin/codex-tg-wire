import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AgentLocalAttachment,
  IncomingTelegramAttachment,
} from '../bridge/contracts.js'
import {
  SqliteAttachmentRepository,
  type AttachmentRecord,
} from '../durable/attachment-repository.js'

export interface TelegramAttachmentDownload {
  bytes: Uint8Array
  fileSize: number
  uniqueId: string | null
}

export interface TelegramAttachmentApi {
  downloadAttachment(fileId: string, maxBytes: number): Promise<TelegramAttachmentDownload>
}

export interface DurableAttachmentStoreOptions {
  directory: string
  maxBytes?: number
  allowedMimeTypes?: readonly string[]
  now?: () => number
}

export interface InboundAttachmentStore {
  materialize(
    sourceUpdateId: number,
    ordinal: number,
    candidate: IncomingTelegramAttachment,
  ): Promise<AttachmentMaterialization>
}

export type AttachmentMaterialization =
  | { outcome: 'accepted'; attachment: AgentLocalAttachment }
  | { outcome: 'rejected'; reason: AttachmentRejectionReason }

export type AttachmentRejectionReason =
  | 'size_limit'
  | 'mime_not_allowed'
  | 'content_mismatch'

export class AttachmentDownloadLimitError extends Error {
  constructor() {
    super('Telegram attachment exceeds the configured byte limit')
    this.name = 'AttachmentDownloadLimitError'
  }
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'application/xml',
  'text/xml',
] as const

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/xml': '.xml',
  'text/xml': '.xml',
}
const NATIVE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function safeFileName(value: string | null, mimeType: string): string {
  const fallback = `attachment${MIME_EXTENSIONS[mimeType] ?? '.bin'}`
  if (value === null) return fallback
  const leaf = value.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 120)
  return safe.length === 0 || safe === '.' || safe === '..' ? fallback : safe
}

function matchesMagic(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
        .every((value, index) => bytes[index] === value)
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (mimeType === 'image/gif') {
    const prefix = String.fromCharCode(...bytes.slice(0, 6))
    return prefix === 'GIF87a' || prefix === 'GIF89a'
  }
  if (mimeType === 'application/pdf') {
    return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-'
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('/xml')) {
    return !bytes.includes(0)
  }
  return true
}

async function existingRegularFile(path: string, expectedSize: number): Promise<boolean> {
  try {
    const stat = await lstat(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedSize
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, resolve(path))
  return child.length > 0 && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

export class DurableAttachmentStore implements InboundAttachmentStore {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly allowedMimeTypes: Set<string>
  private readonly now: () => number

  constructor(
    private readonly api: TelegramAttachmentApi,
    private readonly repository: SqliteAttachmentRepository,
    options: DurableAttachmentStoreOptions,
  ) {
    this.directory = resolve(options.directory)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.allowedMimeTypes = new Set(options.allowedMimeTypes ?? DEFAULT_ATTACHMENT_MIME_TYPES)
    this.now = options.now ?? Date.now
    if (options.directory.trim().length === 0) throw new TypeError('attachment directory is required')
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new TypeError('attachment maxBytes must be a positive safe integer')
    }
  }

  async materialize(
    sourceUpdateId: number,
    ordinal: number,
    candidate: IncomingTelegramAttachment,
  ): Promise<AttachmentMaterialization> {
    const mimeType = candidate.mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
    const normalized = { ...candidate, mimeType }
    const fileName = safeFileName(candidate.fileName, mimeType)
    const record = this.repository.register(
      sourceUpdateId,
      ordinal,
      normalized,
      fileName,
      this.now(),
    )
    if (record.state === 'REJECTED') {
      const reason = record.rejectionReason
      if (reason === 'size_limit' || reason === 'mime_not_allowed' || reason === 'content_mismatch') {
        return { outcome: 'rejected', reason }
      }
      throw new Error(`attachment ${record.id} has an invalid rejection reason`)
    }
    if (!this.allowedMimeTypes.has(mimeType)) return this.reject(record, 'mime_not_allowed')
    if (candidate.kind === 'image' && !NATIVE_IMAGE_MIME_TYPES.has(mimeType)) {
      return this.reject(record, 'mime_not_allowed')
    }
    if (candidate.declaredSize !== null && candidate.declaredSize > this.maxBytes) {
      return this.reject(record, 'size_limit')
    }
    if (record.state === 'READY' && record.localPath !== null && record.actualSize !== null) {
      if (record.actualSize > this.maxBytes) return this.reject(record, 'size_limit')
      if (
        isInside(this.directory, record.localPath) &&
        await existingRegularFile(record.localPath, record.actualSize)
      ) {
        const bytes = new Uint8Array(await readFile(record.localPath))
        if (bytes.length === record.actualSize && matchesMagic(mimeType, bytes)) {
          return { outcome: 'accepted', attachment: this.local(record) }
        }
      }
    }

    let downloaded: TelegramAttachmentDownload
    try {
      downloaded = await this.api.downloadAttachment(candidate.fileId, this.maxBytes)
    } catch (error) {
      if (error instanceof AttachmentDownloadLimitError) return this.reject(record, 'size_limit')
      throw error
    }
    if (downloaded.fileSize > this.maxBytes || downloaded.bytes.length > this.maxBytes) {
      return this.reject(record, 'size_limit')
    }
    if (downloaded.fileSize !== downloaded.bytes.length || !matchesMagic(mimeType, downloaded.bytes)) {
      return this.reject(record, 'content_mismatch')
    }
    if (
      candidate.uniqueId !== null &&
      downloaded.uniqueId !== null &&
      candidate.uniqueId !== downloaded.uniqueId
    ) {
      return this.reject(record, 'content_mismatch')
    }
    const extension = MIME_EXTENSIONS[mimeType] ?? '.bin'
    const digest = createHash('sha256')
      .update(`${sourceUpdateId}:${ordinal}:${candidate.uniqueId ?? candidate.fileId}`)
      .digest('hex')
    const destination = join(this.directory, `${digest}${extension}`)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `.${digest}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(downloaded.bytes)
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    const local: AgentLocalAttachment = {
      kind: candidate.kind,
      path: destination,
      fileName,
      mimeType,
      size: downloaded.fileSize,
    }
    this.repository.markReady(record.id, local, this.now())
    return { outcome: 'accepted', attachment: local }
  }

  private reject(
    record: AttachmentRecord,
    reason: AttachmentRejectionReason,
  ): AttachmentMaterialization {
    this.repository.markRejected(record.id, reason, this.now())
    return { outcome: 'rejected', reason }
  }

  private local(record: AttachmentRecord): AgentLocalAttachment {
    if (record.localPath === null || record.actualSize === null) {
      throw new Error(`ready attachment ${record.id} has no local proof`)
    }
    return {
      kind: record.kind,
      path: record.localPath,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.actualSize,
    }
  }
}
