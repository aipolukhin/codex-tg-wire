import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  AgentModel,
  AgentTextTurnInput,
  AgentTurnLifecycle,
  CommandOperation,
  PersonalAlphaCommandName,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import {
  AgentLifecycleProtocolError,
  DurableSessionCoordinator,
  StaticProjectResolver,
  TurnQueuedBehindTurnError,
  TurnRecoveryRequiredError,
  UnknownProjectError,
} from '../../src/bridge/durable-session-coordinator.js'
import { PersonalAlphaCommands } from '../../src/bridge/personal-alpha-commands.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteAgentSettingsRepository } from '../../src/durable/settings-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'
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
  readonly interrupts: Array<{ threadId: string; turnId: string }> = []
  readonly steers: Array<{ operationKey: string; threadId: string; turnId: string; text: string }> = []
  failureStage: FailureStage | undefined
  nextThreadId = 'codex-thread-1'
  nextTurnId = 'codex-turn-1'
  beforeThreadWait: Promise<void> | undefined
  wait: Promise<void> | undefined
  models: AgentModel[] = [
    {
      id: 'gpt-default',
      model: 'gpt-default',
      displayName: 'GPT Default',
      isDefault: true,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    },
    {
      id: 'gpt-fast',
      model: 'gpt-fast',
      displayName: 'GPT Fast',
      isDefault: false,
      supportedEfforts: ['low', 'medium'],
      defaultEffort: 'low',
    },
  ]

  async listModels(): Promise<AgentModel[]> {
    return this.models
  }

  async runTextTurn(
    input: AgentTextTurnInput,
    lifecycle: AgentTurnLifecycle = {},
  ): Promise<TextTurnResult> {
    this.calls.push(input)
    if (this.failureStage === 'before_thread') throw new Error('thread/start unavailable')
    if (this.beforeThreadWait !== undefined) await this.beforeThreadWait

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

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId })
  }

  async steerTurn(input: {
    operationKey: string
    threadId: string
    turnId: string
    text: string
  }): Promise<void> {
    this.steers.push(input)
  }
}

let root: string
let database: Database
let nowMs: number
let inbox: SqliteInboxRepository
let outbox: SqliteOutboxRepository
let sessions: SqliteSessionRepository
let settings: SqliteAgentSettingsRepository
let backend: FakeAgentBackend
let coordinator: DurableSessionCoordinator
let commands: PersonalAlphaCommands

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-session-coordinator-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  nowMs = START
  inbox = new SqliteInboxRepository(database)
  outbox = new SqliteOutboxRepository(database)
  sessions = new SqliteSessionRepository(database)
  settings = new SqliteAgentSettingsRepository(database)
  backend = new FakeAgentBackend()
  coordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    new StaticProjectResolver([{ id: 'workspace', cwd: '/srv/workspace' }]),
    { now: () => nowMs, settingsProvider: settings },
  )
  commands = new PersonalAlphaCommands(sessions, backend, outbox, settings, {
    now: () => nowMs,
    projects: [
      { id: 'workspace', cwd: '/srv/workspace' },
      { id: 'other', cwd: '/srv/other' },
    ],
    defaultProjectId: 'workspace',
  })
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

function command(name: PersonalAlphaCommandName, args = ''): CommandOperation {
  return {
    operationKey: `telegram:primary:command:${name}`,
    botId: 'primary',
    inboxUpdateId: 0,
    updateId: 0,
    command: { chatId: '7001', projectId: 'workspace', name, args },
  }
}

function problemCommand(
  updateId: number,
  name: 'retry' | 'resolved' | 'archive',
  args: string,
): CommandOperation {
  const operation = command(name, args)
  operation.operationKey = `telegram:primary:${updateId}:turn:command:${name}`
  operation.updateId = updateId
  return operation
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
    expect(backend.calls[0]).toMatchObject({
      threadId: null,
      cwd: '/srv/workspace',
      settings: { sandbox: 'workspace-write' },
      executionPolicy: {
        writableRoots: ['/srv/workspace'],
        networkAccess: false,
      },
    })
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

  test('persists a second turn as QUEUED until the active turn completes', async () => {
    let release!: () => void
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstOperation = operation(611)
    const first = coordinator.runTextTurn(firstOperation)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (sessions.getTurnByOperationKey(firstOperation.operationKey)?.state === 'ACTIVE') break
      await Promise.resolve()
    }

    const queuedOperation = operation(612)
    await expect(coordinator.runTextTurn(queuedOperation)).rejects.toBeInstanceOf(
      TurnQueuedBehindTurnError,
    )
    expect(sessions.getTurnByOperationKey(queuedOperation.operationKey)?.state).toBe('QUEUED')
    expect(backend.calls).toHaveLength(1)

    release()
    await first
    backend.wait = undefined
    backend.nextTurnId = 'codex-turn-2'
    expect((await coordinator.runTextTurn(queuedOperation)).turnId).toBe('codex-turn-2')
    expect(backend.calls).toHaveLength(2)
  })

  test('serializes initial thread creation behind the first durable QUEUED turn', async () => {
    let releaseThreadStart!: () => void
    backend.beforeThreadWait = new Promise<void>((resolve) => {
      releaseThreadStart = resolve
    })
    const firstOperation = operation(613)
    const first = coordinator.runTextTurn(firstOperation)
    for (let attempt = 0; attempt < 20 && backend.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }

    const secondOperation = operation(614)
    await expect(coordinator.runTextTurn(secondOperation)).rejects.toBeInstanceOf(
      TurnQueuedBehindTurnError,
    )
    expect(sessions.getTurnByOperationKey(firstOperation.operationKey)?.state).toBe('QUEUED')
    expect(sessions.getTurnByOperationKey(secondOperation.operationKey)?.state).toBe('QUEUED')
    expect(backend.calls).toHaveLength(1)

    releaseThreadStart()
    await first
    backend.beforeThreadWait = undefined
    backend.nextTurnId = 'codex-turn-2'
    expect((await coordinator.runTextTurn(secondOperation)).turnId).toBe('codex-turn-2')
    expect(backend.calls).toHaveLength(2)
  })

  test('does not let a terminally failed inbox update poison the turn queue', async () => {
    const failedOperation = operation(615)
    const failedTurn = sessions.prepareTextOperation(failedOperation, 'codex', nowMs).turn
    const claimed = inbox.claimNext({
      workerId: 'inbox-a',
      nowMs,
      leaseDurationMs: 60_000,
    })
    expect(claimed?.id).toBe(failedOperation.inboxUpdateId)
    inbox.fail(failedOperation.inboxUpdateId, 'inbox-a', 'terminal failure', nowMs)
    expect(sessions.getTurn(failedTurn.id)?.state).toBe('QUEUED')

    backend.nextTurnId = 'codex-turn-after-failure'
    expect((await coordinator.runTextTurn(operation(616))).turnId).toBe(
      'codex-turn-after-failure',
    )
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

describe('PersonalAlphaCommands', () => {
  test('renders help/status and resets a completed thread', async () => {
    expect((await commands.handleCommand(command('start'))).text).toContain('Codex готов')
    expect((await commands.handleCommand(command('status'))).text).toContain('Thread ещё не создан')

    await coordinator.runTextTurn(operation(620))
    const status = (await commands.handleCommand(command('status'))).text
    expect(status).toContain('codex-thread-1 (ACTIVE)')
    expect(status).toContain('codex-turn-1 (COMPLETED)')

    expect((await commands.handleCommand(command('new'))).text).toContain('отвязан')
    backend.nextThreadId = 'codex-thread-2'
    backend.nextTurnId = 'codex-turn-2'
    await coordinator.runTextTurn(operation(621))
    expect(backend.calls[1]?.threadId).toBeNull()
    expect(sessions.getTurnByOperationKey('telegram:primary:621:turn')?.backendTurnId).toBe(
      'codex-turn-2',
    )
    expect(sessions.listThreads('primary', '7001', 'workspace')).toHaveLength(2)
  })

  test('/threads survives restart and /switch resumes a previous binding', async () => {
    await coordinator.runTextTurn(operation(625))
    expect((await commands.handleCommand(command('new'))).text).toContain('отвязан')
    backend.nextThreadId = 'codex-thread-2'
    backend.nextTurnId = 'codex-turn-2'
    await coordinator.runTextTurn(operation(626))

    const beforeRestart = (await commands.handleCommand(command('threads'))).text
    expect(beforeRestart).toContain('● codex-thread-2 · ACTIVE')
    expect(beforeRestart).toContain('○ codex-thread-1 · AVAILABLE')

    database.close()
    database = openDurableDatabase(join(root, 'bridge.sqlite3'))
    inbox = new SqliteInboxRepository(database)
    outbox = new SqliteOutboxRepository(database)
    sessions = new SqliteSessionRepository(database)
    settings = new SqliteAgentSettingsRepository(database)
    coordinator = new DurableSessionCoordinator(
      sessions,
      backend,
      new StaticProjectResolver([{ id: 'workspace', cwd: '/srv/workspace' }]),
      { now: () => nowMs, settingsProvider: settings },
    )
    commands = new PersonalAlphaCommands(sessions, backend, outbox, settings, {
      now: () => nowMs,
      projects: [
        { id: 'workspace', cwd: '/srv/workspace' },
        { id: 'other', cwd: '/srv/other' },
      ],
      defaultProjectId: 'workspace',
    })

    expect((await commands.handleCommand(command('threads'))).text).toContain('codex-thread-1')
    expect((await commands.handleCommand(command('switch', 'codex-thread-1'))).text).toContain(
      'заменён',
    )
    backend.nextTurnId = 'codex-turn-3'
    await coordinator.runTextTurn(operation(627))
    expect(backend.calls.at(-1)?.threadId).toBe('codex-thread-1')
    expect(sessions.getOverview('primary', '7001', 'workspace').binding?.threadId).toBe(
      'codex-thread-1',
    )
  })

  test('/archive and /resume preserve history and refuse active-thread mutation', async () => {
    await coordinator.runTextTurn(operation(628))
    await commands.handleCommand(command('new'))
    backend.nextThreadId = 'codex-thread-2'
    backend.nextTurnId = 'codex-turn-2'
    await coordinator.runTextTurn(operation(629))

    expect((await commands.handleCommand(command('archive', 'codex-thread-1'))).text).toContain(
      'архивирован',
    )
    expect((await commands.handleCommand(command('switch', 'codex-thread-1'))).text).toContain(
      '/resume',
    )
    expect((await commands.handleCommand(command('resume', 'codex-thread-1'))).text).toContain(
      'выбран',
    )

    let release!: () => void
    backend.nextTurnId = 'codex-turn-3'
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = coordinator.runTextTurn(operation(630))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (sessions.getTurnByOperationKey('telegram:primary:630:turn')?.state === 'ACTIVE') break
      await Promise.resolve()
    }
    expect((await commands.handleCommand(command('archive', 'codex-thread-1'))).text).toContain(
      'Нельзя',
    )
    expect((await commands.handleCommand(command('switch', 'codex-thread-2'))).text).toContain(
      'Нельзя',
    )
    release()
    await running
    backend.wait = undefined

    expect((await commands.handleCommand(command('archive', 'codex-thread-1'))).text).toContain(
      'отвязан',
    )
    expect(sessions.getOverview('primary', '7001', 'workspace').binding).toBeNull()
    expect((await commands.handleCommand(command('archive', 'codex-thread-1'))).text).toContain(
      'уже архивирован',
    )
  })

  test('/new refuses an uncertain turn instead of discarding its binding', async () => {
    backend.failureStage = 'after_thread'
    await expect(coordinator.runTextTurn(operation(622))).rejects.toThrow()
    const response = await commands.handleCommand(command('new'))
    expect(response.text).toContain('UNKNOWN')
    expect(response.text).toContain('Нельзя')
    expect(response.text).toContain('/new force')

    const forced = await commands.handleCommand(command('new', 'force'))
    expect(forced.text).toContain('закрыт вручную')
    expect(sessions.getTurnByOperationKey('telegram:primary:622:turn')?.state).toBe('FAILED')
    expect(sessions.getOverview('primary', '7001', 'workspace').binding).toBeNull()
  })

  test('/stop interrupts the active backend turn', async () => {
    let release!: () => void
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = coordinator.runTextTurn(operation(623))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const turn = sessions.getTurnByOperationKey('telegram:primary:623:turn')
      if (turn?.backendTurnId !== null && turn?.backendTurnId !== undefined) break
      await Promise.resolve()
    }

    expect((await commands.handleCommand(command('stop'))).text).toContain('Остановка')
    expect(backend.interrupts).toEqual([
      { threadId: 'codex-thread-1', turnId: 'codex-turn-1' },
    ])
    release()
    await running
  })

  test('/stop reports idle state without calling backend', async () => {
    expect((await commands.handleCommand(command('stop'))).text).toBe('Активного turn нет.')
    expect(backend.interrupts).toHaveLength(0)
  })

  test('/steer validates input and targets the active backend turn', async () => {
    expect((await commands.handleCommand(command('steer'))).text).toContain('Использование')
    expect((await commands.handleCommand(command('steer', 'clarify'))).text).toContain(
      'Активного turn',
    )

    let release!: () => void
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = coordinator.runTextTurn(operation(624))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const turn = sessions.getTurnByOperationKey('telegram:primary:624:turn')
      if (turn?.backendTurnId !== null && turn?.backendTurnId !== undefined) break
      await Promise.resolve()
    }

    const response = await commands.handleCommand(command('steer', 'сначала проверь тесты'))
    expect(response.text).toContain('Уточнение отправлено')
    expect(backend.steers).toEqual([{
      operationKey: 'telegram:primary:command:steer',
      threadId: 'codex-thread-1',
      turnId: 'codex-turn-1',
      text: 'сначала проверь тесты',
    }])
    release()
    await running
  })

  test('persists validated model, effort, sandbox and approval overrides for turns', async () => {
    expect((await commands.handleCommand(command('model'))).text).toContain('gpt-fast')
    expect((await commands.handleCommand(command('model', 'missing'))).text).toContain(
      'отсутствует',
    )
    expect((await commands.handleCommand(command('model', 'gpt-fast'))).text).toContain(
      'gpt-fast',
    )
    expect((await commands.handleCommand(command('effort', 'high'))).text).toContain(
      'не поддерживается',
    )
    expect((await commands.handleCommand(command('effort', 'low'))).text).toContain('low')
    expect((await commands.handleCommand(command('sandbox', 'danger-full-access'))).text).toContain(
      'запрещён',
    )
    expect((await commands.handleCommand(command('sandbox', 'read-only'))).text).toContain(
      'read-only',
    )
    expect((await commands.handleCommand(command('approval', 'never'))).text).toContain('never')

    await coordinator.runTextTurn(operation(631))
    expect(backend.calls[0]?.settings).toEqual({
      model: 'gpt-fast',
      effort: 'low',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    })
    const status = (await commands.handleCommand(command('status'))).text
    expect(status).toContain('Model: gpt-fast')
    expect(status).toContain('Sandbox: read-only')
    expect(status).toContain('Approval: never')
  })

  test('/cwd selects only configured projects and refuses switching an active turn', async () => {
    expect((await commands.handleCommand(command('cwd'))).text).toContain('● workspace')
    expect((await commands.handleCommand(command('cwd', '/tmp/unsafe'))).text).toContain(
      'не разрешён',
    )

    let release!: () => void
    backend.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = coordinator.runTextTurn(operation(632))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (sessions.getTurnByOperationKey('telegram:primary:632:turn')?.state === 'ACTIVE') break
      await Promise.resolve()
    }
    expect((await commands.handleCommand(command('cwd', 'workspace'))).text).toContain(
      'уже выбран',
    )
    expect((await commands.handleCommand(command('cwd', 'other'))).text).toContain('Нельзя')
    release()
    await running
    backend.wait = undefined

    expect((await commands.handleCommand(command('cwd', 'other'))).text).toContain(
      'Текущий проект: other',
    )
    expect(settings.getSelectedProject('primary', '7001')).toBe('other')
    expect(settings.getTurnSettings('primary', '7001', 'workspace')).toEqual({})
  })

  test('/failed lists safe metadata and retries a failed job idempotently', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111'
    outbox.enqueue({
      id: jobId,
      sourceKey: 'turn:failed:final',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'private request body' },
      createdAtMs: nowMs,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs, leaseDurationMs: 60_000 })
    outbox.failLease(jobId, 'sender-a', 'sensitive transport detail', nowMs)

    const listing = (await commands.handleCommand(command('failed'))).text
    expect(listing).toContain(jobId)
    expect(listing).toContain('send_text')
    expect(listing).not.toContain('private request body')
    expect(listing).not.toContain('sensitive transport detail')

    const retry = problemCommand(701, 'retry', jobId)
    expect((await commands.handleCommand(retry)).text).toContain('PENDING')
    expect(outbox.get(jobId)).toMatchObject({ state: 'PENDING', attemptCount: 0 })
    expect((await commands.handleCommand(retry)).text).toContain('уже применён')
  })

  test('/ambiguous requires remote proof or archive and refuses unsafe retry', async () => {
    const jobId = '22222222-2222-4222-8222-222222222222'
    outbox.enqueue({
      id: jobId,
      sourceKey: 'turn:ambiguous:final',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'maybe delivered' },
      createdAtMs: nowMs,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs, leaseDurationMs: 60_000 })
    outbox.markSendStarted(jobId, 'sender-a', nowMs + 1)
    outbox.failLease(jobId, 'sender-a', 'connection lost', nowMs + 2)

    expect((await commands.handleCommand(command('ambiguous'))).text).toContain(jobId)
    expect((await commands.handleCommand(problemCommand(702, 'retry', jobId))).text).toContain(
      'риск',
    )
    expect(outbox.get(jobId)?.state).toBe('AMBIGUOUS')
    expect((await commands.handleCommand(problemCommand(703, 'resolved', jobId))).text).toContain(
      'Использование',
    )
    expect((await commands.handleCommand(
      problemCommand(704, 'resolved', `${jobId} 991`),
    )).text).toContain('remote proof telegram:991')
    expect(outbox.get(jobId)).toMatchObject({ state: 'DELIVERED', remoteId: 'telegram:991' })
  })

  test('/archive closes a terminal delivery problem', async () => {
    const jobId = '33333333-3333-4333-8333-333333333333'
    outbox.enqueue({
      id: jobId,
      sourceKey: 'turn:archive:final',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'discard me' },
      createdAtMs: nowMs,
    })
    outbox.claimNext({ workerId: 'sender-a', nowMs, leaseDurationMs: 60_000 })
    outbox.failLease(jobId, 'sender-a', 'invalid payload', nowMs)

    expect((await commands.handleCommand(problemCommand(705, 'archive', jobId))).text).toContain(
      'архивирован',
    )
    expect(outbox.get(jobId)?.state).toBe('ARCHIVED')
  })
})
