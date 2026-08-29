import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadBridgeServiceConfig } from '../../src/bridge/service-config.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function fixture(overrides: Record<string, unknown> = {}): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'dashi-codex-config-'))
  roots.push(root)
  const path = join(root, 'bridge.json')
  writeFileSync(
    path,
    JSON.stringify({
      stateDatabase: './state/runtime.sqlite3',
      projects: [{ id: 'main', cwd: './workspace' }],
      defaultProjectId: 'main',
      telegram: {
        allowedUserIds: ['123456789'],
        allowedChatIds: ['123456789', '-1001234567890'],
      },
      ...overrides,
    }),
  )
  return { root, path }
}

describe('loadBridgeServiceConfig', () => {
  test('resolves state and project paths from the config file directory', () => {
    const { root, path } = fixture()
    const config = loadBridgeServiceConfig({
      cwd: '/must/not/be/used',
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: path,
        DASHI_TELEGRAM_BOT_TOKEN: 'test-token',
      },
    })

    expect(config.stateDatabase).toBe(join(root, 'state', 'runtime.sqlite3'))
    expect(config.attachments.directory).toBe(join(root, 'state', 'attachments'))
    expect(config.attachments.maxBytes).toBe(20 * 1024 * 1024)
    expect(config.attachments.allowedMimeTypes).toContain('image/jpeg')
    expect(config.projects).toEqual([{ id: 'main', cwd: join(root, 'workspace') }])
    expect(config.telegram.allowedUserIds).toEqual(['123456789'])
    expect(config.telegram.allowedChatIds).toEqual(['123456789', '-1001234567890'])
    expect(config.telegramToken).toBe('test-token')
    expect(config.workers.inboundConcurrency).toBe(2)
    expect(config.codex.approvalPolicy).toBe('on-request')
    expect(config.codex.sandboxMode).toBe('workspace-write')
    expect(config.codex.allowedSandboxModes).toEqual(['read-only', 'workspace-write'])
    expect(config.codex.interactionTimeoutMs).toBe(10 * 60_000)
    expect(config.voice.provider).toBe('none')
    expect(config.voiceApiKey).toBeNull()
  })

  test('accepts the legacy token env name but never a token inside JSON', () => {
    const valid = fixture()
    expect(
      loadBridgeServiceConfig({
        env: { DASHI_CODEX_BRIDGE_CONFIG: valid.path, TELEGRAM_BOT_TOKEN: 'env-only' },
      }).telegramToken,
    ).toBe('env-only')

    const invalid = fixture({ telegramToken: 'must-not-live-in-config' })
    expect(() =>
      loadBridgeServiceConfig({
        env: { DASHI_CODEX_BRIDGE_CONFIG: invalid.path, DASHI_TELEGRAM_BOT_TOKEN: 'safe' },
      }),
    ).toThrow('Unrecognized key')
  })

  test('requires explicit credentials and a configured default project', () => {
    const missingToken = fixture()
    expect(() =>
      loadBridgeServiceConfig({ env: { DASHI_CODEX_BRIDGE_CONFIG: missingToken.path } }),
    ).toThrow('DASHI_TELEGRAM_BOT_TOKEN')

    const badProject = fixture({ defaultProjectId: 'missing' })
    expect(() =>
      loadBridgeServiceConfig({
        env: { DASHI_CODEX_BRIDGE_CONFIG: badProject.path, DASHI_TELEGRAM_BOT_TOKEN: 'safe' },
      }),
    ).toThrow('must reference one of projects[].id')
  })

  test('fails loudly when the config file is absent', () => {
    expect(() =>
      loadBridgeServiceConfig({
        cwd: '/tmp/no-dashi-config-here',
        env: { DASHI_TELEGRAM_BOT_TOKEN: 'safe' },
      }),
    ).toThrow('copy bridge.config.example.json')
  })

  test('requires interaction expiry before the overall turn timeout', () => {
    const invalid = fixture({
      codex: { turnTimeoutMs: 60_000, interactionTimeoutMs: 60_000 },
    })
    expect(() =>
      loadBridgeServiceConfig({
        env: {
          DASHI_CODEX_BRIDGE_CONFIG: invalid.path,
          DASHI_TELEGRAM_BOT_TOKEN: 'safe',
        },
      }),
    ).toThrow('must be less than codex.turnTimeoutMs')
  })

  test('requires the default sandbox to be explicitly allowed', () => {
    const invalid = fixture({
      codex: {
        sandboxMode: 'danger-full-access',
        allowedSandboxModes: ['read-only', 'workspace-write'],
      },
    })
    expect(() =>
      loadBridgeServiceConfig({
        env: {
          DASHI_CODEX_BRIDGE_CONFIG: invalid.path,
          DASHI_TELEGRAM_BOT_TOKEN: 'safe',
        },
      }),
    ).toThrow('must be included in codex.allowedSandboxModes')
  })

  test('validates attachment MIME policy and byte ceiling', () => {
    const invalidMime = fixture({
      attachments: { allowedMimeTypes: ['not-a-mime'] },
    })
    expect(() => loadBridgeServiceConfig({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: invalidMime.path,
        DASHI_TELEGRAM_BOT_TOKEN: 'safe',
      },
    })).toThrow('invalid bridge config')

    const tooLarge = fixture({
      attachments: { maxBytes: 20 * 1024 * 1024 + 1 },
    })
    expect(() => loadBridgeServiceConfig({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: tooLarge.path,
        DASHI_TELEGRAM_BOT_TOKEN: 'safe',
      },
    })).toThrow('invalid bridge config')
  })

  test('keeps Groq credentials in env and requires them only for the selected adapter', () => {
    const enabled = fixture({ voice: { provider: 'groq' } })
    expect(() => loadBridgeServiceConfig({
      env: { DASHI_CODEX_BRIDGE_CONFIG: enabled.path, DASHI_TELEGRAM_BOT_TOKEN: 'safe' },
    })).toThrow('GROQ_API_KEY')
    expect(loadBridgeServiceConfig({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: enabled.path,
        DASHI_TELEGRAM_BOT_TOKEN: 'safe',
        GROQ_API_KEY: 'env-groq-key',
      },
    }).voiceApiKey).toBe('env-groq-key')

    const hardcoded = fixture({ voice: { provider: 'groq', apiKey: 'must-not-be-in-json' } })
    expect(() => loadBridgeServiceConfig({
      env: {
        DASHI_CODEX_BRIDGE_CONFIG: hardcoded.path,
        DASHI_TELEGRAM_BOT_TOKEN: 'safe',
        GROQ_API_KEY: 'env-groq-key',
      },
    })).toThrow('Unrecognized key')
  })
})
