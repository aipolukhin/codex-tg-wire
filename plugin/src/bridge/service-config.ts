import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

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
        turnTimeoutMs: z.number().int().positive().default(30 * 60_000),
        interactionTimeoutMs: z.number().int().positive().default(10 * 60_000),
      })
      .strict()
      .default({}),
    ux: z
      .object({
        enabled: z.boolean().default(true),
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
    if (config.codex.interactionTimeoutMs >= config.codex.turnTimeoutMs) {
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
}

export interface LoadBridgeServiceConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
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
    projects: parsed.projects.map((project) => ({
      ...project,
      cwd: absoluteFrom(baseDirectory, project.cwd),
    })),
  }
}

export function loadBridgeServiceConfig(
  options: LoadBridgeServiceConfigOptions = {},
): BridgeServiceConfig {
  const env = options.env ?? process.env
  const config = loadBridgeRuntimeConfig(options)
  const telegramToken = (
    env.DASHI_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN ?? ''
  ).trim()
  if (telegramToken.length === 0) {
    throw new Error('DASHI_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) is required')
  }
  const voiceApiKey = (env.GROQ_API_KEY ?? '').trim() || null
  if (config.voice.provider === 'groq' && voiceApiKey === null) {
    throw new Error('GROQ_API_KEY is required when voice.provider is groq')
  }

  return { ...config, telegramToken, voiceApiKey }
}
