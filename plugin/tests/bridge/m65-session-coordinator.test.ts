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
import { M65SessionCoordinator } from '../../src/bridge/m65-session-coordinator.js'
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
    expect(result.finalText).toContain('Выполнение ещё не началось')
    expect(result.buttons?.flat().map((button) => button.text)).toEqual([
      '▶️ Выполнить', '✏️ Изменить', '❌ Отменить',
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

    const incoming = operation(201)
    const result = await coordinator.runTextTurn(incoming)
    expect(delegate.calls).toHaveLength(0)
    expect(result).toMatchObject({
      threadId: 'thread-busy',
      turnId: 'turn-busy',
      presentation: 'busy_choice',
    })
    expect(result.buttons?.flat().map((button) => button.text)).toContain('🕒 В очередь')
    expect(controls.getBusyBySource(incoming.operationKey)).toMatchObject({
      state: 'PENDING',
      blockingThreadId: 'thread-busy',
      blockingTurnId: 'turn-busy',
    })

    const replay = new M65SessionCoordinator(
      delegate, sessions, settings, new SqliteControlInteractionRepository(database),
      undefined, () => NOW + 2,
    )
    expect((await replay.runTextTurn(incoming)).presentation).toBe('busy_choice')
    expect(delegate.calls).toHaveLength(0)
  })
})
