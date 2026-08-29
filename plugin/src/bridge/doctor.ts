import { spawnSync } from 'node:child_process'
import { constants, accessSync, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { Database } from 'bun:sqlite'

import { LATEST_DURABLE_SCHEMA_VERSION } from '../durable/database.js'
import { redactSecrets } from '../safety/redact.js'
import {
  loadBridgeRuntimeConfig,
  type BridgeRuntimeConfig,
  type LoadBridgeServiceConfigOptions,
} from './service-config.js'

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  message: string
}

export interface BridgeDoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export type DoctorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface RunBridgeDoctorOptions extends LoadBridgeServiceConfigOptions {
  online?: boolean
  fetch?: DoctorFetch
  runCommand?: (command: string, args: readonly string[]) => DoctorCommandResult
}

interface CompatibilityManifest {
  codexCliVersion: string
}

function check(id: string, status: DoctorStatus, message: string): DoctorCheck {
  return { id, status, message }
}

function defaultRunCommand(command: string, args: readonly string[]): DoctorCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function credential(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return null
}

function nearestExistingPath(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function inspectDirectory(
  id: string,
  path: string,
  label: string,
  mustExist: boolean,
  writable: boolean,
): DoctorCheck {
  try {
    const existing = nearestExistingPath(path)
    const targetExists = existing === path
    const stats = statSync(existing)
    if (!stats.isDirectory()) {
      return check(id, 'fail', `${label}: path component is not a directory: ${existing}`)
    }
    if (mustExist && !targetExists) {
      return check(id, 'fail', `${label}: directory does not exist: ${path}`)
    }
    accessSync(existing, constants.R_OK | (writable ? constants.W_OK : 0))
    return check(
      id,
      'pass',
      targetExists
        ? `${label}: ${writable ? 'readable and writable' : 'readable'}`
        : `${label}: can be created under writable parent ${existing}`,
    )
  } catch (error) {
    return check(
      id,
      'fail',
      `${label}: ${error instanceof Error ? error.message : 'filesystem check failed'}`,
    )
  }
}

function inspectDatabase(config: BridgeRuntimeConfig): DoctorCheck[] {
  const path = config.stateDatabase
  if (path === ':memory:') {
    return [check('sqlite.persistence', 'fail', 'stateDatabase=:memory: is not durable')]
  }
  if (!existsSync(path)) {
    return [check('sqlite.schema', 'warn', 'state database does not exist yet; it will be created on first start')]
  }

  let database: Database | undefined
  try {
    database = new Database(path, { readonly: true, strict: true })
    const quickCheck = database.query<Record<string, string>, []>('PRAGMA quick_check').get()
    if (quickCheck === null || Object.values(quickCheck)[0] !== 'ok') {
      return [check('sqlite.integrity', 'fail', 'SQLite quick_check failed')]
    }
    const migrationsTable = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get()
    if (migrationsTable === null) {
      return [
        check('sqlite.integrity', 'pass', 'SQLite quick_check passed'),
        check('sqlite.schema', 'fail', 'schema_migrations table is missing'),
      ]
    }
    const row = database
      .query<{ version: number | null }, []>('SELECT max(version) AS version FROM schema_migrations')
      .get()
    const version = row?.version ?? 0
    const schemaCheck = version > LATEST_DURABLE_SCHEMA_VERSION
      ? check(
          'sqlite.schema',
          'fail',
          `database schema v${version} is newer than supported v${LATEST_DURABLE_SCHEMA_VERSION}`,
        )
      : version < LATEST_DURABLE_SCHEMA_VERSION
        ? check(
            'sqlite.schema',
            'warn',
            `database schema v${version} will migrate forward to v${LATEST_DURABLE_SCHEMA_VERSION} on start`,
          )
        : check('sqlite.schema', 'pass', `database schema v${version} is supported`)
    return [check('sqlite.integrity', 'pass', 'SQLite quick_check passed'), schemaCheck]
  } catch (error) {
    return [
      check(
        'sqlite.integrity',
        'fail',
        `cannot inspect state database: ${error instanceof Error ? error.message : 'unknown SQLite error'}`,
      ),
    ]
  } finally {
    database?.close()
  }
}

function inspectCodex(
  config: BridgeRuntimeConfig,
  runCommand: (command: string, args: readonly string[]) => DoctorCommandResult,
): DoctorCheck {
  const command = config.codex.binary ?? 'codex'
  const result = runCommand(command, ['--version'])
  if (result.error !== undefined) {
    return check('codex.binary', 'fail', `cannot execute Codex CLI: ${result.error.message}`)
  }
  if (result.status !== 0) {
    return check(
      'codex.binary',
      'fail',
      `Codex CLI exited with status ${String(result.status)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
    )
  }
  const match = result.stdout.trim().match(/^codex-cli\s+(.+)$/)
  if (match === null || match[1] === undefined) {
    return check('codex.binary', 'fail', 'Codex CLI returned an unexpected version string')
  }

  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../codex-app-server.compatibility.json', import.meta.url), 'utf8'),
    ) as CompatibilityManifest
    return match[1] === manifest.codexCliVersion
      ? check('codex.compatibility', 'pass', `Codex CLI ${match[1]} matches the pinned App Server schema`)
      : check(
          'codex.compatibility',
          'fail',
          `Codex CLI ${match[1]} does not match pinned ${manifest.codexCliVersion}; run codex:schema:check before upgrading`,
        )
  } catch (error) {
    return check(
      'codex.compatibility',
      'fail',
      `cannot read Codex compatibility manifest: ${error instanceof Error ? error.message : 'invalid manifest'}`,
    )
  }
}

async function inspectTelegram(
  config: BridgeRuntimeConfig,
  token: string | null,
  online: boolean,
  fetchImpl: DoctorFetch,
): Promise<DoctorCheck> {
  if (!online) {
    return check('telegram.api', 'warn', 'Telegram API check skipped; rerun with --online')
  }
  if (token === null) {
    return check('telegram.api', 'fail', 'Telegram API check cannot run without a bot token')
  }
  const root = (config.telegram.apiRoot ?? 'https://api.telegram.org').replace(/\/$/, '')
  try {
    const response = await fetchImpl(`${root}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return check('telegram.api', 'fail', `Telegram API returned HTTP ${response.status}`)
    }
    const body = await response.json() as { ok?: unknown }
    return body.ok === true
      ? check('telegram.api', 'pass', 'Telegram Bot API authentication succeeded')
      : check('telegram.api', 'fail', 'Telegram Bot API rejected the credentials')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error'
    return check(
      'telegram.api',
      'fail',
      `Telegram API check failed: ${redactSecrets(message, [token])}`,
    )
  }
}

export async function runBridgeDoctor(
  options: RunBridgeDoctorOptions = {},
): Promise<BridgeDoctorReport> {
  const env = options.env ?? process.env
  const checks: DoctorCheck[] = []
  let config: BridgeRuntimeConfig
  try {
    config = loadBridgeRuntimeConfig({ env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
    checks.push(check('config', 'pass', 'bridge config is valid and contains no credential fields'))
  } catch (error) {
    checks.push(
      check(
        'config',
        'fail',
        error instanceof Error ? error.message : 'bridge config validation failed',
      ),
    )
    return { ok: false, checks }
  }

  const telegramToken = credential(env, ['DASHI_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'])
  checks.push(
    telegramToken === null
      ? check('credentials.telegram', 'fail', 'DASHI_TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) is missing')
      : check('credentials.telegram', 'pass', 'Telegram bot token is provided through the environment'),
  )
  if (config.voice.provider === 'groq') {
    checks.push(
      credential(env, ['GROQ_API_KEY']) === null
        ? check('credentials.voice', 'fail', 'GROQ_API_KEY is missing for voice.provider=groq')
        : check('credentials.voice', 'pass', 'Groq API key is provided through the environment'),
    )
  }

  const projectWritable = config.codex.sandboxMode !== 'read-only'
  for (const project of config.projects) {
    checks.push(
      inspectDirectory(
        `project.${project.id}`,
        project.cwd,
        `project ${project.id}`,
        true,
        projectWritable,
      ),
    )
  }
  checks.push(inspectDirectory('state.parent', dirname(config.stateDatabase), 'state database directory', false, true))
  checks.push(inspectDirectory('attachments.directory', config.attachments.directory, 'attachment directory', false, true))
  if (config.outboundMedia.enabled) {
    checks.push(inspectDirectory('outbound.directory', config.outboundMedia.directory, 'outbound media directory', false, true))
  }
  if (config.codex.allowedSandboxModes.includes('danger-full-access')) {
    checks.push(
      check(
        'sandbox.policy',
        'warn',
        'danger-full-access is allowlisted; remove it unless the owner explicitly needs unrestricted execution',
      ),
    )
  } else {
    checks.push(check('sandbox.policy', 'pass', 'danger-full-access is denied by the sandbox allowlist'))
  }
  checks.push(...inspectDatabase(config))
  checks.push(inspectCodex(config, options.runCommand ?? defaultRunCommand))
  checks.push(
    await inspectTelegram(config, telegramToken, options.online ?? false, options.fetch ?? fetch),
  )

  return { ok: checks.every((item) => item.status !== 'fail'), checks }
}

export function formatBridgeDoctorReport(
  report: BridgeDoctorReport,
  secrets: readonly string[] = [],
): string {
  const labels: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }
  const lines = ['Dashi Codex bridge doctor']
  for (const item of report.checks) {
    lines.push(`[${labels[item.status]}] ${item.id}: ${redactSecrets(item.message, secrets)}`)
  }
  const passed = report.checks.filter((item) => item.status === 'pass').length
  const warnings = report.checks.filter((item) => item.status === 'warn').length
  const failed = report.checks.filter((item) => item.status === 'fail').length
  lines.push(`Summary: ${passed} passed, ${warnings} warnings, ${failed} failed`)
  return `${lines.join('\n')}\n`
}
