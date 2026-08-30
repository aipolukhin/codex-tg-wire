import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

import { z } from 'zod'

const PositiveId = z.string().regex(/^[1-9]\d*$/)
const AbsolutePath = z.string().min(1).refine(isAbsolute, 'must be absolute')

export const BridgeBootstrapStateSchema = z.object({
  version: z.literal(1),
  status: z.enum([
    'awaiting_owner',
    'choose_project',
    'awaiting_custom_project',
    'confirm_create',
    'choose_profile',
    'finalizing',
    'complete',
  ]),
  deployment: z.enum(['host', 'docker']),
  configDirectory: AbsolutePath,
  stateDirectory: AbsolutePath,
  defaultProjectPath: AbsolutePath,
  groqCredentialPath: AbsolutePath,
  allowCustomProject: z.boolean(),
  botId: PositiveId,
  botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  nextUpdateId: z.number().int().safe().nonnegative().nullable(),
  ownerUserId: PositiveId.nullable(),
  ownerChatId: PositiveId.nullable(),
  selectedProjectPath: AbsolutePath.nullable(),
  pendingProjectPath: AbsolutePath.nullable(),
  executionProfile: z.enum(['yolo', 'safe']).nullable(),
  createdAtMs: z.number().int().safe().positive(),
  updatedAtMs: z.number().int().safe().positive(),
}).strict()

export type BridgeBootstrapState = z.infer<typeof BridgeBootstrapStateSchema>

export interface InitializeBridgeBootstrapInput {
  bootstrapPath: string
  configDirectory: string
  stateDirectory: string
  defaultProjectPath: string
  deployment: 'host' | 'docker'
  botId: string
  botUsername: string
  nonce: string
  telegramToken: string
  groqCredentialPath?: string
  presetProfile?: 'yolo' | 'safe'
  nowMs?: number
}

export interface InitializedBridgeBootstrap {
  state: BridgeBootstrapState
  configPath: string
  environmentPath: string
  telegramCredentialPath: string
  groqCredentialPath: string
  onboardingUrl: string
}

const TOKEN_PATTERN = /^[1-9]\d*:[A-Za-z0-9_-]+$/
const BOOTSTRAP_NONCE_BYTES = 12

/** A compact 96-bit owner-claim secret suitable for Telegram's start payload. */
export function createBridgeBootstrapNonce(): string {
  return randomBytes(BOOTSTRAP_NONCE_BYTES).toString('base64url')
}

function safeAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error(`${label} contains invalid characters`)
  }
  const normalized = resolve(value)
  if (normalized === parse(normalized).root) throw new Error(`${label} must not be a filesystem root`)
  return normalized
}

function writePrivate(path: string, contents: string): void {
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
  chmodSync(path, 0o600)
}

function writePrivateAtomic(path: string, contents: string): void {
  const temporary = join(dirname(path), `.bootstrap.${randomUUID()}.tmp`)
  try {
    writePrivate(temporary, contents)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function initializeBridgeBootstrap(
  input: InitializeBridgeBootstrapInput,
): InitializedBridgeBootstrap {
  const bootstrapPath = safeAbsolutePath(input.bootstrapPath, 'bootstrapPath')
  const configDirectory = safeAbsolutePath(input.configDirectory, 'configDirectory')
  const stateDirectory = safeAbsolutePath(input.stateDirectory, 'stateDirectory')
  const defaultProjectPath = safeAbsolutePath(input.defaultProjectPath, 'defaultProjectPath')
  const groqCredentialPath = safeAbsolutePath(
    input.groqCredentialPath ?? join(configDirectory, 'groq-api-key'),
    'groqCredentialPath',
  )
  if (dirname(bootstrapPath) !== configDirectory) {
    throw new Error('bootstrapPath must be inside configDirectory')
  }
  const telegramToken = input.telegramToken.trim()
  if (!TOKEN_PATTERN.test(telegramToken)) throw new Error('Telegram bot token has an invalid format')
  const nowMs = input.nowMs ?? Date.now()
  const state = BridgeBootstrapStateSchema.parse({
    version: 1,
    status: 'awaiting_owner',
    deployment: input.deployment,
    configDirectory,
    stateDirectory,
    defaultProjectPath,
    groqCredentialPath,
    allowCustomProject: input.deployment === 'host',
    botId: input.botId,
    botUsername: input.botUsername,
    nonce: input.nonce,
    nextUpdateId: null,
    ownerUserId: null,
    ownerChatId: null,
    selectedProjectPath: null,
    pendingProjectPath: null,
    executionProfile: input.presetProfile ?? null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  })
  const configPath = join(configDirectory, 'bridge.config.json')
  const environmentPath = join(configDirectory, 'bridge.env')
  const telegramCredentialPath = join(configDirectory, 'telegram-token')
  const targets = [
    configPath,
    environmentPath,
    telegramCredentialPath,
    groqCredentialPath,
    bootstrapPath,
  ]
  const existing = targets.find(existsSync)
  if (existing !== undefined) {
    throw new Error('installation target already contains bridge or bootstrap configuration')
  }

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(groqCredentialPath), { recursive: true, mode: 0o700 })
  chmodSync(configDirectory, 0o700)
  chmodSync(stateDirectory, 0o700)
  const created: string[] = []
  try {
    writePrivate(
      environmentPath,
      [
        '# Non-secret runtime paths for bot-first onboarding and the bridge.',
        `DASHI_CODEX_BRIDGE_CONFIG=${JSON.stringify(configPath)}`,
        `CODEX_TG_WIRE_BOOTSTRAP_FILE=${JSON.stringify(bootstrapPath)}`,
        `GROQ_API_KEY_FILE=${JSON.stringify(groqCredentialPath)}`,
        `CODEX_TG_WIRE_DEPLOYMENT=${input.deployment}`,
        '',
      ].join('\n'),
    )
    created.push(environmentPath)
    writePrivate(telegramCredentialPath, `${telegramToken}\n`)
    created.push(telegramCredentialPath)
    writePrivate(groqCredentialPath, '')
    created.push(groqCredentialPath)
    writePrivate(bootstrapPath, `${JSON.stringify(state, null, 2)}\n`)
    created.push(bootstrapPath)
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true })
    throw error
  }

  return {
    state,
    configPath,
    environmentPath,
    telegramCredentialPath,
    groqCredentialPath,
    onboardingUrl: `https://t.me/${state.botUsername}?start=${state.nonce}`,
  }
}

export function loadBridgeBootstrapState(path: string): BridgeBootstrapState {
  const resolved = safeAbsolutePath(path, 'bootstrapPath')
  if (!existsSync(resolved)) throw new Error('bot-first bootstrap state does not exist')
  const stat = lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error('bot-first bootstrap state is not a safe regular file')
  }
  try {
    return BridgeBootstrapStateSchema.parse(JSON.parse(readFileSync(resolved, 'utf8')))
  } catch (error) {
    throw new Error(
      `bot-first bootstrap state is invalid: ${error instanceof Error ? error.message : 'parse failed'}`,
    )
  }
}

export class BridgeBootstrapStateRepository {
  constructor(readonly path: string) {
    safeAbsolutePath(path, 'bootstrapPath')
  }

  load(): BridgeBootstrapState {
    return loadBridgeBootstrapState(this.path)
  }

  update(
    mutate: (current: BridgeBootstrapState) => BridgeBootstrapState,
    nowMs = Date.now(),
  ): BridgeBootstrapState {
    const current = this.load()
    const next = BridgeBootstrapStateSchema.parse({ ...mutate(current), updatedAtMs: nowMs })
    writePrivateAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }
}
