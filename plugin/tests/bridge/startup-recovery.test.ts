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
      },
    })

    const sweep = await new StartupTurnRecovery(sessions, inbox, outbox, backend, {
      now: () => NOW + 1,
    }).run()

    expect(sweep).toEqual({ candidates: 1, completed: 1, failed: 0, interrupted: 0, unknown: 0 })
    expect(sessions.getTurn(active.turn.id)).toMatchObject({
      state: 'COMPLETED',
      finalResponse: { finalText: 'Recovered final' },
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

  test('quarantines non-completed turns and never starts replacement work', async () => {
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

    expect(sweep).toEqual({ candidates: 3, completed: 0, failed: 1, interrupted: 1, unknown: 1 })
    expect(sessions.getTurn(failed.turn.id)?.state).toBe('FAILED')
    expect(sessions.getTurn(interrupted.turn.id)?.state).toBe('INTERRUPTED')
    expect(sessions.getTurn(uncertain.turn.id)).toMatchObject({
      state: 'UNKNOWN',
      backendTurnId: 'turn-found-by-client-id',
    })
    expect([failed, interrupted, uncertain].map((item) => inbox.get(item.update.id)?.state)).toEqual([
      'FAILED',
      'FAILED',
      'FAILED',
    ])
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
})
