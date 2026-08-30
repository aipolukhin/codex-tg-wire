import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { SqliteCodexArtifactRepository } from '../../src/durable/codex-artifact-repository.js'
import { SqliteControlInteractionRepository } from '../../src/durable/control-interaction-repository.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteTelegramMessageRouteRepository } from '../../src/durable/message-route-repository.js'

const NOW = 1_800_000_000_000

let root: string
let database: Database

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-m65-repos-'))
  database = openDurableDatabase(join(root, 'state.sqlite3'))
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function operation(updateId: number) {
  return {
    operationKey: `telegram:primary:${updateId}:turn`,
    inboxUpdateId: updateId,
    botId: 'primary',
    updateId,
    chatId: '7001',
    projectId: 'workspace',
    text: `message ${updateId}`,
  }
}

describe('M6.5 durable control repositories', () => {
  test('keeps turn diffs and reply routes restart-safe', () => {
    const artifacts = new SqliteCodexArtifactRepository(database)
    artifacts.recordTurnDiff({
      threadId: 'thread-1', turnId: 'turn-1', diff: 'diff --git a/a b/a', updatedAtMs: NOW,
    })
    artifacts.recordTurnDiff({
      threadId: 'thread-1', turnId: 'turn-old', diff: 'stale', updatedAtMs: NOW - 1,
    })
    expect(artifacts.getLatestTurnDiff('thread-1')).toMatchObject({
      turnId: 'turn-1', diff: expect.stringContaining('diff --git'),
    })

    const routes = new SqliteTelegramMessageRouteRepository(database)
    routes.register({
      sourceKey: 'turn:1:final', botId: 'primary', chatId: '7001',
      projectId: 'workspace', threadId: 'thread-1', createdAtMs: NOW,
    })
    routes.markDelivered('turn:1:final', 901, NOW + 1)
    expect(routes.getBySourceKey('turn:1:final')).toMatchObject({
      botId: 'primary', telegramMessageId: 901,
    })
    expect(routes.findByTelegramMessage('primary', '7001', 901)).toMatchObject({
      projectId: 'workspace', threadId: 'thread-1', telegramMessageId: 901,
    })
    expect(routes.findByTelegramMessage('other-bot', '7001', 901)).toBeNull()
  })

  test('makes busy actions idempotent by callback operation key', () => {
    const controls = new SqliteControlInteractionRepository(database)
    const prompt = controls.createBusy({
      operation: operation(2),
      blockingThreadId: 'thread-active',
      blockingTurnId: 'turn-active',
      nowMs: NOW,
    })
    expect(prompt.token).toMatch(/^[a-f0-9]{12}$/)
    expect(controls.beginBusyAction(
      prompt.token, '7001', 'queue', 'callback:3', NOW + 1,
    ).outcome).toBe('started')
    expect(controls.beginBusyAction(
      prompt.token, '7001', 'queue', 'callback:3', NOW + 2,
    ).outcome).toBe('resumed')
    controls.completeBusy(prompt.id, 'COMPLETED', {
      threadId: 'thread-active', turnId: 'turn-queued', finalText: 'done',
    }, NOW + 3)
    expect(controls.beginBusyAction(
      prompt.token, '7001', 'queue', 'callback:4', NOW + 4,
    ).outcome).toBe('closed')
  })

  test('persists confirm, revise and cancel transitions for guided plans', () => {
    const controls = new SqliteControlInteractionRepository(database)
    const created = controls.createPlan({
      operation: operation(10),
      result: { threadId: 'thread-plan', turnId: 'turn-plan', finalText: 'draft' },
      nowMs: NOW,
    })
    expect(controls.requestPlanRevision(created.token, '7001', NOW + 1)?.state)
      .toBe('REVISION_REQUESTED')
    expect(controls.beginPlanRevision(
      created.token, '7001', 'revision:11', NOW + 2,
    ).outcome).toBe('started')
    const revised = controls.finishPlanRevision(created.id, {
      threadId: 'thread-plan', turnId: 'turn-plan-2', finalText: 'revised',
    }, NOW + 3)
    expect(revised).toMatchObject({
      state: 'AWAITING_CONFIRMATION', revision: 1, planText: 'revised',
    })
    expect(controls.beginPlanExecution(
      created.token, '7001', 'confirm:12', NOW + 4,
    ).outcome).toBe('started')
    expect(controls.beginPlanExecution(
      created.token, '7001', 'confirm:12', NOW + 5,
    ).outcome).toBe('resumed')
    expect(controls.completePlan(created.id, {
      threadId: 'thread-plan', turnId: 'turn-execute', finalText: 'implemented',
    }, NOW + 6).state).toBe('COMPLETED')

    const cancelled = controls.createPlan({
      operation: operation(20),
      result: { threadId: 'thread-2', turnId: 'turn-2', finalText: 'draft 2' },
      nowMs: NOW,
    })
    expect(controls.cancelPlan(cancelled.token, '7001', NOW + 1)?.state).toBe('CANCELLED')
  })
})
