import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type TelegramMediaKind = 'photo' | 'document' | 'audio' | 'video' | 'voice'
export type TelegramAlbumMediaKind = Exclude<TelegramMediaKind, 'voice'>

export interface DurableMediaReference {
  path: string
  fileName: string
  mimeType: string
  size: number
  sha256: string
}

export interface PreparedLocalMedia extends DurableMediaReference {
  kind: TelegramMediaKind
}

export interface DurableOutboundMediaOptions {
  directory: string
  allowedRoots: readonly string[]
  maxBytes?: number
  allowedMimeTypes?: readonly string[]
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_OUTBOUND_MIME_TYPES = [
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
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'video/mp4',
] as const

const KIND_MIME: Readonly<Record<TelegramMediaKind, readonly RegExp[]>> = {
  photo: [/^image\/(jpeg|png|webp|gif)$/],
  document: [/^(application|text)\//, /^image\//, /^audio\//, /^video\//],
  audio: [/^audio\//],
  video: [/^video\//],
  voice: [/^audio\/(ogg|mpeg|mp4)$/],
}

function inside(root: string, child: string): boolean {
  const path = relative(root, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function normalizeMime(value: string): string {
  return value.toLowerCase().split(';', 1)[0]?.trim() ?? ''
}

function safeName(value: string): string {
  const leaf = basename(value.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim()
    .slice(0, 120)
  if (leaf.length === 0 || leaf === '.' || leaf === '..') return 'attachment.bin'
  return leaf
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  return hash.digest('hex')
}

/** Copies approved files into a private immutable-by-contract upload spool. */
export class DurableOutboundMediaStore {
  private readonly directory: string
  private readonly allowedRoots: string[]
  private readonly maxBytes: number
  private readonly allowedMimeTypes: Set<string>

  constructor(options: DurableOutboundMediaOptions) {
    this.directory = resolve(options.directory)
    this.allowedRoots = options.allowedRoots.map((root) => resolve(root))
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.allowedMimeTypes = new Set(options.allowedMimeTypes ?? DEFAULT_OUTBOUND_MIME_TYPES)
    if (options.directory.trim().length === 0) throw new TypeError('outbound media directory is required')
    if (this.allowedRoots.length === 0) throw new TypeError('at least one outbound media root is required')
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError('outbound media maxBytes must be positive')
    }
  }

  async register(input: {
    path: string
    fileName?: string
    mimeType: string
    kind: TelegramMediaKind
  }): Promise<DurableMediaReference> {
    const source = await this.approvedSource(input.path)
    const mimeType = this.approvedMime(input.mimeType, input.kind)
    const stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('outbound media source is not a regular file')
    if (stat.size <= 0 || stat.size > this.maxBytes) throw new Error('outbound media size is not allowed')
    const sha256 = await digestFile(source)
    const fileName = safeName(input.fileName ?? basename(source))
    const extension = extname(fileName).slice(0, 16)
    const destination = join(this.directory, `${sha256}${extension}`)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const existing = await lstat(destination)
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== stat.size) {
        throw new Error('outbound media spool collision')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(this.directory, `.${sha256}.${randomUUID()}.tmp`)
      try {
        await copyFile(source, temporary)
        await chmod(temporary, 0o600)
        await rename(temporary, destination)
      } catch (copyError) {
        await unlink(temporary).catch(() => undefined)
        throw copyError
      }
    }
    return { path: destination, fileName, mimeType, size: stat.size, sha256 }
  }

  async prepare(reference: DurableMediaReference, kind: TelegramMediaKind): Promise<PreparedLocalMedia> {
    this.validateReference(reference)
    const mimeType = this.approvedMime(reference.mimeType, kind)
    const resolvedPath = await realpath(reference.path)
    const spoolRoot = await realpath(this.directory)
    if (!inside(spoolRoot, resolvedPath)) throw new Error('outbound media reference escaped the spool')
    const stat = await lstat(resolvedPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('outbound media reference is not regular')
    if (stat.size !== reference.size || stat.size <= 0 || stat.size > this.maxBytes) {
      throw new Error('outbound media reference size changed')
    }
    const sha256 = await digestFile(resolvedPath)
    if (sha256 !== reference.sha256) throw new Error('outbound media reference digest changed')
    return { ...reference, path: resolvedPath, fileName: safeName(reference.fileName), mimeType, kind }
  }

  private async approvedSource(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('outbound media source path must be absolute')
    const source = await realpath(path)
    const roots = await Promise.all(this.allowedRoots.map((root) => realpath(root)))
    if (!roots.some((root) => inside(root, source))) {
      throw new Error('outbound media source is outside allowed roots')
    }
    return source
  }

  private approvedMime(value: string, kind: TelegramMediaKind): string {
    const mimeType = normalizeMime(value)
    if (!this.allowedMimeTypes.has(mimeType)) throw new Error('outbound media MIME is not allowed')
    if (!KIND_MIME[kind].some((pattern) => pattern.test(mimeType))) {
      throw new Error(`outbound media MIME is incompatible with ${kind}`)
    }
    return mimeType
  }

  private validateReference(reference: DurableMediaReference): void {
    if (!isAbsolute(reference.path)) throw new Error('outbound media reference path must be absolute')
    if (!Number.isSafeInteger(reference.size) || reference.size <= 0 || reference.size > this.maxBytes) {
      throw new Error('outbound media reference has an invalid size')
    }
    if (!/^[a-f0-9]{64}$/.test(reference.sha256)) {
      throw new Error('outbound media reference has an invalid digest')
    }
    if (safeName(reference.fileName) !== reference.fileName) {
      throw new Error('outbound media reference has an unsafe file name')
    }
  }
}
