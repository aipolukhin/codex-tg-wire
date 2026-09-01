import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  AgentModel,
  AgentTextTurnInput,
  AgentTurnInspection,
  AgentTurnInspectionInput,
  AgentTurnLifecycle,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import { StartupTurnRecovery } from '../../src/bridge/startup-recovery.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'

const NOW = 1_800_000_000_000

class InspectingBackend implements AgentBackend {
  readonly inspections: AgentTurnInspectionInput[] = []
  readonly results = new Map<string, AgentTurnInspection>()

  async inspectTurn(input: AgentTurnInspectionInput): Promise<AgentTurnInspection> {
    this.inspections.push(input)
    const result = this.results.get(input.threadId)
    if (result === undefined) throw new Error('stored thread unavailable')
    return result
  }

  async listModels(): Promise<AgentModel[]> { return [] }
  async runTextTurn(
    _input: AgentTextTurnInput,
    _lifecycle?: AgentTurnLifecycle,
  ): Promise<TextTurnResult> {
    throw new Error('startup recovery must not start a turn')
  }
  async interruptTurn(): Promise<void> {}
  async steerTurn(): Promise<void> {}
}

let root: string
let database: Database
let inbox: SqliteInboxRepository
let outbox: SqliteOutboxRepository
let sessions: SqliteSessionRepository
let backend: InspectingBackend

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-startup-recovery-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  inbox = new SqliteInboxRepository(database)
  outbox = new SqliteOutboxRepository(database)
  sessions = new SqliteSessionRepository(database)
  backend = new InspectingBackend()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function activeTurn(input: {
  updateId: number
  chatId: string
  threadId: string
  turnId?: string
}) {
  const update = inbox.ingest({
    botId: 'primary',
    updateId: input.updateId,
    chatId: input.chatId,
    routingClass: 'MESSAGE',
    payload: { update_id: input.updateId },
    receivedAtMs: NOW,
  }).update
  inbox.claimNext({ workerId: `worker-${input.updateId}`, nowMs: NOW, leaseDurationMs: 60_000 })
  const operationKey = `telegram:primary:${input.updateId}:turn`
  const prepared = sessions.prepareTextOperation({
    operationKey,
    inboxUpdateId: update.id,
    botId: 'primary',
    updateId: input.updateId,
    chatId: input.chatId,
    projectId: 'workspace',
    text: 'do work',
  }, 'codex', NOW)
  sessions.markDispatching(prepared.turn.id, 'codex', input.threadId, true, NOW)
  if (input.turnId !== undefined) {
    sessions.markBackendTurnStarted(
      prepared.turn.id,
      input.turnId,
      'codex',
      input.threadId,
      NOW,
    )
  }
  return { update, turn: prepared.turn, operationKey }
}

describe('startup turn recovery', () => {
  test('replays a proven completed result through the original inbox operation', async () => {
    const active = activeTurn({
      updateId: 10,
      chatId: '7001',
      threadId: 'thread-complete',
      turnId: 'turn-complete',
    })
    backend.results.set('thread-complete', {
      state: 'COMPLETED',
      result: {
        threadId: 'thread-complete',
        turnId: 'turn-complete',
        finalText: 'Recovered final',
        artifacts: [{
          kind: 'generated_image',
          path: '/tmp/codex/generated_images/thread-complete/recovered.png',
        }],
      },
    })

    const sweep = await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 1,
    }).run()

    expect(sweep).toEqual({
      candidates: 1,
      completed: 1,
      failed: 0,
      interrupted: 0,
      unknown: 0,
      resumed: 0,
      unblocked: 0,
    })
    expect(sessions.getTurn(active.turn.id)).toMatchObject({
      state: 'COMPLETED',
      finalResponse: {
        finalText: 'Recovered final',
        artifacts: [{
          kind: 'generated_image',
          path: '/tmp/codex/generated_images/thread-complete/recovered.png',
        }],
      },
    })
    expect(inbox.get(active.update.id)).toMatchObject({
      state: 'RETRY_WAIT',
      routingClass: 'QUEUED_MESSAGE',
      leaseOwner: null,
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM delivery_jobs',
    ).get()?.count).toBe(0)
  })

  test('auto-resumes proven terminal turns and quarantines only uncertain work', async () => {
    const failed = activeTurn({
      updateId: 20,
      chatId: '7001',
      threadId: 'thread-failed',
      turnId: 'turn-failed',
    })
    const interrupted = activeTurn({
      updateId: 21,
      chatId: '7002',
      threadId: 'thread-interrupted',
      turnId: 'turn-interrupted',
    })
    const uncertain = activeTurn({
      updateId: 22,
      chatId: '7003',
      threadId: 'thread-unknown',
    })
    backend.results.set('thread-failed', { state: 'FAILED', turnId: 'turn-failed' })
    backend.results.set('thread-interrupted', {
      state: 'INTERRUPTED',
      turnId: 'turn-interrupted',
    })
    backend.results.set('thread-unknown', {
      state: 'UNKNOWN',
      turnId: 'turn-found-by-client-id',
      reason: 'turn_in_progress',
    })

    const sweep = await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 2,
    }).run()

    expect(sweep).toEqual({
      candidates: 3,
      completed: 0,
      failed: 1,
      interrupted: 1,
      unknown: 1,
      resumed: 2,
      unblocked: 0,
    })
    expect(sessions.getTurn(failed.turn.id)).toMatchObject({
      state: 'QUEUED',
      backendOperationKey: `${failed.operationKey}:auto-resume:1`,
      backendTurnId: null,
    })
    expect(sessions.getTurn(interrupted.turn.id)).toMatchObject({
      state: 'QUEUED',
      backendOperationKey: `${interrupted.operationKey}:auto-resume:1`,
      backendTurnId: null,
    })
    expect(sessions.getTurn(uncertain.turn.id)).toMatchObject({
      state: 'UNKNOWN',
      backendTurnId: 'turn-found-by-client-id',
    })
    expect([failed, interrupted, uncertain].map((item) => inbox.get(item.update.id)?.state)).toEqual([
      'RETRY_WAIT',
      'RETRY_WAIT',
      'FAILED',
    ])
    expect(sessions.getLatestRecoveryAttempt(failed.turn.id)).toMatchObject({
      attemptNumber: 1,
      previousBackendOperationKey: failed.operationKey,
      previousBackendTurnId: 'turn-failed',
      inspectedState: 'FAILED',
    })
    expect(backend.inspections).toContainEqual({
      threadId: 'thread-unknown',
      turnId: null,
      operationKey: uncertain.operationKey,
    })
    const notices = database.query<{ payload_json: string }, []>(
      'SELECT payload_json FROM delivery_jobs ORDER BY created_at_ms, id',
    ).all().map((row) => JSON.parse(row.payload_json) as { text: string })
    expect(notices).toHaveLength(3)
    expect(notices.some((notice) => notice.text.includes('/new force'))).toBe(true)
    expect(notices.filter((notice) => notice.text.includes('Писать «продолжай» не нужно')))
      .toHaveLength(2)
  })

  test('turn inspection failures become safe UNKNOWN state without error detail', async () => {
    const active = activeTurn({
      updateId: 30,
      chatId: '7001',
      threadId: 'thread-unreadable',
      turnId: 'turn-unreadable',
    })

    await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 3,
    }).run()

    expect(sessions.getTurn(active.turn.id)).toMatchObject({
      state: 'UNKNOWN',
      finalResponse: { error: 'CodexTurnRecoveryUnknown:inspection_failed' },
    })
    expect(JSON.stringify(sessions.getTurn(active.turn.id))).not.toContain('stored thread unavailable')
  })

  test('rechecks UNKNOWN turns and releases messages that were blocked behind them', async () => {
    const uncertain = activeTurn({
      updateId: 40,
      chatId: '7001',
      threadId: 'thread-recheck',
      turnId: 'turn-recheck',
    })
    sessions.markTerminal(uncertain.turn.id, 'UNKNOWN', 'AppServerClosedError', NOW + 1)
    inbox.fail(uncertain.update.id, 'worker-40', 'TurnRecoveryRequiredError', NOW + 1)

    const blockedUpdate = inbox.ingest({
      botId: 'primary',
      updateId: 41,
      chatId: '7001',
      routingClass: 'MESSAGE',
      payload: { update_id: 41 },
      receivedAtMs: NOW + 2,
    }).update
    inbox.claimNext({ workerId: 'worker-41', nowMs: NOW + 2, leaseDurationMs: 60_000 })
    const blocked = sessions.prepareTextOperation({
      operationKey: 'telegram:primary:41:turn',
      inboxUpdateId: blockedUpdate.id,
      botId: 'primary',
      updateId: 41,
      chatId: '7001',
      projectId: 'workspace',
      text: 'is the bridge alive?',
    }, 'codex', NOW + 2)
    expect(blocked.blockingTurn?.state).toBe('UNKNOWN')
    inbox.fail(blockedUpdate.id, 'worker-41', 'TurnRecoveryRequiredError', NOW + 3)

    backend.results.set('thread-recheck', {
      state: 'INTERRUPTED',
      turnId: 'turn-recheck',
    })
    const sweep = await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 4,
    }).run()

    expect(sweep).toEqual({
      candidates: 1,
      completed: 0,
      failed: 0,
      interrupted: 1,
      unknown: 0,
      resumed: 1,
      unblocked: 1,
    })
    expect(sessions.getTurn(uncertain.turn.id)).toMatchObject({
      state: 'QUEUED',
      backendOperationKey: `${uncertain.operationKey}:auto-resume:1`,
    })
    expect(sessions.getTurn(blocked.turn.id)?.state).toBe('QUEUED')
    expect(inbox.get(blockedUpdate.id)).toMatchObject({
      state: 'RETRY_WAIT',
      routingClass: 'QUEUED_MESSAGE',
      attemptCount: 0,
    })
  })

  test('records every interrupted backend turn across repeated restarts', async () => {
    const active = activeTurn({
      updateId: 50,
      chatId: '7001',
      threadId: 'thread-repeated',
      turnId: 'turn-original',
    })
    backend.results.set('thread-repeated', {
      state: 'INTERRUPTED',
      turnId: 'turn-original',
    })

    await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 1,
    }).run()
    sessions.markDispatching(active.turn.id, 'codex', 'thread-repeated', false, NOW + 2)
    sessions.markBackendTurnStarted(
      active.turn.id,
      'turn-resume-1',
      'codex',
      'thread-repeated',
      NOW + 3,
    )
    backend.results.set('thread-repeated', {
      state: 'INTERRUPTED',
      turnId: 'turn-resume-1',
    })

    const second = await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 4,
    }).run()

    expect(second).toMatchObject({ interrupted: 1, resumed: 1 })
    expect(backend.inspections.at(-1)).toMatchObject({
      turnId: 'turn-resume-1',
      operationKey: `${active.operationKey}:auto-resume:1`,
    })
    expect(sessions.getTurn(active.turn.id)).toMatchObject({
      state: 'QUEUED',
      backendOperationKey: `${active.operationKey}:auto-resume:2`,
    })
    expect(sessions.getLatestRecoveryAttempt(active.turn.id)).toMatchObject({
      attemptNumber: 2,
      previousBackendOperationKey: `${active.operationKey}:auto-resume:1`,
      previousBackendTurnId: 'turn-resume-1',
    })
    expect(database.query<{ count: number }, [string]>(
      'SELECT count(*) AS count FROM turn_recovery_attempts WHERE turn_id = ?',
    ).get(active.turn.id)?.count).toBe(2)
  })

  test('promotes a proven provisional thread before auto-resume', async () => {
    const active = activeTurn({
      updateId: 60,
      chatId: '7001',
      threadId: 'thread-provisional',
    })
    expect(sessions.getBinding(active.turn.sessionId)?.state).toBe('PROVISIONAL')
    backend.results.set('thread-provisional', {
      state: 'INTERRUPTED',
      turnId: 'turn-found-by-client-id',
    })

    await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 1,
    }).run()

    expect(sessions.getBinding(active.turn.sessionId)).toMatchObject({
      state: 'ACTIVE',
      threadId: 'thread-provisional',
    })
    expect(sessions.getTurn(active.turn.id)).toMatchObject({
      state: 'QUEUED',
      backendOperationKey: `${active.operationKey}:auto-resume:1`,
    })
  })
})
