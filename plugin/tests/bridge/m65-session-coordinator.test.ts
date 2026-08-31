import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import {
  approvesDiscussion,
  M65SessionCoordinator,
  startsDiscussion,
} from '../../src/bridge/m65-session-coordinator.js'
import { SqliteControlInteractionRepository } from '../../src/durable/control-interaction-repository.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteAgentSettingsRepository } from '../../src/durable/settings-repository.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import { SqliteInboxRepository } from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

class FakeCoordinator implements SessionCoordinator {
  readonly calls: TextTurnOperation[] = []
  next: TextTurnResult = {
    threadId: 'thread-plan',
    turnId: 'turn-plan',
    finalText: '1. Проверить код\n2. Внести изменения\n3. Запустить тесты',
  }

  async runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    this.calls.push(operation)
    return this.next
  }
}

function operation(updateId = 100): TextTurnOperation {
  return {
    operationKey: `telegram:primary:${updateId}:turn`,
    inboxUpdateId: updateId,
    botId: 'primary',
    updateId,
    chatId: '7001',
    projectId: 'workspace',
    text: 'сделай новую фичу',
  }
}

let root: string
let database: Database
let sessions: SqliteSessionRepository
let settings: SqliteAgentSettingsRepository
let controls: SqliteControlInteractionRepository
let delegate: FakeCoordinator

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-m65-coordinator-'))
  database = openDurableDatabase(join(root, 'state.sqlite3'))
  sessions = new SqliteSessionRepository(database)
  settings = new SqliteAgentSettingsRepository(database)
  controls = new SqliteControlInteractionRepository(database)
  delegate = new FakeCoordinator()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('M6.5 session control plane', () => {
  test('creates a plan-only turn and replays its approval card after restart', async () => {
    settings.updateProjectSettings(
      'primary', '7001', 'workspace', { guidedPlanEnabled: true }, NOW,
    )
    const coordinator = new M65SessionCoordinator(
      delegate, sessions, settings, controls, undefined, () => NOW,
    )

    const result = await coordinator.runTextTurn(operation())
    expect(delegate.calls).toHaveLength(1)
    expect(delegate.calls[0]?.operationKey).toEndWith(':guided-plan:draft')
    expect(delegate.calls[0]?.text).toContain('PLANNING ONLY')
    expect(delegate.calls[0]?.trustedSettingsOverride).toEqual({
      sandbox: 'read-only', approvalPolicy: 'never',
    })
    expect(result.presentation).toBe('guided_plan')
    expect(result.finalText).toContain('Изменения не выполнялись')
    expect(result.buttons?.flat().map((button) => button.text)).toEqual([
      '🚀 Реализовать', '🗑 Закрыть обсуждение',
    ])
    const persisted = controls.getPlanBySource(operation().operationKey)
    expect(persisted).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      threadId: 'thread-plan',
      planningTurnId: 'turn-plan',
      planText: expect.stringContaining('Запустить тесты'),
    })

    const afterRestart = new M65SessionCoordinator(
      delegate,
      new SqliteSessionRepository(database),
      new SqliteAgentSettingsRepository(database),
      new SqliteControlInteractionRepository(database),
      undefined,
      () => NOW + 1,
    )
    expect((await afterRestart.runTextTurn(operation())).finalText).toBe(result.finalText)
    expect(delegate.calls).toHaveLength(1)
  })

  test('recognizes discussion cues without turning explicit tasks into confirmation rituals', () => {
    expect(startsDiscussion('Твои предложения? Как фиксим?')).toBe(true)
    expect(startsDiscussion('Давай сначала обсудим архитектуру')).toBe(true)
    expect(startsDiscussion('Реализуй этот вариант')).toBe(false)
    expect(startsDiscussion('Брат, реализуй продуктовую идею')).toBe(false)
    expect(startsDiscussion('Мне нужно, чтобы прогресс был живым')).toBe(false)
    expect(startsDiscussion('Почини картинки')).toBe(false)
    expect(approvesDiscussion('Да')).toBe(true)
    expect(approvesDiscussion('реализуй')).toBe(true)
    expect(approvesDiscussion('Да, но сначала обсудим детали')).toBe(false)
  })

  test('keeps requirements read-only during a durable discussion and executes only after approval', async () => {
    const coordinator = new M65SessionCoordinator(
      delegate, sessions, settings, controls, undefined, () => NOW,
    )
    const concept = {
      ...operation(110),
      text: 'Твои предложения? Как фиксим переход между обсуждением и реализацией?',
    }
    delegate.next = {
      threadId: 'thread-discussion', turnId: 'turn-concept',
      finalText: 'Предлагаю липкий discussion state и явную отмашку.',
    }
    const first = await coordinator.runTextTurn(concept)
    expect(first.presentation).toBe('guided_plan')
    expect(delegate.calls.at(-1)?.trustedSettingsOverride).toEqual({
      sandbox: 'read-only', approvalPolicy: 'never',
    })
    sessions.attachExternalThread(
      'primary', '7001', 'workspace', 'codex', 'thread-discussion', NOW + 1,
    )

    const afterRestart = new M65SessionCoordinator(
      delegate,
      new SqliteSessionRepository(database),
      new SqliteAgentSettingsRepository(database),
      new SqliteControlInteractionRepository(database),
      undefined,
      () => NOW + 2,
    )
    delegate.next = {
      threadId: 'thread-discussion', turnId: 'turn-requirement',
      finalText: 'Добавляем живой статус операции в ту же карточку.',
    }
    const requirement = {
      ...operation(111),
      text: 'Ещё мне нужно, чтобы карточка показывала долгий rsync.',
    }
    const discussed = await afterRestart.runTextTurn(requirement)
    expect(discussed.presentation).toBe('guided_plan')
    expect(delegate.calls.at(-1)).toMatchObject({
      preferredThreadId: 'thread-discussion',
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    expect(controls.getPlanBySource(concept.operationKey)).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      revision: 1,
      planText: expect.stringContaining('живой статус'),
    })

    delegate.next = {
      threadId: 'thread-discussion', turnId: 'turn-execution', finalText: 'Готово.',
    }
    const approval = { ...operation(112), text: 'Реализуй' }
    const executed = await afterRestart.runTextTurn(approval)
    expect(executed.finalText).toBe('Готово.')
    expect(delegate.calls.at(-1)?.text).toContain('APPROVED RECOMMENDATION')
    expect(delegate.calls.at(-1)?.trustedSettingsOverride).toBeUndefined()
    expect(controls.getPlanBySource(concept.operationKey)?.state).toBe('COMPLETED')

    const replay = await afterRestart.runTextTurn(approval)
    expect(replay.finalText).toBe('Готово.')
    expect(delegate.calls.filter((call) => call.text.includes('APPROVED RECOMMENDATION')))
      .toHaveLength(1)
  })

  test('persists a busy choice without dispatching the second prompt', async () => {
    const source = new SqliteInboxRepository(database).ingest({
      botId: 'primary', updateId: 200, chatId: '7001', routingClass: 'MESSAGE',
      payload: {}, receivedAtMs: NOW,
    }).update
    const blockingOperation = { ...operation(200), inboxUpdateId: source.id }
    const blocking = sessions.prepareTextOperation(blockingOperation, 'codex', NOW)
    sessions.markDispatching(blocking.turn.id, 'codex', 'thread-busy', true, NOW)
    sessions.markBackendTurnStarted(
      blocking.turn.id, 'turn-busy', 'codex', 'thread-busy', NOW,
    )
    const coordinator = new M65SessionCoordinator(
      delegate, sessions, settings, controls, undefined, () => NOW + 1,
    )

    const incoming = {
      ...operation(201),
      attachments: [{
        kind: 'image' as const,
        path: '/srv/workspace/mockup.jpg',
        fileName: 'mockup.jpg',
        mimeType: 'image/jpeg',
        size: 42,
        sha256: 'a'.repeat(64),
      }],
    }
    const result = await coordinator.runTextTurn(incoming)
    expect(delegate.calls).toHaveLength(0)
    expect(result).toMatchObject({
      threadId: 'thread-busy',
      turnId: 'turn-busy',
      presentation: 'busy_choice',
    })
    expect(result.buttons?.flat().map((button) => button.text)).toContain('🕒 В очередь')
    expect(result.buttons?.flat().map((button) => button.text)).toContain('↪️ Steer сейчас')
    expect(controls.getBusyBySource(incoming.operationKey)).toMatchObject({
      state: 'PENDING',
      blockingThreadId: 'thread-busy',
      blockingTurnId: 'turn-busy',
      input: { attachments: [{ kind: 'image', path: '/srv/workspace/mockup.jpg' }] },
    })

    const replay = new M65SessionCoordinator(
      delegate, sessions, settings, new SqliteControlInteractionRepository(database),
      undefined, () => NOW + 2,
    )
    expect((await replay.runTextTurn(incoming)).presentation).toBe('busy_choice')
    expect(delegate.calls).toHaveLength(0)
  })
})
