import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  FinalTextDelivery,
  IncomingTextMessage,
  SessionCoordinator,
  TelegramGateway,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import { InboxProcessingWorker } from '../../src/bridge/inbox-processing-worker.js'
import { TurnQueuedBehindTurnError } from '../../src/bridge/durable-session-coordinator.js'
import { OutboxDeliveryWorker } from '../../src/bridge/outbox-delivery-worker.js'
import { exponentialRetryPolicy } from '../../src/bridge/retry-policy.js'
import type {
  DeliveryJob,
  DeliveryJobInput,
  InboxUpdate,
  OutboxRepository,
} from '../../src/durable/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'

const START = 1_800_000_000_000

class FakeCoordinator implements SessionCoordinator {
  readonly calls: TextTurnOperation[] = []
  readonly started = new Map<string, TextTurnResult>()
  failure: Error | undefined
  gate: Promise<void> | undefined

  async runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    this.calls.push(operation)
    await this.gate
    if (this.failure !== undefined) throw this.failure
    const existing = this.started.get(operation.operationKey)
    if (existing !== undefined) return existing
    const result = {
      threadId: `thread-${this.started.size + 1}`,
      turnId: `turn-${this.started.size + 1}`,
      finalText: `Codex: ${operation.text}`,
    }
    this.started.set(operation.operationKey, result)
    return result
  }
}

interface PreparedDelivery {
  jobId: string
  payload: unknown
}

class FakeTelegramGateway implements TelegramGateway<PreparedDelivery> {
  readonly prepared: DeliveryJob[] = []
  readonly executed: PreparedDelivery[] = []
  prepareFailure: Error | undefined
  executeFailure: Error | undefined
  remoteId = 'telegram:message:101'
  onExecute: (() => void) | undefined
  executeGate: Promise<void> | undefined

  extractText(update: InboxUpdate): IncomingTextMessage | null {
    const payload = update.payload as {
      message?: { chat?: { id?: number }; text?: string }
      project_id?: string
    }
    const chatId = payload.message?.chat?.id
    const text = payload.message?.text
    if (chatId === undefined || text === undefined || text.trim().length === 0) return null
    return { chatId: String(chatId), projectId: payload.project_id ?? 'default', text }
  }

  buildFinalTextDelivery(input: FinalTextDelivery): DeliveryJobInput {
    return {
      id: `reply-${input.update.id}`,
      sourceKey: input.sourceKey,
      kind: 'send_text',
      payload: { chatId: input.message.chatId, text: input.result.finalText },
      createdAtMs: input.nowMs,
    }
  }

  async prepareDelivery(job: DeliveryJob): Promise<PreparedDelivery> {
    this.prepared.push(job)
    if (this.prepareFailure !== undefined) throw this.prepareFailure
    return { jobId: job.id, payload: job.payload }
  }

  async executeDelivery(prepared: PreparedDelivery): Promise<{ remoteId: string }> {
    this.executed.push(prepared)
    this.onExecute?.()
    await this.executeGate
    if (this.executeFailure !== undefined) throw this.executeFailure
    return { remoteId: this.remoteId }
  }
}

function textUpdate(updateId: number): {
  botId: string
  updateId: number
  chatId: string
  payload: unknown
  receivedAtMs: number
} {
  return {
    botId: 'primary-bot',
    updateId,
    chatId: '7001',
    payload: {
      update_id: updateId,
      project_id: 'workspace',
      message: { chat: { id: 7001 }, text: 'проверь тесты' },
    },
    receivedAtMs: START,
  }
}

function throwOnceAfterEnqueue(repository: OutboxRepository): OutboxRepository {
  let armed = true
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'enqueue') {
        return (input: DeliveryJobInput) => {
          const result = target.enqueue(input)
          if (armed) {
            armed = false
            throw new Error('simulated crash after durable enqueue')
          }
          return result
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

let root: string
let database: Database
let nowMs: number
let inbox: SqliteInboxRepository
let outbox: SqliteOutboxRepository
let coordinator: FakeCoordinator
let telegram: FakeTelegramGateway

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-bridge-workers-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  nowMs = START
  inbox = new SqliteInboxRepository(database)
  outbox = new SqliteOutboxRepository(database)
  coordinator = new FakeCoordinator()
  telegram = new FakeTelegramGateway()
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('durable text vertical slice', () => {
  test('moves Telegram text through coordinator and outbox to proven delivery', async () => {
    const accepted = inbox.ingest(textUpdate(501))
    const inbound = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
      workerId: 'inbox-a',
      now: () => nowMs,
    })

    expect(await inbound.runOnce()).toEqual({
      outcome: 'enqueued',
      updateId: accepted.update.id,
      deliveryJobId: `reply-${accepted.update.id}`,
    })
    expect(coordinator.calls).toEqual([
      {
        operationKey: 'telegram:primary-bot:501:turn',
        inboxUpdateId: accepted.update.id,
        botId: 'primary-bot',
        updateId: 501,
        chatId: '7001',
        projectId: 'workspace',
        text: 'проверь тесты',
      },
    ])
    expect(inbox.get(accepted.update.id)?.state).toBe('PROCESSED')
    expect(outbox.get(`reply-${accepted.update.id}`)?.state).toBe('PENDING')

    telegram.onExecute = () => {
      const duringCall = outbox.get(`reply-${accepted.update.id}`)
      expect(duringCall?.state).toBe('LEASED')
      expect(duringCall?.sendStartedAtMs).toBe(START)
    }
    const outbound = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      now: () => nowMs,
    })
    expect(await outbound.runOnce()).toEqual({
      outcome: 'delivered',
      jobId: `reply-${accepted.update.id}`,
      remoteId: 'telegram:message:101',
    })
    expect(outbox.get(`reply-${accepted.update.id}`)?.state).toBe('DELIVERED')
  })

  test('replay after crash reuses the logical turn and deduplicates the final delivery', async () => {
    const accepted = inbox.ingest(textUpdate(502))
    const faultingOutbox = throwOnceAfterEnqueue(outbox)
    const worker = new InboxProcessingWorker(inbox, faultingOutbox, coordinator, telegram, {
      workerId: 'inbox-a',
      now: () => nowMs,
      retryPolicy: exponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 10 }),
    })

    expect(await worker.runOnce()).toEqual({
      outcome: 'retry_wait',
      updateId: accepted.update.id,
      retryAtMs: START + 10,
    })
    expect(outbox.get(`reply-${accepted.update.id}`)?.state).toBe('PENDING')
    nowMs += 10
    expect((await worker.runOnce()).outcome).toBe('enqueued')

    expect(coordinator.calls).toHaveLength(2)
    expect(coordinator.calls[0]?.operationKey).toBe(coordinator.calls[1]?.operationKey)
    expect(coordinator.started.size).toBe(1)
    expect(inbox.get(accepted.update.id)?.state).toBe('PROCESSED')
    expect(
      database.query<{ count: number }, []>('SELECT count(*) AS count FROM delivery_jobs').get()?.count,
    ).toBe(1)
  })

  test('marks unsupported updates processed without starting a turn', async () => {
    const accepted = inbox.ingest({
      botId: 'primary-bot',
      updateId: 503,
      payload: { update_id: 503, callback_query: {} },
      receivedAtMs: START,
    })
    const worker = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
      workerId: 'inbox-a',
      now: () => nowMs,
    })

    expect(await worker.runOnce()).toEqual({ outcome: 'ignored', updateId: accepted.update.id })
    expect(coordinator.calls).toHaveLength(0)
    expect(inbox.get(accepted.update.id)?.state).toBe('PROCESSED')
  })

  test('retries coordinator failure without storing its possibly sensitive message', async () => {
    const accepted = inbox.ingest(textUpdate(504))
    coordinator.failure = new Error('request included secret-value')
    const worker = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
      workerId: 'inbox-a',
      now: () => nowMs,
    })

    expect((await worker.runOnce()).outcome).toBe('retry_wait')
    expect(inbox.get(accepted.update.id)?.lastError).toBe('Error')
    expect(inbox.get(accepted.update.id)?.lastError).not.toContain('secret-value')
  })

  test('keeps a long Codex turn leased while the lease reaper runs', async () => {
    const accepted = inbox.ingest({ ...textUpdate(505), receivedAtMs: Date.now() })
    let release: (() => void) | undefined
    coordinator.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
      workerId: 'inbox-a',
      leaseDurationMs: 30,
      leaseHeartbeatMs: 5,
    })

    const running = worker.runOnce()
    await Bun.sleep(70)
    expect(inbox.recoverExpiredLeases(Date.now())).toBe(0)
    release?.()
    expect((await running).outcome).toBe('enqueued')
    expect(inbox.get(accepted.update.id)?.state).toBe('PROCESSED')
  })

  test('defers a queued turn without consuming the retry budget', async () => {
    const accepted = inbox.ingest({ ...textUpdate(506), routingClass: 'MESSAGE' })
    coordinator.failure = new TurnQueuedBehindTurnError('local-turn-2', 'local-turn-1')
    const worker = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
      workerId: 'inbox-a',
      now: () => nowMs,
      queuePollMs: 250,
      retryPolicy: exponentialRetryPolicy({ maxAttempts: 1 }),
    })

    expect(await worker.runOnce()).toEqual({
      outcome: 'queued',
      updateId: accepted.update.id,
      retryAtMs: START + 250,
      localTurnId: 'local-turn-2',
    })
    expect(inbox.get(accepted.update.id)).toMatchObject({
      state: 'RETRY_WAIT',
      routingClass: 'QUEUED_MESSAGE',
      attemptCount: 0,
      lastError: 'queued behind active turn',
    })

    nowMs += 250
    expect((await worker.runOnce()).outcome).toBe('queued')
    expect(inbox.get(accepted.update.id)?.attemptCount).toBe(0)
  })
})

describe('OutboxDeliveryWorker failure boundaries', () => {
  function enqueue(id: string): void {
    outbox.enqueue({
      id,
      sourceKey: `test:${id}`,
      kind: 'send_text',
      payload: { chatId: '7001', text: id },
      createdAtMs: START,
    })
  }

  test('preparation failure is retryable because send_started was not written', async () => {
    enqueue('prepare-failure')
    telegram.prepareFailure = new Error('local media unavailable with secret-value')
    const worker = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      now: () => nowMs,
      retryPolicy: exponentialRetryPolicy({ baseDelayMs: 25, maxDelayMs: 25 }),
    })

    expect(await worker.runOnce()).toEqual({
      outcome: 'retry_wait',
      jobId: 'prepare-failure',
      retryAtMs: START + 25,
    })
    const job = outbox.get('prepare-failure')
    expect(job?.state).toBe('RETRY_WAIT')
    expect(job?.sendStartedAtMs).toBeNull()
    expect(job?.lastError).toBe('Error')
    expect(telegram.executed).toHaveLength(0)
  })

  test('any execution failure becomes AMBIGUOUS and is never auto-retried', async () => {
    enqueue('execute-failure')
    telegram.executeFailure = new Error('socket closed after write')
    const worker = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      now: () => nowMs,
    })

    expect(await worker.runOnce()).toEqual({ outcome: 'ambiguous', jobId: 'execute-failure' })
    expect(outbox.get('execute-failure')?.state).toBe('AMBIGUOUS')
    nowMs += 1_000_000
    expect(await worker.runOnce()).toEqual({ outcome: 'idle' })
  })

  test('empty remote proof is treated as ambiguous, never delivered', async () => {
    enqueue('missing-proof')
    telegram.remoteId = '  '
    const worker = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      now: () => nowMs,
    })

    expect(await worker.runOnce()).toEqual({ outcome: 'ambiguous', jobId: 'missing-proof' })
    expect(outbox.get('missing-proof')?.state).toBe('AMBIGUOUS')
    expect(outbox.get('missing-proof')?.remoteId).toBeNull()
  })

  test('bounded preparation retries end in FAILED', async () => {
    enqueue('bounded')
    telegram.prepareFailure = new Error('invalid payload')
    const worker = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      now: () => nowMs,
      retryPolicy: exponentialRetryPolicy({ maxAttempts: 1 }),
    })

    expect(await worker.runOnce()).toEqual({ outcome: 'failed', jobId: 'bounded' })
    expect(outbox.get('bounded')?.state).toBe('FAILED')
  })

  test('keeps an in-flight Telegram send leased instead of quarantining it early', async () => {
    outbox.enqueue({
      id: 'slow-send',
      sourceKey: 'test:slow-send',
      kind: 'send_text',
      payload: { chatId: '7001', text: 'slow-send' },
      createdAtMs: Date.now(),
    })
    let release: (() => void) | undefined
    telegram.executeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new OutboxDeliveryWorker(outbox, telegram, {
      workerId: 'sender-a',
      leaseDurationMs: 30,
      leaseHeartbeatMs: 5,
    })

    const running = worker.runOnce()
    await Bun.sleep(70)
    expect(outbox.recoverExpiredLeases(Date.now())).toEqual({
      retryable: 0,
      ambiguous: 0,
      expired: 0,
    })
    release?.()
    expect((await running).outcome).toBe('delivered')
    expect(outbox.get('slow-send')?.state).toBe('DELIVERED')
  })
})
