import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { AgentLocalAttachment } from './contracts.js'
import {
  GroqVoiceTranscriber,
  type GroqVoiceTranscriberOptions,
  type VoiceTranscriber,
  type VoiceTranscriptionResult,
} from '../telegram/durable-voice-transcriber.js'

const MAX_KEY_BYTES = 64 * 1024
const GROQ_KEYS_URL = 'https://console.groq.com/keys'

export interface VoiceCredentialControl {
  readonly setupUrl: string
  isConfigured(): boolean
  install(apiKey: string): Promise<void>
}

export interface GroqCredentialManagerOptions {
  apiRoot?: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

/** Owns the private Groq key file used by Telegram-first onboarding. */
export class GroqCredentialManager implements VoiceCredentialControl {
  readonly setupUrl = GROQ_KEYS_URL
  private readonly apiRoot: URL
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(
    readonly credentialPath: string,
    options: GroqCredentialManagerOptions = {},
  ) {
    if (!credentialPath.startsWith('/')) throw new TypeError('Groq credential path must be absolute')
    this.apiRoot = new URL(options.apiRoot?.trim() || 'https://api.groq.com/openai/v1')
    if (this.apiRoot.protocol !== 'https:') throw new TypeError('Groq API root must use HTTPS')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
      throw new TypeError('Groq credential timeout must be at least 1000ms')
    }
  }

  read(): string | null {
    if (!existsSync(this.credentialPath)) return null
    const stat = lstatSync(this.credentialPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Groq credential is not a regular file')
    if (stat.size === 0) return null
    if (stat.size > MAX_KEY_BYTES) throw new Error('Groq credential file is too large')
    const value = readFileSync(this.credentialPath, 'utf8').trim()
    if (!value || value.includes('\0')) throw new Error('Groq credential file is invalid')
    return value
  }

  isConfigured(): boolean {
    try {
      return this.read() !== null
    } catch {
      return false
    }
  }

  async install(apiKey: string): Promise<void> {
    const normalized = apiKey.trim()
    if (
      normalized.length < 20 ||
      normalized.length > 512 ||
      !normalized.startsWith('gsk_') ||
      /\s|\0/.test(normalized)
    ) {
      throw new Error('Groq API key has an invalid format')
    }
    const response = await this.fetchImpl(
      new URL('models', `${this.apiRoot.toString().replace(/\/$/, '')}/`),
      {
        headers: { Authorization: `Bearer ${normalized}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    )
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) throw new Error('Groq rejected the API key')
    this.writePrivate(normalized)
  }

  private writePrivate(value: string): void {
    const directory = dirname(this.credentialPath)
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Groq credential directory is unsafe')
    }
    if (existsSync(this.credentialPath)) {
      const target = lstatSync(this.credentialPath)
      if (!target.isFile() || target.isSymbolicLink()) {
        throw new Error('Groq credential target is unsafe')
      }
    }
    const temporaryPath = join(directory, `.groq-api-key.${randomUUID()}`)
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, `${value}\n`, { encoding: 'utf8' })
      closeSync(descriptor)
      descriptor = null
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, this.credentialPath)
      chmodSync(this.credentialPath, 0o600)
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      rmSync(temporaryPath, { force: true })
    }
  }
}

export class ManagedGroqVoiceTranscriber implements VoiceTranscriber {
  constructor(
    private readonly credentials: GroqCredentialManager,
    private readonly options: Omit<GroqVoiceTranscriberOptions, 'apiKey'>,
  ) {}

  async transcribe(attachment: AgentLocalAttachment): Promise<VoiceTranscriptionResult> {
    const apiKey = this.credentials.read()
    if (apiKey === null) return { status: 'skipped' }
    return new GroqVoiceTranscriber({ ...this.options, apiKey }).transcribe(attachment)
  }
}
