import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

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
    workers: z
      .object({
        leaseDurationMs: z.number().int().min(1_000).default(60_000),
        inboundConcurrency: z.number().int().min(2).max(16).default(2),
        reaperIntervalMs: z.number().int().min(100).default(5_000),
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
  })

type ParsedBridgeConfigFile = z.infer<typeof BridgeConfigFileSchema>

export interface BridgeServiceConfig extends ParsedBridgeConfigFile {
  configPath: string
  telegramToken: string
}

export interface LoadBridgeServiceConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

function absoluteFrom(baseDirectory: string, value: string): string {
  if (value === ':memory:' || isAbsolute(value)) return value
  return resolve(baseDirectory, value)
}

export function loadBridgeServiceConfig(
  options: LoadBridgeServiceConfigOptions = {},
): BridgeServiceConfig {
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

  const telegramToken = (
    env.DASHI_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN ?? ''
  ).trim()
  if (telegramToken.length === 0) {
    throw new Error('DASHI_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) is required')
  }

  const baseDirectory = dirname(configPath)
  return {
    ...parsed,
    configPath,
    telegramToken,
    stateDatabase: absoluteFrom(baseDirectory, parsed.stateDatabase),
    projects: parsed.projects.map((project) => ({
      ...project,
      cwd: absoluteFrom(baseDirectory, project.cwd),
    })),
  }
}
