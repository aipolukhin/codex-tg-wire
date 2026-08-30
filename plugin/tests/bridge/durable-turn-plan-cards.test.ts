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
let cards: DurableTurnPlanCards
let operation: TextTurnOperation

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-turn-plan-cards-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  sessions = new SqliteSessionRepository(database)
  outbox = new SqliteOutboxRepository(database)
  nowMs = NOW
  interrupts = []
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
        { step: 'Inspect <state>', status: 'in_progress' },
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
          inline_keyboard: [[{ text: '⏹ Cancel task' }]],
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
    expect(JSON.stringify(terminal?.payload)).toContain('## Task complete')
    expect(JSON.stringify(terminal?.payload)).toContain('"inline_keyboard":[]')
    expect(JSON.stringify(terminal?.payload).match(/- \[x\]/g)).toHaveLength(3)
  })

  test('requires a second click and interrupts the exact durable turn once', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: 'First', status: 'in_progress' },
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
    expect(first.toast).toBe('Confirmation required')
    expect(interrupts).toEqual([])
    expect(JSON.stringify(outbox.get(first.deliveryJobId!)?.payload)).toContain('Confirm cancel')

    nowMs += 1
    const confirmed = await cards.handleAction({
      operationKey: 'callback:2', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(confirmed.toast).toBe('Cancellation requested')
    expect(interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])

    await cards.handleAction({
      operationKey: 'callback:3', token: row.token, chatId: '7001', action: 'confirm',
    })
    expect(interrupts).toHaveLength(1)

    cards.onTerminal(operation, 'INTERRUPTED', 'CodexTurnInterruptedError')
    const persisted = database.query<{
      phase: string
      cancel_state: string
      interrupt_sent_at_ms: number | null
    }, []>('SELECT phase, cancel_state, interrupt_sent_at_ms FROM telegram_turn_plan_cards').get()
    expect(persisted).toEqual({
      phase: 'INTERRUPTED', cancel_state: 'CLOSED', interrupt_sent_at_ms: nowMs,
    })
  })

  test('does not create a progress card for a one-step plan', () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 1,
      steps: [{ step: 'Tiny task', status: 'in_progress' }],
      atMs: nowMs,
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM telegram_turn_plan_cards',
    ).get()?.count).toBe(0)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_jobs',
    ).get()?.count).toBe(0)
  })

  test('resumes a persisted cancellation request after restart', async () => {
    cards.onProgress(operation, {
      kind: 'plan', threadId: 'thread-1', turnId: 'turn-1', completed: 0, total: 2,
      steps: [
        { step: 'First', status: 'in_progress' },
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
