import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  InteractionHandler,
  SessionCoordinator,
  TelegramGateway,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import { M65InteractionHandler } from '../../src/bridge/m65-interaction-handler.js'
import { PersonalAlphaCommands } from '../../src/bridge/personal-alpha-commands.js'
import { SqliteControlInteractionRepository } from '../../src/durable/control-interaction-repository.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteAgentSettingsRepository } from '../../src/durable/settings-repository.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import { SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

class FakeBackend implements AgentBackend {
  interrupts: Array<[string, string]> = []
  async listModels() { return [] }
  async runTextTurn(): Promise<TextTurnResult> { throw new Error('not used') }
  async interruptTurn(threadId: string, turnId: string) { this.interrupts.push([threadId, turnId]) }
  async steerTurn() {}
}

class FakeCoordinator implements SessionCoordinator {
  calls: TextTurnOperation[] = []
  async runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    this.calls.push(operation)
    return { threadId: operation.preferredThreadId ?? 'thread-new', turnId: 'turn-done', finalText: 'done' }
  }
}

const telegram: TelegramGateway = {
  extractText: () => null,
  buildFinalTextDeliveries: (input) => [{
    sourceKey: input.sourceKey,
    kind: 'send_text',
    payload: { chatId: input.message.chatId, text: input.result.finalText },
    createdAtMs: input.nowMs,
  }],
  prepareDelivery: async () => ({}),
  executeDelivery: async () => ({ remoteId: 'telegram:1' }),
}

function sourceOperation(updateId: number): TextTurnOperation {
  return {
    operationKey: `telegram:primary:${updateId}:turn`, inboxUpdateId: updateId,
    botId: 'primary', updateId, chatId: '7001', projectId: 'workspace', text: 'ship it',
  }
}

let root: string
let database: Database
let controls: SqliteControlInteractionRepository
let sessions: SqliteSessionRepository
let settings: SqliteAgentSettingsRepository
let outbox: SqliteOutboxRepository
let backend: FakeBackend
let coordinator: FakeCoordinator
let handler: M65InteractionHandler

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-m65-handler-'))
  database = openDurableDatabase(join(root, 'state.sqlite3'))
  controls = new SqliteControlInteractionRepository(database)
  sessions = new SqliteSessionRepository(database)
  settings = new SqliteAgentSettingsRepository(database)
  outbox = new SqliteOutboxRepository(database)
  backend = new FakeBackend()
  coordinator = new FakeCoordinator()
  const commands = new PersonalAlphaCommands(sessions, backend, outbox, settings, {
    projects: [{ id: 'workspace', cwd: '/srv/workspace' }],
    defaultProjectId: 'workspace',
    now: () => NOW,
  })
  const legacy: InteractionHandler = {
    handleInteraction: async () => ({ deliveryJobId: null }),
  }
  handler = new M65InteractionHandler(
    legacy, controls, sessions, settings, backend, coordinator, commands,
    outbox, telegram, 'workspace', () => NOW,
  )
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('M6.5 feature callbacks', () => {
  test('turns an onboarding CTA into one durable card edit and callback acknowledgement', async () => {
    const result = await handler.handleInteraction({
      operationKey: 'telegram:primary:1:turn:interaction', botId: 'primary',
      inboxUpdateId: 1, updateId: 1,
      response: {
        kind: 'feature_action', feature: 'onboarding', chatId: '7001', token: 'onboarding',
        action: 'begin', callbackQueryId: 'cb-onboarding', callbackMessageId: 89,
      },
    })

    expect(result.deliveryJobId).not.toBeNull()
    expect(outbox.getBySourceKey('telegram:primary:1:turn:interaction:onboarding-edit')).toMatchObject({
      kind: 'edit', payload: { chatId: '7001', messageId: 89 },
    })
    expect(outbox.getBySourceKey('telegram:primary:1:turn:interaction:callback-ack')).toMatchObject({
      kind: 'reaction',
    })
  })

  test('executes a persisted busy prompt exactly through the selected thread', async () => {
    const prompt = controls.createBusy({
      operation: sourceOperation(1), blockingThreadId: 'thread-active',
      blockingTurnId: 'turn-active', nowMs: NOW,
    })
    const result = await handler.handleInteraction({
      operationKey: 'telegram:primary:2:turn:interaction', botId: 'primary',
      inboxUpdateId: 2, updateId: 2,
      response: {
        kind: 'feature_action', feature: 'busy', chatId: '7001', token: prompt.token,
        action: 'queue', callbackQueryId: 'cb-2', callbackMessageId: 90,
      },
    })
    expect(result.deliveryJobId).not.toBeNull()
    expect(coordinator.calls).toHaveLength(1)
    expect(coordinator.calls[0]).toMatchObject({
      preferredThreadId: 'thread-active', operationKey: expect.stringContaining('busy-selected'),
    })
    expect(controls.getBusyByToken(prompt.token)).toMatchObject({
      state: 'COMPLETED', response: { threadId: 'thread-active', finalText: 'done' },
    })
  })

  test('executes an approved durable plan and closes it with the final result', async () => {
    const plan = controls.createPlan({
      operation: sourceOperation(10),
      result: { threadId: 'thread-plan', turnId: 'turn-plan', finalText: '1. implement' },
      nowMs: NOW,
    })
    const result = await handler.handleInteraction({
      operationKey: 'telegram:primary:11:turn:interaction', botId: 'primary',
      inboxUpdateId: 11, updateId: 11,
      response: {
        kind: 'feature_action', feature: 'plan', chatId: '7001', token: plan.token,
        action: 'go', callbackQueryId: 'cb-11', callbackMessageId: 91,
      },
    })
    expect(result.deliveryJobId).not.toBeNull()
    expect(coordinator.calls[0]).toMatchObject({
      preferredThreadId: 'thread-plan',
      text: expect.stringContaining('APPROVED PLAN'),
    })
    expect(coordinator.calls[0]?.trustedSettingsOverride).toBeUndefined()
    expect(controls.getPlanByToken(plan.token)).toMatchObject({
      state: 'COMPLETED', result: { threadId: 'thread-plan', finalText: 'done' },
    })
  })

  test('revises a plan in a forced read-only turn before asking again', async () => {
    const plan = controls.createPlan({
      operation: sourceOperation(20),
      result: { threadId: 'thread-plan', turnId: 'turn-plan', finalText: '1. implement' },
      nowMs: NOW,
    })
    controls.requestPlanRevision(plan.token, '7001', NOW)

    const result = await handler.handleInteraction({
      operationKey: 'telegram:primary:21:turn:interaction', botId: 'primary',
      inboxUpdateId: 21, updateId: 21,
      response: {
        kind: 'guided_plan_revision', chatId: '7001', token: plan.token,
        text: 'сначала добавь тест',
      },
    })

    expect(result.deliveryJobId).not.toBeNull()
    expect(coordinator.calls[0]).toMatchObject({
      preferredThreadId: 'thread-plan',
      text: expect.stringContaining('USER REVISION'),
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    expect(controls.getPlanByToken(plan.token)).toMatchObject({
      state: 'AWAITING_CONFIRMATION', revision: 1, planText: 'done',
    })
  })
})
