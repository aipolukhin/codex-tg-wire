import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BootstrapOnboardingController,
  type BootstrapTelegramApi,
} from '../../src/bridge/bootstrap-onboarding.js'
import {
  BridgeBootstrapStateRepository,
  initializeBridgeBootstrap,
} from '../../src/bridge/bootstrap-installation.js'
import { finalizeBridgeBootstrap } from '../../src/bridge/installation.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqlitePollCursorRepository } from '../../src/durable/poll-cursor-repository.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

class FakeTelegram implements BootstrapTelegramApi {
  readonly messages: Array<{ chatId: string; text: string; options: unknown }> = []
  readonly answers: string[] = []

  async sendMessage(chatId: string, text: string, options?: unknown): Promise<{ message_id: number }> {
    this.messages.push({ chatId, text, options })
    return { message_id: this.messages.length }
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<true> {
    this.answers.push(callbackQueryId)
    return true
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-bootstrap-'))
  roots.push(root)
  const home = join(root, 'home')
  const configDirectory = join(root, 'config')
  const stateDirectory = join(root, 'state')
  const bootstrapPath = join(configDirectory, 'bootstrap-state.json')
  const defaultProjectPath = join(home, 'codex-workspace')
  mkdirSync(home, { recursive: true })
  const initialized = initializeBridgeBootstrap({
    bootstrapPath,
    configDirectory,
    stateDirectory,
    defaultProjectPath,
    deployment: 'host' as const,
    botId: '999001',
    botUsername: 'codex_wire_test_bot',
    nonce: 'owner_nonce_1234567890',
    telegramToken: '123456789:test_token',
    nowMs: 1_000,
  })
  return {
    root,
    home,
    configDirectory,
    stateDirectory,
    bootstrapPath,
    defaultProjectPath,
    initialized,
  }
}

function ownerStart(nonce = 'owner_nonce_1234567890') {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      text: `/start ${nonce}`,
      from: { id: 7001, is_bot: false },
      chat: { id: 7001, type: 'private' },
    },
  }
}

function callback(updateId: number, id: string, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id,
      data,
      from: { id: 7001, is_bot: false },
      message: { message_id: 20 + updateId, chat: { id: 7001, type: 'private' } },
    },
  }
}

describe('bot-first bootstrap onboarding', () => {
  test('persists credentials privately and atomically finalizes a production config', async () => {
    const item = fixture()
    expect(item.initialized.onboardingUrl).toBe(
      'https://t.me/codex_wire_test_bot?start=owner_nonce_1234567890',
    )
    expect(statSync(join(item.configDirectory, 'telegram-token')).mode & 0o777).toBe(0o600)
    expect(statSync(item.bootstrapPath).mode & 0o777).toBe(0o600)
    mkdirSync(item.defaultProjectPath)

    const finalized = finalizeBridgeBootstrap({
      configDirectory: item.configDirectory,
      stateDirectory: item.stateDirectory,
      projectPath: item.defaultProjectPath,
      telegramUserId: '7001',
      telegramChatId: '7001',
      executionProfile: 'yolo',
      voiceProvider: 'groq',
      groqCredentialPath: join(item.configDirectory, 'groq-api-key'),
    })

    const config = JSON.parse(await Bun.file(finalized.configPath).text())
    expect(existsSync(finalized.configPath)).toBeTrue()
    expect(config.telegram.allowedUserIds).toEqual(['7001'])
    expect(config.telegram.allowedChatIds).toEqual(['7001'])
    expect(config.projects[0].cwd).toBe(item.defaultProjectPath)
    expect(config.codex.approvalPolicy).toBe('never')
  })

  test('claims only the nonce owner, creates the default project and records YOLO', async () => {
    const item = fixture()
    const states = new BridgeBootstrapStateRepository(item.bootstrapPath)
    const telegram = new FakeTelegram()
    const controller = new BootstrapOnboardingController(states, telegram, {
      homeDirectory: item.home,
    })

    expect(await controller.handleUpdate(ownerStart('wrong_nonce_123456789'))).toBeFalse()
    expect(states.load().status).toBe('awaiting_owner')
    expect(telegram.messages).toHaveLength(0)

    expect(await controller.handleUpdate(ownerStart())).toBeFalse()
    expect(states.load()).toMatchObject({
      status: 'choose_project',
      ownerUserId: '7001',
      ownerChatId: '7001',
    })
    expect(telegram.messages.at(-1)?.text).toContain('единственный владелец')

    expect(await controller.handleUpdate(callback(2, 'cb-project', 'boot:project:default'))).toBeFalse()
    expect(existsSync(item.defaultProjectPath)).toBeTrue()
    expect(states.load()).toMatchObject({
      status: 'choose_profile',
      selectedProjectPath: item.defaultProjectPath,
    })

    expect(await controller.handleUpdate(callback(3, 'cb-profile', 'boot:profile:yolo'))).toBeTrue()
    expect(states.load()).toMatchObject({ status: 'complete', executionProfile: 'yolo' })
    const config = JSON.parse(await Bun.file(join(item.configDirectory, 'bridge.config.json')).text())
    expect(config.telegram.allowedUserIds).toEqual(['7001'])
    expect(config.projects[0].cwd).toBe(item.defaultProjectPath)
    const database = openDurableDatabase(join(item.stateDirectory, 'bridge.sqlite3'))
    try {
      expect(new SqlitePollCursorRepository(database).get('999001')?.nextUpdateId).toBe(4)
    } finally {
      database.close()
    }
    expect(telegram.answers).toEqual(['cb-project', 'cb-profile'])
    expect(telegram.messages.at(-1)?.text).toContain('Базовая настройка готова')
  })

  test('ignores every non-owner update after the nonce has been claimed', async () => {
    const item = fixture()
    const states = new BridgeBootstrapStateRepository(item.bootstrapPath)
    const telegram = new FakeTelegram()
    const controller = new BootstrapOnboardingController(states, telegram, {
      homeDirectory: item.home,
      finalize: () => undefined,
    })
    await controller.handleUpdate(ownerStart())
    const before = states.load()

    await controller.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'intruder',
        data: 'boot:project:default',
        from: { id: 8002, is_bot: false },
        message: { message_id: 22, chat: { id: 8002, type: 'private' } },
      },
    })

    expect(states.load()).toEqual(before)
    expect(existsSync(item.defaultProjectPath)).toBeFalse()
    expect(telegram.answers).not.toContain('intruder')
  })

  test('keeps finalizing state until the completion handoff is delivered', async () => {
    const item = fixture()
    mkdirSync(item.defaultProjectPath)
    const states = new BridgeBootstrapStateRepository(item.bootstrapPath)
    states.update((current) => ({
      ...current,
      status: 'finalizing',
      ownerUserId: '7001',
      ownerChatId: '7001',
      selectedProjectPath: item.defaultProjectPath,
      executionProfile: 'safe',
      nextUpdateId: 9,
    }))
    await Bun.write(join(item.configDirectory, 'bridge.config.json'), '{}\n')
    const failingApi: BootstrapTelegramApi = {
      sendMessage: async () => { throw new Error('temporary Telegram outage') },
      answerCallbackQuery: async () => true,
    }
    const failedResume = new BootstrapOnboardingController(states, failingApi)

    await expect(failedResume.resume()).rejects.toThrow('temporary Telegram outage')
    expect(states.load().status).toBe('finalizing')

    const telegram = new FakeTelegram()
    const recovered = new BootstrapOnboardingController(states, telegram)
    expect(await recovered.resume()).toBeTrue()
    expect(states.load().status).toBe('complete')
    expect(telegram.messages.at(-1)?.text).toContain('Базовая настройка готова')
  })

  test('accepts a home-relative custom path only after owner confirmation', async () => {
    const item = fixture()
    const states = new BridgeBootstrapStateRepository(item.bootstrapPath)
    const telegram = new FakeTelegram()
    const controller = new BootstrapOnboardingController(states, telegram, {
      homeDirectory: item.home,
      finalize: () => undefined,
    })
    await controller.handleUpdate(ownerStart())
    await controller.handleUpdate(callback(2, 'cb-custom', 'boot:project:custom'))
    await controller.handleUpdate({
      update_id: 3,
      message: {
        message_id: 33,
        text: '~/existing-later',
        from: { id: 7001, is_bot: false },
        chat: { id: 7001, type: 'private' },
      },
    })
    const custom = join(item.home, 'existing-later')
    expect(states.load()).toMatchObject({ status: 'confirm_create', pendingProjectPath: custom })

    await controller.handleUpdate(callback(4, 'cb-create', 'boot:create:yes'))
    expect(existsSync(custom)).toBeTrue()
    expect(states.load()).toMatchObject({ status: 'choose_profile', selectedProjectPath: custom })
  })
})
