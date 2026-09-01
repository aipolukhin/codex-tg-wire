import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { DEFAULT_ATTACHMENT_MIME_TYPES } from '../telegram/durable-attachment-store.js'
import { DEFAULT_OUTBOUND_MIME_TYPES } from '../telegram/durable-outbound-media.js'

const TelegramUserIdSchema = z
  .union([z.string(), z.number().int().safe()])
  .transform(String)
  .pipe(z.string().regex(/^[1-9]\d*$/, 'must be a positive Telegram user id'))

const TelegramChatIdSchema = z
  .union([z.string(), z.number().int().safe()])
  .transform(String)
  .pipe(z.string().regex(/^-?[1-9]\d*$/, 'must be a non-zero Telegram chat id'))

const ProjectSchema = z
  .object({
    id: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    writableRoots: z.array(z.string().trim().min(1)).default([]),
    networkAccess: z.boolean().default(false),
  })
  .strict()

export const BridgeConfigFileSchema = z
  .object({
    stateDatabase: z.string().trim().min(1).default('./state/bridge.sqlite3'),
    projects: z.array(ProjectSchema).min(1),
    defaultProjectId: z.string().trim().min(1),
    telegram: z
      .object({
        allowedUserIds: z.array(TelegramUserIdSchema).min(1),
        allowedChatIds: z.array(TelegramChatIdSchema).min(1),
        apiRoot: z.string().url().optional(),
        pollingTimeoutSeconds: z.number().int().min(0).max(50).default(30),
        maxTextLength: z.number().int().min(1).max(4_096).default(4_096),
        rateLimit: z
          .object({
            perChatRefillPerSecond: z.number().positive().max(30).default(1),
            perChatBurst: z.number().int().min(1).max(30).default(3),
            globalRefillPerSecond: z.number().positive().max(100).default(25),
            globalBurst: z.number().int().min(1).max(100).default(25),
            maxAttempts: z.number().int().min(1).max(10).default(3),
            maxRetryAfterSeconds: z.number().int().min(1).max(300).default(60),
            jitterMaxMs: z.number().int().min(0).max(5_000).default(150),
          })
          .strict()
          .default({}),
      })
      .strict(),
    attachments: z
      .object({
        directory: z.string().trim().min(1).default('./state/attachments'),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
        allowedMimeTypes: z.array(
          z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
        ).min(1).default([...DEFAULT_ATTACHMENT_MIME_TYPES]),
      })
      .strict()
      .default({}),
    outboundMedia: z
      .object({
        enabled: z.boolean().default(true),
        directory: z.string().trim().min(1).default('./state/outbound-media'),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
        allowedMimeTypes: z.array(
          z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
        ).min(1).default([...DEFAULT_OUTBOUND_MIME_TYPES]),
      })
      .strict()
      .default({}),
    albums: z
      .object({
        flushMs: z.number().int().min(100).max(60_000).default(2_000),
      })
      .strict()
      .default({}),
    voice: z
      .object({
        provider: z.enum(['none', 'groq']).default('none'),
        model: z.string().trim().min(1).default('whisper-large-v3-turbo'),
        language: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).default('ru'),
        apiRoot: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS')
          .default('https://api.groq.com/openai/v1'),
        maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
        requestTimeoutMs: z.number().int().min(1_000).max(5 * 60_000).default(60_000),
      })
      .strict()
      .default({}),
    codex: z
      .object({
        binary: z.string().trim().min(1).optional(),
        args: z.array(z.string()).min(1).optional(),
        approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request'),
        sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access'])
          .default('workspace-write'),
        allowedSandboxModes: z.array(
          z.enum(['read-only', 'workspace-write', 'danger-full-access']),
        ).min(1).default(['read-only', 'workspace-write']),
        requestTimeoutMs: z.number().int().positive().default(30_000),
        turnTimeoutMs: z.number().int().nonnegative().default(0),
        interactionTimeoutMs: z.number().int().positive().default(10 * 60_000),
      })
      .strict()
      .default({}),
    productDecisions: z
      .object({
        enabled: z.boolean().default(false),
        repositoryPath: z.string().trim().min(1).optional(),
        remote: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).default('origin'),
        push: z.boolean().default(true),
      })
      .strict()
      .default({}),
    ux: z
      .object({
        enabled: z.boolean().default(true),
        chatStatusMessages: z.boolean().default(false),
        typingIndicator: z.boolean().default(true),
        receivedReaction: z.boolean().default(true),
        pinnedStatus: z.boolean().default(true),
        typingRefreshMs: z.number().int().min(1_000).max(5_000).default(4_000),
        elapsedRefreshMs: z.number().int().min(15_000).max(5 * 60_000).default(60_000),
        quotaRefreshMs: z.number().int().min(30_000).default(5 * 60_000),
        heartbeatAfterMs: z.number().int().min(10_000).default(2 * 60_000),
        heartbeatIntervalMs: z.number().int().min(10_000).default(5 * 60_000),
        pollIntervalMs: z.number().int().min(1_000).default(30_000),
      })
      .strict()
      .default({}),
    workers: z
      .object({
        leaseDurationMs: z.number().int().min(1_000).default(60_000),
        inboundConcurrency: z.number().int().min(2).max(16).default(2),
        reaperIntervalMs: z.number().int().min(100).default(5_000),
      })
      .strict()
      .default({}),
    health: z
      .object({
        enabled: z.boolean().default(true),
        host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
        port: z.number().int().min(1).max(65_535).default(8_787),
        startupGraceMs: z.number().int().min(1_000).default(60_000),
        staleAfterMs: z.number().int().min(10_000).default(120_000),
        maxConsecutiveErrors: z.number().int().min(1).max(100).default(3),
      })
      .strict()
      .default({}),
    retention: z
      .object({
        enabled: z.boolean().default(true),
        payloadMaxAgeDays: z.number().int().min(1).max(3_650).default(30),
        intervalMs: z.number().int().min(60_000).default(6 * 60 * 60_000),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>()
    for (const [index, project] of config.projects.entries()) {
      if (ids.has(project.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', index, 'id'],
          message: `duplicate project id: ${project.id}`,
        })
      }
      ids.add(project.id)
    }
    if (!ids.has(config.defaultProjectId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultProjectId'],
        message: 'must reference one of projects[].id',
      })
    }
    for (const [index, project] of config.projects.entries()) {
      if (
        project.sandboxMode !== undefined &&
        !config.codex.allowedSandboxModes.includes(project.sandboxMode)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['projects', index, 'sandboxMode'],
          message: 'must be included in codex.allowedSandboxModes',
        })
      }
    }
    if (
      config.codex.turnTimeoutMs > 0 &&
      config.codex.interactionTimeoutMs >= config.codex.turnTimeoutMs
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codex', 'interactionTimeoutMs'],
        message: 'must be less than codex.turnTimeoutMs',
      })
    }
    if (!config.codex.allowedSandboxModes.includes(config.codex.sandboxMode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codex', 'sandboxMode'],
        message: 'must be included in codex.allowedSandboxModes',
      })
    }
    if (config.productDecisions.enabled && config.productDecisions.repositoryPath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productDecisions', 'repositoryPath'],
        message: 'is required when productDecisions.enabled is true',
      })
    }
    if (config.ux.heartbeatIntervalMs < config.ux.pollIntervalMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ux', 'heartbeatIntervalMs'],
        message: 'must be greater than or equal to ux.pollIntervalMs',
      })
    }
    if (config.health.staleAfterMs <= config.telegram.pollingTimeoutSeconds * 1_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['health', 'staleAfterMs'],
        message: 'must be greater than telegram.pollingTimeoutSeconds',
      })
    }
  })

type ParsedBridgeConfigFile = z.infer<typeof BridgeConfigFileSchema>

export interface BridgeRuntimeConfig extends ParsedBridgeConfigFile {
  configPath: string
}

export interface BridgeServiceConfig extends BridgeRuntimeConfig {
  telegramToken: string
  voiceApiKey: string | null
  voiceCredentialPath: string | null
}

export interface LoadBridgeServiceConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface BridgeCredential {
  value: string
  source: 'environment' | 'file'
}

export interface BridgeCredentialOptions {
  environmentNames: readonly string[]
  fileEnvironmentName: string
  systemdCredentialName: string
  label: string
  allowMissingOrEmpty?: boolean
}

const MAX_CREDENTIAL_BYTES = 64 * 1024

/** Resolves a secret without ever returning its path or value in an error. */
export function resolveBridgeCredential(
  env: NodeJS.ProcessEnv,
  options: BridgeCredentialOptions,
): BridgeCredential | null {
  for (const name of options.environmentNames) {
    const value = env[name]?.trim()
    if (value) return { value, source: 'environment' }
  }

  const explicitPath = env[options.fileEnvironmentName]?.trim()
  const credentialsDirectory = env.CREDENTIALS_DIRECTORY?.trim()
  const path = explicitPath || (
    credentialsDirectory
      ? join(credentialsDirectory, options.systemdCredentialName)
      : ''
  )
  if (!path) return null
  if (!existsSync(path)) {
    if (explicitPath && options.allowMissingOrEmpty === true) return null
    if (explicitPath) throw new Error(`${options.label} credential file does not exist`)
    return null
  }

  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('credential source is not a regular file')
    }
    if (stat.size === 0 && options.allowMissingOrEmpty === true) return null
    if (stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error('credential file has an invalid size')
    }
    const value = readFileSync(path, 'utf8').trim()
    if (!value || value.includes('\0')) throw new Error('credential file is empty or invalid')
    return { value, source: 'file' }
  } catch (error) {
    throw new Error(
      `cannot read ${options.label} credential file: ${error instanceof Error ? error.message : 'read failed'}`,
    )
  }
}

export const TELEGRAM_CREDENTIAL_OPTIONS: BridgeCredentialOptions = {
  environmentNames: ['DASHI_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'],
  fileEnvironmentName: 'DASHI_TELEGRAM_BOT_TOKEN_FILE',
  systemdCredentialName: 'telegram-token',
  label: 'Telegram bot token',
}

export const GROQ_CREDENTIAL_OPTIONS: BridgeCredentialOptions = {
  environmentNames: ['GROQ_API_KEY'],
  fileEnvironmentName: 'GROQ_API_KEY_FILE',
  systemdCredentialName: 'groq-api-key',
  label: 'Groq API key',
  allowMissingOrEmpty: true,
}

export function bridgeCredentialFilePath(
  env: NodeJS.ProcessEnv,
  options: BridgeCredentialOptions,
): string | null {
  const explicitPath = env[options.fileEnvironmentName]?.trim()
  // Only an explicit file path is a rotation target. systemd credentials are
  // intentionally read-only and remain supported by voiceApiKey as a static source.
  return explicitPath || null
}

function absoluteFrom(baseDirectory: string, value: string): string {
  if (value === ':memory:' || isAbsolute(value)) return value
  return resolve(baseDirectory, value)
}

/** Loads and resolves the non-secret JSON configuration without requiring credentials. */
export function loadBridgeRuntimeConfig(
  options: LoadBridgeServiceConfigOptions = {},
): BridgeRuntimeConfig {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const configPath = absoluteFrom(
    cwd,
    env.DASHI_CODEX_BRIDGE_CONFIG?.trim() || 'bridge.config.json',
  )
  if (!existsSync(configPath)) {
    throw new Error(
      `bridge config not found: ${configPath}; copy bridge.config.example.json and set DASHI_CODEX_BRIDGE_CONFIG`,
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `cannot parse bridge config ${configPath}: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    )
  }

  let parsed: ParsedBridgeConfigFile
  try {
    parsed = BridgeConfigFileSchema.parse(raw)
  } catch (error) {
    throw new Error(
      `invalid bridge config ${configPath}: ${error instanceof Error ? error.message : 'validation failed'}`,
    )
  }

  const baseDirectory = dirname(configPath)
  const envCodexBinary = env.CODEX_BINARY_PATH?.trim()
  return {
    ...parsed,
    configPath,
    stateDatabase: absoluteFrom(baseDirectory, parsed.stateDatabase),
    attachments: {
      ...parsed.attachments,
      directory: absoluteFrom(baseDirectory, parsed.attachments.directory),
    },
    outboundMedia: {
      ...parsed.outboundMedia,
      directory: absoluteFrom(baseDirectory, parsed.outboundMedia.directory),
    },
    codex: {
      ...parsed.codex,
      ...(parsed.codex.binary === undefined && envCodexBinary
        ? { binary: envCodexBinary }
        : {}),
    },
    productDecisions: {
      ...parsed.productDecisions,
      ...(parsed.productDecisions.repositoryPath === undefined
        ? {}
        : { repositoryPath: absoluteFrom(baseDirectory, parsed.productDecisions.repositoryPath) }),
    },
    projects: parsed.projects.map((project) => ({
      ...project,
      cwd: absoluteFrom(baseDirectory, project.cwd),
      writableRoots: project.writableRoots.map((root) => absoluteFrom(baseDirectory, root)),
    })),
  }
}

export function loadBridgeServiceConfig(
  options: LoadBridgeServiceConfigOptions = {},
): BridgeServiceConfig {
  const env = options.env ?? process.env
  const config = loadBridgeRuntimeConfig(options)
  const telegramCredential = resolveBridgeCredential(env, TELEGRAM_CREDENTIAL_OPTIONS)
  if (telegramCredential === null) {
    throw new Error(
      'Telegram bot token is required via environment, DASHI_TELEGRAM_BOT_TOKEN_FILE or systemd credential telegram-token',
    )
  }
  const telegramToken = telegramCredential.value
  const voiceApiKey = resolveBridgeCredential(env, GROQ_CREDENTIAL_OPTIONS)?.value ?? null
  const voiceCredentialPath = bridgeCredentialFilePath(env, GROQ_CREDENTIAL_OPTIONS)

  return { ...config, telegramToken, voiceApiKey, voiceCredentialPath }
}
