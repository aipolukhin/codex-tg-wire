import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initializeBridgeInstallation } from '../../src/bridge/installation.js'
import { loadBridgeServiceConfig } from '../../src/bridge/service-config.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dashi-install-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  return {
    root,
    project,
    configDirectory: join(root, 'config'),
    stateDirectory: join(root, 'state'),
  }
}

describe('initializeBridgeInstallation', () => {
  test('creates a private production config with no embedded credentials', async () => {
    const paths = fixture()
    const result = initializeBridgeInstallation({
      ...paths,
      projectPath: paths.project,
      telegramUserId: '123456789',
      telegramChatId: '-1001234567890',
      executionProfile: 'safe',
    })

    expect(statSync(result.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(result.environmentPath).mode & 0o777).toBe(0o600)
    expect(statSync(result.telegramCredentialPath).mode & 0o777).toBe(0o600)
    expect(statSync(result.stateDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(join(paths.stateDirectory, 'task-workspaces')).mode & 0o777).toBe(0o700)
    expect(await Bun.file(result.telegramCredentialPath).text()).toBe('')
    const serialized = await Bun.file(result.configPath).text()
    expect(serialized).not.toMatch(/token|apiKey|credential/i)
    expect(serialized).toContain('"networkAccess": false')
    expect(serialized).not.toContain('danger-full-access')

    writeFileSync(result.telegramCredentialPath, 'test-file-token\n', { mode: 0o600 })
    const config = loadBridgeServiceConfig({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: result.configPath,
        DASHI_TELEGRAM_BOT_TOKEN_FILE: result.telegramCredentialPath,
      },
    })
    expect(config.telegramToken).toBe('test-file-token')
    expect(config.projects[0]?.cwd).toBe(paths.project)
    expect(config.stateDatabase).toBe(join(paths.stateDirectory, 'bridge.sqlite3'))
    expect(config.taskWorkspaces.directory).toBe(join(paths.stateDirectory, 'task-workspaces'))
  })

  test('uses the owner-only YOLO execution profile by default', async () => {
    const paths = fixture()
    const result = initializeBridgeInstallation({
      ...paths,
      projectPath: paths.project,
      telegramUserId: '123456789',
      telegramChatId: '123456789',
    })
    const config = JSON.parse(await Bun.file(result.configPath).text()) as {
      projects: Array<{ sandboxMode: string; networkAccess: boolean }>
      codex: {
        approvalPolicy: string
        sandboxMode: string
        allowedSandboxModes: string[]
      }
    }

    expect(config.projects[0]?.sandboxMode).toBe('danger-full-access')
    expect(config.projects[0]?.networkAccess).toBe(false)
    expect(config.codex.approvalPolicy).toBe('never')
    expect(config.codex.sandboxMode).toBe('danger-full-access')
    expect(config.codex.allowedSandboxModes).toContain('danger-full-access')
  })

  test('enables Groq voice with a separate empty credential file', async () => {
    const paths = fixture()
    const result = initializeBridgeInstallation({
      ...paths,
      projectPath: paths.project,
      telegramUserId: '123456789',
      telegramChatId: '123456789',
      voiceProvider: 'groq',
    })

    expect(result.groqCredentialPath).not.toBeNull()
    expect(statSync(result.groqCredentialPath!).mode & 0o777).toBe(0o600)
    expect(await Bun.file(result.groqCredentialPath!).text()).toBe('')
    expect(await Bun.file(result.environmentPath).text()).toContain('GROQ_API_KEY_FILE=')
    const serialized = await Bun.file(result.configPath).text()
    expect(serialized).toContain('"provider": "groq"')
    expect(serialized).not.toMatch(/apiKey/i)
  })

  test('refuses overwrites and leaves the previous config intact', async () => {
    const paths = fixture()
    const input = {
      ...paths,
      projectPath: paths.project,
      telegramUserId: '123',
      telegramChatId: '123',
    }
    const first = initializeBridgeInstallation(input)
    const original = await Bun.file(first.configPath).text()

    expect(() => initializeBridgeInstallation(input)).toThrow('refusing overwrite')
    expect(await Bun.file(first.configPath).text()).toBe(original)
  })

  test('rejects unsafe paths, missing projects and malformed Telegram ids', () => {
    const paths = fixture()
    expect(() => initializeBridgeInstallation({
      ...paths,
      projectPath: paths.project,
      configDirectory: '/',
      telegramUserId: '123',
      telegramChatId: '123',
    })).toThrow('filesystem root')
    expect(() => initializeBridgeInstallation({
      ...paths,
      projectPath: join(paths.root, 'missing'),
      telegramUserId: '123',
      telegramChatId: '123',
    })).toThrow('does not exist')
    expect(() => initializeBridgeInstallation({
      ...paths,
      projectPath: paths.project,
      telegramUserId: 'not-an-id',
      telegramChatId: '123',
    })).toThrow('telegramUserId')
  })
})
