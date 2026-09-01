import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { DurableTurnPlanCards } from '../../src/bridge/durable-turn-plan-cards.js'
import type { TextTurnOperation } from '../../src/bridge/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

let root: string
let database: Database
let sessions: SqliteSessionRepository
let outbox: SqliteOutboxRepository
let nowMs: number
let interrupts: Array<{ threadId: string; turnId: string }>
let workspaceCancellationRequests: string[]
let workspaceCancellationOutcome: 'pending' | 'discarded'
let cards: DurableTurnPlanCards
let operation: TextTurnOperation

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-turn-plan-cards-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  sessions = new SqliteSessionRepository(database)
  outbox = new SqliteOutboxRepository(database)
  nowMs = NOW
  interrupts = []
  workspaceCancellationRequests = []
  workspaceCancellationOutcome = 'pending'
  cards = new DurableTurnPlanCards(
    database,
    outbox,
    sessions,
    {
      interruptTurn: async (threadId, turnId) => {
        interrupts.push({ threadId, turnId })
      },
    },
    () => nowMs,
    {
      requestCancellation: (operationKey) => {
        workspaceCancellationRequests.push(operationKey)
        return 'requested'
      },
      cancellationOutcome: () => workspaceCancellationOutcome,
    },
  )
  const update = new SqliteInboxRepository(database).ingest({
    botId: 'primary', updateId: 701, chatId: '7001', routingClass: 'MESSAGE',
    payload: {}, receivedAtMs: nowMs,
  }).update
  operation = {
    operationKey: 'telegram:primary:701:turn',
    inboxUpdateId: update.id,
    botId: 'primary',
    updateId: 701,
    chatId: '7001',
    projectId: 'workspace',
    text: 'large task',
  }
  const prepared = sessions.prepareTextOperation(operation, 'codex', nowMs)
  sessions.markDispatching(prepared.turn.id, 'codex', 'thread-1', true, nowMs)
  sessions.markBackendTurnStarted(prepared.turn.id, 'turn-1', 'codex', 'thread-1', nowMs)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('DurableTurnPlanCards', () => {
  test('creates one Rich task list and checks steps through an ordered edit chain', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 3,
      steps: [
        { step: '[telegram-task-progress] Inspect <state>', status: 'in_progress' },
        { step: 'Implement durable card', status: 'pending' },
        { step: 'Verify and deploy', status: 'pending' },
      ],
      atMs: nowMs,
    })

    const rootJob = outbox.getBySourceKey(`${operation.operationKey}:plan-progress`)
    expect(rootJob?.kind).toBe('send_text')
    expect(rootJob?.payload).toMatchObject({
      chatId: '7001',
      format: 'rich',
      options: {
        reply_markup: {
          inline_keyboard: [[{ text: '⏹ Отменить задачу' }]],
        },
      },
    })
    expect((rootJob?.payload as { text: string }).text).toContain('- [ ] ⏳ Inspect \\<state\\>')

    nowMs += 1
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 1, total: 3,
      steps: [
        { step: 'Inspect <state>', status: 'completed' },
        { step: 'Implement durable card', status: 'in_progress' },
        { step: 'Verify and deploy', status: 'pending' },
      ],
      atMs: nowMs,
    })

    const edit = outbox.getBySourceKey(`${operation.operationKey}:plan-progress:edit:1`)
    expect(edit).toMatchObject({
      kind: 'edit',
      dependsOnSourceKey: `${operation.operationKey}:plan-progress`,
    })
    expect(JSON.stringify(edit?.payload)).toContain('- [x] Inspect')

    cards.onCompleted(operation, {
      threadId: 'thread-1', turnId: 'turn-1', finalText: 'done',
    })
    const terminal = outbox.getBySourceKey(`${operation.operationKey}:plan-progress:edit:2`)
    expect(JSON.stringify(terminal?.payload)).toContain('## Задача выполнена')
    expect(JSON.stringify(terminal?.payload)).toContain('"inline_keyboard":[]')
    expect(JSON.stringify(terminal?.payload).match(/- \[x\]/g)).toHaveLength(3)
  })

  test('requires a second click and interrupts the exact durable turn once', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: '[telegram-task-progress] First', status: 'in_progress' },
        { step: 'Second', status: 'pending' },
      ],
      atMs: nowMs,
    })
    const row = database.query<{ token: string }, []>(
      'SELECT token FROM telegram_turn_plan_cards',
    ).get()!

    const first = await cards.handleAction({
      operationKey: 'callback:1', token: row.token, chatId: '7001', action: 'cancel',
    })
    expect(first.toast).toBe('Нужно подтверждение')
    expect(interrupts).toEqual([])
    expect(JSON.stringify(outbox.get(first.deliveryJobId!)?.payload)).toContain('Отменить и очистить')

    nowMs += 1
    const confirmed = await cards.handleAction({
      operationKey: 'callback:2', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(confirmed.toast).toBe('Отмена запрошена')
    expect(workspaceCancellationRequests).toEqual([operation.operationKey])
    expect(interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])

    await cards.handleAction({
      operationKey: 'callback:3', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(interrupts).toHaveLength(1)

    workspaceCancellationOutcome = 'discarded'
    cards.onTerminal(operation, 'INTERRUPTED', 'CodexTurnInterruptedError')
    const persisted = database.query<{
      phase: string
      cancel_state: string
      interrupt_sent_at_ms: number | null
    }, []>('SELECT phase, cancel_state, interrupt_sent_at_ms FROM telegram_turn_plan_cards').get()
    expect(persisted).toEqual({
      phase: 'INTERRUPTED', cancel_state: 'CLOSED', interrupt_sent_at_ms: nowMs,
    })
    expect(JSON.stringify(outbox.getBySourceKey(
      `${operation.operationKey}:plan-progress:edit:3`,
    )?.payload)).toContain('Незавершённые локальные изменения задачи удалены')
  })

  test('edits the same card with live activity but no duplicate elapsed timer', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: '[telegram-task-progress] Перенести медиатеку', status: 'in_progress' },
        { step: 'Проверить результат', status: 'pending' },
      ],
      atMs: nowMs,
    })
    cards.onProgress(operation, {
      kind: 'commentary', threadId: 'thread-1', turnId: 'turn-1',
      text: 'rsync переносит 80 ГБ; операция ожидаемо долгая, процесс не завис.',
      atMs: nowMs + 1,
    })
    cards.onProgress(operation, {
      kind: 'activity', threadId: 'thread-1', turnId: 'turn-1',
      activity: 'command', atMs: nowMs + 2,
    })

    const activityEdit = outbox.getBySourceKey(
      `${operation.operationKey}:plan-progress:edit:2`,
    )
    expect(JSON.stringify(activityEdit?.payload)).toContain('Выполняю команду')
    expect(JSON.stringify(activityEdit?.payload)).toContain('rsync переносит 80 ГБ')
    expect(JSON.stringify(activityEdit?.payload)).not.toMatch(/\d+ (?:сек|мин|ч)/)

    expect(outbox.getBySourceKey(`${operation.operationKey}:plan-progress:edit:3`)).toBeNull()
  })

  test('retargets cancellation to the replacement turn after transparent retry', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: '[telegram-task-progress] First', status: 'completed' },
        { step: 'Second', status: 'in_progress' },
      ],
      atMs: nowMs,
    })

    nowMs += 1
    cards.onTurnStarted(operation, 'thread-1', 'turn-2')
    expect(database.query<{ turn_id: string }, []>(
      'SELECT turn_id FROM telegram_turn_plan_cards',
    ).get()?.turn_id).toBe('turn-2')

    const row = database.query<{ token: string }, []>(
      'SELECT token FROM telegram_turn_plan_cards',
    ).get()!
    await cards.handleAction({
      operationKey: 'callback:retry-cancel', token: row.token, chatId: '7001', action: 'cancel',
    })
    await cards.handleAction({
      operationKey: 'callback:retry-confirm', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-2' }])
  })

  test('reapplies an in-flight cancellation when a recovery turn replaces its target', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: '[telegram-task-progress] First', status: 'in_progress' },
        { step: 'Second', status: 'pending' },
      ],
      atMs: nowMs,
    })
    const row = database.query<{ token: string }, []>(
      'SELECT token FROM telegram_turn_plan_cards',
    ).get()!
    await cards.handleAction({
      operationKey: 'callback:cancel-old', token: row.token, chatId: '7001', action: 'cancel',
    })
    await cards.handleAction({
      operationKey: 'callback:confirm-old', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])

    cards.onTurnStarted(operation, 'thread-1', 'turn-2')
    await Promise.resolve()
    await Promise.resolve()
    expect(interrupts).toEqual([
      { threadId: 'thread-1', turnId: 'turn-1' },
      { threadId: 'thread-1', turnId: 'turn-2' },
    ])
  })

  test('does not create a progress card for a one-step plan', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 1,
      steps: [{ step: '[telegram-task-progress] Tiny task', status: 'in_progress' }],
      atMs: nowMs,
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_turn_plan_cards',
    ).get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_jobs',
    ).get()?.count).toBe(0)
  })

  test('keeps an unmarked read-only plan out of Telegram', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: 'Проверить реализацию /cwd', status: 'in_progress' },
        { step: 'Объяснить фактическое поведение', status: 'pending' },
      ],
      atMs: nowMs,
    })
    cards.onProgress(operation, {
      kind: 'activity', threadId: 'thread-1', turnId: 'turn-1',
      activity: 'command', atMs: nowMs + 1,
    })

    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_turn_plan_cards',
    ).get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_jobs',
    ).get()?.count).toBe(0)
  })

  test('reveals an old unmarked execution plan only after file mutation evidence', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: 'Изменить код', status: 'in_progress' },
        { step: 'Проверить тесты', status: 'pending' },
      ],
      atMs: nowMs,
    })
    cards.onProgress(operation, {
      kind: 'activity', threadId: 'thread-1', turnId: 'turn-1',
      activity: 'file_change', atMs: nowMs + 1,
    })

    const rootJob = outbox.getBySourceKey(`${operation.operationKey}:plan-progress`)
    expect(rootJob?.kind).toBe('send_text')
    expect(JSON.stringify(rootJob?.payload)).toContain('Изменить код')
    expect(JSON.stringify(rootJob?.payload)).not.toContain('[telegram-task-progress]')
  })

  test('resumes a persisted cancellation request after restart', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: '[telegram-task-progress] First', status: 'in_progress' },
        { step: 'Second', status: 'pending' },
      ],
      atMs: nowMs,
    })
    database.run(
      `UPDATE telegram_turn_plan_cards
       SET cancel_state = 'REQUESTED', cancel_operation_key = 'callback:crashed'`,
    )

    expect(await cards.recoverStartup()).toBe(1)
    expect(interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])
    expect(database.query<{ interrupt_sent_at_ms: number | null }, []>(
      'SELECT interrupt_sent_at_ms FROM telegram_turn_plan_cards',
    ).get()?.interrupt_sent_at_ms).toBe(nowMs)
  })
})
