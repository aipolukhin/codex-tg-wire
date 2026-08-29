import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  formatBridgeDoctorReport,
  runBridgeDoctor,
  type DoctorCommandResult,
} from '../../src/bridge/doctor.js'
import { openDurableDatabase } from '../../src/durable/database.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function fixture(overrides: Record<string, unknown> = {}): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dashi-doctor-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace'))
  const configPath = join(root, 'bridge.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      stateDatabase: './state/bridge.sqlite3',
      projects: [{ id: 'main', cwd: './workspace' }],
      defaultProjectId: 'main',
      telegram: { allowedUserIds: ['123'], allowedChatIds: ['123'] },
      ...overrides,
    }),
  )
  return { root, configPath }
}

const compatibleCodex = (): DoctorCommandResult => ({
  status: 0,
  stdout: 'codex-cli 0.149.1\n',
  stderr: '',
})

describe('runBridgeDoctor', () => {
  test('accepts a fresh production config without creating its state paths', async () => {
    const { root, configPath } = fixture()
    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN: 'environment-only-token',
      },
      runCommand: compatibleCodex,
    })

    expect(report.ok).toBeTrue()
    expect(report.checks).toContainEqual({
      id: 'sqlite.schema',
      status: 'warn',
      message: 'state database does not exist yet; it will be created on first start',
    })
    expect(report.checks.find((item) => item.id === 'telegram.api')?.status).toBe('warn')
    expect(report.checks.find((item) => item.id === 'sandbox.policy')?.status).toBe('pass')
    await expect(Bun.file(join(root, 'state')).exists()).resolves.toBeFalse()
  })

  test('checks an existing database read-only at the latest schema', async () => {
    const { root, configPath } = fixture()
    const databasePath = join(root, 'state', 'bridge.sqlite3')
    openDurableDatabase(databasePath).close()

    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN: 'environment-only-token',
      },
      runCommand: compatibleCodex,
    })

    expect(report.ok).toBeTrue()
    expect(report.checks.find((item) => item.id === 'sqlite.integrity')?.status).toBe('pass')
    expect(report.checks.find((item) => item.id === 'sqlite.schema')?.status).toBe('pass')
  })

  test('reports missing credentials, missing projects and incompatible Codex', async () => {
    const { root, configPath } = fixture({
      projects: [{ id: 'main', cwd: './missing-workspace' }],
    })
    const report = await runBridgeDoctor({
      env: { DASHI_CODEX_BRIDGE_CONFIG: configPath },
      runCommand: () => ({ status: 0, stdout: 'codex-cli 9.9.9\n', stderr: '' }),
    })

    expect(report.ok).toBeFalse()
    expect(report.checks.find((item) => item.id === 'credentials.telegram')?.status).toBe('fail')
    expect(report.checks.find((item) => item.id === 'project.main')?.message).toContain(join(root, 'missing-workspace'))
    expect(report.checks.find((item) => item.id === 'codex.compatibility')?.status).toBe('fail')
  })

  test('never exposes the bot token in online diagnostics or formatted output', async () => {
    const { configPath } = fixture()
    const token = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN: token,
      },
      online: true,
      runCommand: compatibleCodex,
      fetch: () => Promise.reject(new Error(`request failed for /bot${token}/getMe`)),
    })
    const output = formatBridgeDoctorReport(report, [token])

    expect(output).not.toContain(token)
    expect(JSON.stringify(report)).not.toContain(token)
    expect(report.checks.find((item) => item.id === 'telegram.api')?.status).toBe('fail')
  })

  test('recognizes a credential file without exposing its path or value', async () => {
    const { root, configPath } = fixture()
    const credentialPath = join(root, 'private-telegram-token')
    const token = '123456789:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    writeFileSync(credentialPath, `${token}\n`, { mode: 0o600 })
    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN_FILE: credentialPath,
      },
      runCommand: compatibleCodex,
    })
    const output = formatBridgeDoctorReport(report, [token])

    expect(report.ok).toBeTrue()
    expect(report.checks).toContainEqual({
      id: 'credentials.telegram',
      status: 'pass',
      message: 'Telegram bot token is provided through file',
    })
    expect(output).not.toContain(token)
    expect(output).not.toContain(credentialPath)
  })

  test('stops cleanly on invalid JSON without attempting runtime checks', async () => {
    const { configPath } = fixture()
    writeFileSync(configPath, '{')
    let commandCalled = false
    const report = await runBridgeDoctor({
      env: { DASHI_CODEX_BRIDGE_CONFIG: configPath },
      runCommand: () => {
        commandCalled = true
        return compatibleCodex()
      },
    })

    expect(report.ok).toBeFalse()
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]?.id).toBe('config')
    expect(commandCalled).toBeFalse()
  })

  test('warns when durable payload retention is explicitly disabled', async () => {
    const { configPath } = fixture({ retention: { enabled: false } })
    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN: 'environment-only-token',
      },
      runCommand: compatibleCodex,
    })

    expect(report.ok).toBeTrue()
    expect(report.checks.find((item) => item.id === 'retention.policy')?.status).toBe('warn')
  })

  test('describes YOLO as a host-level trust decision, not a network sandbox', async () => {
    const { configPath } = fixture({
      projects: [{
        id: 'main',
        cwd: './workspace',
        sandboxMode: 'danger-full-access',
        networkAccess: false,
      }],
      codex: {
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      },
    })
    const report = await runBridgeDoctor({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: configPath,
        DASHI_TELEGRAM_BOT_TOKEN: 'environment-only-token',
      },
      runCommand: compatibleCodex,
    })

    expect(report.ok).toBeTrue()
    expect(report.checks.find((item) => item.id === 'project.main.network')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('not a sandbox boundary'),
    })
    expect(report.checks.find((item) => item.id === 'sandbox.policy')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('all rights of the service user'),
    })
  })
})
