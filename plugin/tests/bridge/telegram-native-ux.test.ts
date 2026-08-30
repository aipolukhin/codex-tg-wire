import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentRateLimit,
  AgentUxStatusSnapshot,
  TextTurnOperation,
} from '../../src/bridge/contracts.js'
import { TelegramNativeTurnUx } from '../../src/bridge/telegram-native-ux.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import type {
  TelegramMessageOptions,
  TelegramTextApi,
} from '../../src/telegram/durable-text-gateway.js'

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0)

class FakeTelegram implements TelegramTextApi {
  readonly sent: Array<{ chatId: string; text: string; options: TelegramMessageOptions }> = []
  readonly edits: Array<{ chatId: string; messageId: number; text: string }> = []
  readonly pins: Array<{ chatId: string; messageId: number }> = []
  readonly deletes: Array<{ chatId: string; messageId: number }> = []
  readonly actions: Array<{ chatId: string; action: 'typing' }> = []
  nextEditError: unknown = null
  failNextPin = false

  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramMessageOptions,
  ): Promise<{ message_id: number }> {
    this.sent.push({ chatId, text, options })
    return { message_id: 100 + this.sent.length }
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<true> {
    if (this.nextEditError !== null) {
      const error = this.nextEditError
      this.nextEditError = null
      throw error
    }
    this.edits.push({ chatId, messageId, text })
    return true
  }

  async pinChatMessage(chatId: string, messageId: number): Promise<true> {
    if (this.failNextPin) {
      this.failNextPin = false
      throw new Error('pin failed')
    }
    this.pins.push({ chatId, messageId })
    return true
  }

  async deleteMessage(chatId: string, messageId: number): Promise<true> {
    this.deletes.push({ chatId, messageId })
    return true
  }

  async sendChatAction(chatId: string, action: 'typing'): Promise<true> {
    this.actions.push({ chatId, action })
    return true
  }
}

const operation: TextTurnOperation = {
  operationKey: 'telegram:primary:77:turn',
  inboxUpdateId: 1,
  botId: 'primary',
  updateId: 77,
  chatId: '7001',
  projectId: 'workspace',
  text: 'secret user payload',
}

let root: string
let database: Database

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-native-ux-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Telegram native UX', () => {
  test('keeps one silent pinned status and recreates a stale anchor', async () => {
    const telegram = new FakeTelegram()
    let snapshot: AgentUxStatusSnapshot | null = {
      phase: 'COMPLETED',
      activity: 'working',
      planCompleted: 0,
      planTotal: 0,
      totalTokens: 16_500,
      inputTokens: 16_000,
      cachedInputTokens: 15_000,
      outputTokens: 500,
      threadTotalTokens: 63_000,
      contextWindow: 258_000,
      updatedAtMs: NOW,
    }
    const limits: AgentRateLimit[] = [{
      id: 'codex',
      name: 'Codex',
      primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_788_088_400 },
      secondary: { usedPercent: 21, windowDurationMins: 10_080, resetsAt: null },
      planType: 'plus',
      reachedType: null,
    }]
    let quotaReads = 0
    const ux = new TelegramNativeTurnUx(
      database,
      telegram,
      {
        readRateLimits: async () => { quotaReads += 1; return limits },
        readRuntimeDefaults: async () => ({ model: 'gpt-5.6-sol', effort: 'xhigh' }),
      },
      { getStatus: () => snapshot },
      'primary',
      { pinnedStatus: true, now: () => NOW },
    )

    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.sent[0]?.options).toEqual({
      disable_notification: true,
    })
    expect(telegram.sent[0]?.text).toBe('5.6-sol-xh 5h:92% w:79% ctx:6%')
    expect(telegram.sent[0]?.text).not.toContain(operation.text)
    expect(telegram.pins).toEqual([{ chatId: '7001', messageId: 101 }])

    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.edits).toHaveLength(0)
    expect(quotaReads).toBe(1)

    telegram.failNextPin = true
    await ux.refreshChat('7001', 'workspace', true)
    expect(database.query<{ pinned: number }, []>(
      'SELECT pinned FROM telegram_status_pins',
    ).get()).toEqual({ pinned: 0 })
    await ux.refreshChat('7001', 'workspace')
    expect(database.query<{ pinned: number }, []>(
      'SELECT pinned FROM telegram_status_pins',
    ).get()).toEqual({ pinned: 1 })

    snapshot = { ...snapshot, phase: 'ACTIVE', inputTokens: 20_000 }
    await ux.refreshChat('7001', 'workspace')
    expect(telegram.edits).toEqual([
      expect.objectContaining({ chatId: '7001', messageId: 101 }),
    ])

    telegram.nextEditError = {
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    }
    snapshot = { ...snapshot, phase: 'FAILED', inputTokens: 25_000 }
    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(2)
    expect(telegram.pins.at(-1)).toEqual({ chatId: '7001', messageId: 102 })
    expect(telegram.deletes).toEqual([{ chatId: '7001', messageId: 101 }])
    expect(database.query<{ message_id: number; pinned: number }, []>(
      'SELECT message_id, pinned FROM telegram_status_pins',
    ).get()).toEqual({ message_id: 102, pinned: 1 })
    ux.close()
  })

  test('does not recreate the status anchor after rate limits or transient edit failures', async () => {
    const telegram = new FakeTelegram()
    let inputTokens = 10
    const ux = new TelegramNativeTurnUx(
      database,
      telegram,
      {},
      {
        getStatus: () => ({
          phase: 'ACTIVE',
          activity: 'working',
          planCompleted: 0,
          planTotal: 0,
          totalTokens: inputTokens,
          inputTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          threadTotalTokens: inputTokens,
          contextWindow: 100,
          updatedAtMs: NOW,
        }),
      },
      'primary',
      { pinnedStatus: true, now: () => NOW },
    )

    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(1)

    inputTokens = 20
    telegram.nextEditError = {
      error_code: 429,
      description: 'Too Many Requests: retry after 60',
      parameters: { retry_after: 60 },
    }
    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.deletes).toHaveLength(0)

    inputTokens = 30
    telegram.nextEditError = new Error('temporary network failure')
    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.deletes).toHaveLength(0)
    ux.close()
  })

  test('omits an unavailable 5h window and refreshes the pin from the runtime heartbeat', async () => {
    const telegram = new FakeTelegram()
    let now = NOW
    let weeklyUsedPercent = 10
    let quotaReads = 0
    const ux = new TelegramNativeTurnUx(
      database,
      telegram,
      {
        readRateLimits: async () => {
          quotaReads += 1
          return [
            {
              id: 'codex_bengalfox',
              name: 'GPT-5.3-Codex-Spark',
              isCurrent: false,
              primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
              planType: 'plus',
              reachedType: null,
            },
            {
              id: 'codex',
              name: 'Codex',
              isCurrent: true,
              primary: {
                usedPercent: weeklyUsedPercent,
                windowDurationMins: 10_080,
                resetsAt: null,
              },
              secondary: null,
              planType: 'plus',
              reachedType: null,
            },
          ]
        },
        readRuntimeDefaults: async () => ({ model: 'gpt-5.6-sol', effort: 'xhigh' }),
      },
      {
        getStatus: () => ({
          phase: 'ACTIVE',
          activity: 'working',
          planCompleted: 0,
          planTotal: 0,
          totalTokens: 90,
          inputTokens: 90,
          cachedInputTokens: 0,
          outputTokens: 0,
          threadTotalTokens: 90,
          contextWindow: 100,
          updatedAtMs: now,
        }),
      },
      'primary',
      { pinnedStatus: true, quotaRefreshMs: 100, now: () => now },
    )

    await ux.refreshChat('7001', 'workspace')
    expect(telegram.sent[0]?.text).toBe('5.6-sol-xh w:90% ctx:90%')
    expect(telegram.sent[0]?.text).not.toContain('5h:')

    weeklyUsedPercent = 20
    now += 100
    expect(ux.runHeartbeat()).toBe(1)
    await ux.refreshChat('7001', 'workspace')
    expect(quotaReads).toBe(2)
    expect(telegram.edits.at(-1)?.text).toBe('5.6-sol-xh w:80% ctx:90%')
    expect(telegram.pins).toHaveLength(2)
    ux.close()
  })

  test('shows compact turn elapsed time and clears it at completion', async () => {
    const telegram = new FakeTelegram()
    let now = NOW
    const ux = new TelegramNativeTurnUx(
      database,
      telegram,
      {},
      { getStatus: () => null },
      'primary',
      {
        pinnedStatus: true,
        elapsedRefreshMs: 10,
        now: () => now,
      },
    )

    ux.onPreparing(operation, {})
    await ux.refreshChat(operation.chatId, operation.projectId)
    expect(telegram.sent[0]?.text).toBe('0″ · default ctx:—')

    now += 92_000
    await Bun.sleep(15)
    await ux.refreshChat(operation.chatId, operation.projectId)
    expect(telegram.edits.at(-1)?.text).toBe('1′32″ · default ctx:—')

    ux.onCompleted(operation, { threadId: 'thread-1', turnId: 'turn-1', finalText: 'done' })
    await ux.refreshChat(operation.chatId, operation.projectId)
    expect(telegram.edits.at(-1)?.text).toBe('default ctx:—')
    const stoppedAt = telegram.edits.length
    now += 10_000
    await Bun.sleep(15)
    expect(telegram.edits).toHaveLength(stoppedAt)
    ux.close()
  })

  test('pulses native typing while a turn is active and stops at completion', async () => {
    const telegram = new FakeTelegram()
    const ux = new TelegramNativeTurnUx(
      database,
      telegram,
      {},
      { getStatus: () => null },
      'primary',
      { typingIndicator: true, typingRefreshMs: 10 },
    )

    ux.onPreparing(operation, {})
    await Bun.sleep(25)
    expect(telegram.actions.length).toBeGreaterThanOrEqual(2)
    ux.onCompleted(operation, { threadId: 'thread-1', turnId: 'turn-1', finalText: 'done' })
    const stoppedAt = telegram.actions.length
    await Bun.sleep(25)
    expect(telegram.actions).toHaveLength(stoppedAt)
    ux.close()
  })
})
