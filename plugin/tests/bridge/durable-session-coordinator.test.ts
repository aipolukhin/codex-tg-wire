import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  AgentTextTurnInput,
  AgentTurnLifecycle,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import {
  AgentLifecycleProtocolError,
  DurableSessionCoordinator,
  StaticProjectResolver,
  TurnRecoveryRequiredError,
  UnknownProjectError,
} from '../../src/bridge/durable-session-coordinator.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteInboxRepository } from '../../src/durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'

const START = 1_800_000_000_000

type FailureStage = 'before_thread' | 'after_thread' | 'terminal_failed' | 'missing_started'

class FakeDefiniteTurnError extends Error {
  readonly agentTurnState = 'FAILED' as const

  constructor(readonly turnId: string) {
    super('definite backend failure with sensitive detail')
    this.name = 'FakeDefiniteTurnError'
  }
}

class FakeAgentBackend implements AgentBackend {
  readonly calls: AgentTextTurnInput[] = []
  failureStage: FailureStage | undefined
  nextThreadId = 'codex-thread-1'
  nextTurnId = 'codex-turn-1'
  wait: Promise<void> | undefined

  async runTextTurn(
    input: AgentTextTurnInput,
    lifecycle: AgentTurnLifecycle = {},
  ): Promise<TextTurnResult> {
    this.calls.push(input)
    if (this.failureStage === 'before_thread') throw new Error('thread/start unavailable')

    const threadId = input.threadId ?? this.nextThreadId
    await lifecycle.onThreadReady?.(threadId, input.threadId === null)
    if (this.failureStage === 'after_thread') throw new Error('lost turn/start response')

    if (this.failureStage !== 'missing_started') {
      await lifecycle.onTurnStarted?.(threadId, this.nextTurnId)
    }
    if (this.wait !== undefined) await this.wait
    if (this.failureStage === 'terminal_failed') {
      throw new FakeDefiniteTurnError(this.nextTurnId)
    }
    return {
      threadId,
      turnId: this.nextTurnId,
      finalText: `Codex: ${input.text}`,
    }
  }

  async interruptTurn(): Promise<void> {}
}

let root: string
let database: Database
let nowMs: number
let inbox: SqliteInboxRepository
let sessions: SqliteSessionRepository
let backend: FakeAgentBackend
let coordinator: DurableSessionCoordinator

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-session-coordinator-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  nowMs = START
  inbox = new SqliteInboxRepository(database)
  sessions = new SqliteSessionRepository(database)
  backend = new FakeAgentBackend()
  coordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    new StaticProjectResolver([{ id: 'workspace', cwd: '/srv/workspace' }]),
    { now: () => nowMs },
  )
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function operation(remoteUpdateId: number): TextTurnOperation {
  const accepted = inbox.ingest({
    botId: 'primary',
    updateId: remoteUpdateId,
    chatId: '7001',
    payload: { update_id: remoteUpdateId },
    receivedAtMs: nowMs,
  })
  return {
    operationKey: `telegram:primary:${remoteUpdateId}:turn`,
    inboxUpdateId: accepted.update.id,
    botId: 'primary',
    updateId: remoteUpdateId,
    chatId: '7001',
    projectId: 'workspace',
    text: `message ${remoteUpdateId}`,
  }
}

describe('DurableSessionCoordinator', () => {
  test('persists a new session, activates provisional binding and completes the turn', async () => {
    const op = operation(601)
    expect(await coordinator.runTextTurn(op)).toEqual({
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      finalText: 'Codex: message 601',
    })

    const turn = sessions.getTurnByOperationKey(op.operationKey)
    expect(turn?.state).toBe('COMPLETED')
    expect(turn?.sourceUpdateId).toBe(op.inboxUpdateId)
    expect(turn?.backendTurnId).toBe('codex-turn-1')
    expect(turn?.finalResponse).toEqual({
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      finalText: 'Codex: message 601',
    })
    const binding = sessions.getBinding(turn!.sessionId)
    expect(binding?.threadId).toBe('codex-thread-1')
    expect(binding?.state).toBe('ACTIVE')
    expect(backend.calls[0]).toMatchObject({ threadId: null, cwd: '/srv/workspace' })
  })

  test('returns the cached terminal result when an inbox update is replayed', async () => {
    const op = operation(602)
    const first = await coordinator.runTextTurn(op)
    nowMs += 10_000
    const replay = await coordinator.runTextTurn(op)

    expect(replay).toEqual(first)
    expect(backend.calls).toHaveLength(1)
  })

  test('continues the active thread for the next operation in the same session', async () => {
    const first = operation(603)
    await coordinator.runTextTurn(first)
    backend.nextTurnId = 'codex-turn-2'
    const second = operation(604)
    await coordinator.runTextTurn(second)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1]?.threadId).toBe('codex-thread-1')
    expect(sessions.getTurnByOperationKey(second.operationKey)?.backendTurnId).toBe('codex-turn-2')
  })

  test('leaves a pre-dispatch failure QUEUED so a safe retry can proceed', async () => {
    const op = operation(605)
    backend.failureStage = 'before_thread'
    await expect(coordinator.runTextTurn(op)).rejects.toThrow('thread/start unavailable')
    expect(sessions.getTurnByOperationKey(op.operationKey)?.state).toBe('QUEUED')

    backend.failureStage = undefined
    expect((await coordinator.runTextTurn(op)).turnId).toBe('codex-turn-1')
    expect(backend.calls).toHaveLength(2)
  })

  test('marks an uncertain post-dispatch crash UNKNOWN and refuses automatic replay', async () => {
    const op = operation(606)
    backend.failureStage = 'after_thread'
    await expect(coordinator.runTextTurn(op)).rejects.toThrow('lost turn/start response')

    const turn = sessions.getTurnByOperationKey(op.operationKey)!
    expect(turn.state).toBe('UNKNOWN')
    expect(turn.backendTurnId).toBeNull()
    expect(turn.finalResponse).toEqual({ error: 'Error' })
    expect(sessions.getBinding(turn.sessionId)?.state).toBe('PROVISIONAL')

    backend.failureStage = undefined
    await expect(coordinator.runTextTurn(op)).rejects.toBeInstanceOf(TurnRecoveryRequiredError)
    expect(backend.calls).toHaveLength(1)
  })

  test('records a definite backend terminal failure without leaking its message', async () => {
    const op = operation(607)
    backend.failureStage = 'terminal_failed'
    await expect(coordinator.runTextTurn(op)).rejects.toBeInstanceOf(FakeDefiniteTurnError)

    const turn = sessions.getTurnByOperationKey(op.operationKey)!
    expect(turn.state).toBe('FAILED')
    expect(turn.backendTurnId).toBe('codex-turn-1')
    expect(turn.finalResponse).toEqual({ error: 'FakeDefiniteTurnError' })
    expect(JSON.stringify(turn.finalResponse)).not.toContain('sensitive detail')
    expect(sessions.getBinding(turn.sessionId)?.state).toBe('ACTIVE')
  })

  test('quarantines a backend that skips required lifecycle evidence', async () => {
    const op = operation(610)
    backend.failureStage = 'missing_started'
    await expect(coordinator.runTextTurn(op)).rejects.toBeInstanceOf(AgentLifecycleProtocolError)

    const turn = sessions.getTurnByOperationKey(op.operationKey)!
    expect(turn.state).toBe('UNKNOWN')
    expect(sessions.getBinding(turn.sessionId)?.state).toBe('PROVISIONAL')
  })

  test('coalesces concurrent delivery of the same logical operation', async () => {
    const op = operation(608)
    let release!: () => void
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = coordinator.runTextTurn(op)
    const duplicate = coordinator.runTextTurn(op)
    expect(duplicate).toBe(first)
    release()

    expect(await duplicate).toEqual(await first)
    expect(backend.calls).toHaveLength(1)
  })

  test('rejects unknown project ids before creating durable session state', async () => {
    const op = operation(609)
    op.projectId = 'missing'
    await expect(coordinator.runTextTurn(op)).rejects.toBeInstanceOf(UnknownProjectError)
    expect(backend.calls).toHaveLength(0)
    expect(sessions.getTurnByOperationKey(op.operationKey)).toBeNull()
  })
})
