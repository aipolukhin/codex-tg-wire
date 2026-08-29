import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { AgentLocalAttachment } from '../bridge/contracts.js'
import { redactSecrets } from '../safety/redact.js'

export type VoiceTranscriptionResult =
  | { status: 'ok'; transcript: string }
  | { status: 'skipped' | 'failed' }

export interface VoiceTranscriber {
  transcribe(attachment: AgentLocalAttachment): Promise<VoiceTranscriptionResult>
}

export interface GroqVoiceTranscriberOptions {
  apiKey: string
  model?: string
  language?: string
  apiRoot?: string
  maxBytes?: number
  requestTimeoutMs?: number
  maxTranscriptCharacters?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_API_ROOT = 'https://api.groq.com/openai/v1'
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

function normalizeTranscript(value: string, maxCharacters: number): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxCharacters)
}

export class GroqVoiceTranscriber implements VoiceTranscriber {
  private readonly apiKey: string
  private readonly model: string
  private readonly language: string
  private readonly endpoint: string
  private readonly maxBytes: number
  private readonly requestTimeoutMs: number
  private readonly maxTranscriptCharacters: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GroqVoiceTranscriberOptions) {
    this.apiKey = options.apiKey.trim()
    this.model = options.model?.trim() || 'whisper-large-v3-turbo'
    this.language = options.language?.trim() || 'ru'
    const apiRoot = new URL(options.apiRoot?.trim() || DEFAULT_API_ROOT)
    if (apiRoot.protocol !== 'https:') throw new TypeError('voice apiRoot must use HTTPS')
    this.endpoint = new URL('audio/transcriptions', `${apiRoot.toString().replace(/\/$/, '')}/`).toString()
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.maxTranscriptCharacters = options.maxTranscriptCharacters ?? 32_000
    this.fetchImpl = options.fetchImpl ?? fetch
    if (this.apiKey.length === 0) throw new TypeError('voice API key must not be empty')
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new TypeError('voice maxBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
      throw new TypeError('voice requestTimeoutMs must be at least 1000')
    }
    if (!Number.isSafeInteger(this.maxTranscriptCharacters) || this.maxTranscriptCharacters < 1) {
      throw new TypeError('voice maxTranscriptCharacters must be a positive safe integer')
    }
  }

  async transcribe(attachment: AgentLocalAttachment): Promise<VoiceTranscriptionResult> {
    if (attachment.kind !== 'audio' || attachment.size > this.maxBytes) return { status: 'skipped' }
    try {
      const stat = await lstat(attachment.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== attachment.size) {
        return { status: 'failed' }
      }
      const bytes = new Uint8Array(await readFile(attachment.path))
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (bytes.length !== attachment.size || digest !== attachment.sha256) return { status: 'failed' }

      const rawName = basename(attachment.fileName) || 'voice.ogg'
      const fileName = rawName.replace(/\.oga$/i, '.ogg')
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: attachment.mimeType }), fileName)
      form.append('model', this.model)
      form.append('language', this.language)
      form.append('response_format', 'text')
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
      if (!response.ok) {
        await response.text().then((value) => redactSecrets(value, [this.apiKey])).catch(() => '')
        return { status: 'failed' }
      }
      const transcript = normalizeTranscript(await response.text(), this.maxTranscriptCharacters)
      return { status: 'ok', transcript }
    } catch (error) {
      redactSecrets(error instanceof Error ? error.message : String(error), [this.apiKey])
      return { status: 'failed' }
    }
  }
}
