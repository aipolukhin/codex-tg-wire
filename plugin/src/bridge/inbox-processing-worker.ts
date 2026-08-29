import type {
  InboxRepository,
  InboxUpdate,
  OutboxRepository,
} from '../durable/contracts.js'
import type {
  CommandHandler,
  SessionCoordinator,
  TelegramGateway,
} from './contracts.js'
import {
  exponentialRetryPolicy,
  safeErrorSummary,
  type RetryPolicy,
} from './retry-policy.js'
import { LeaseHeartbeatError, withLeaseHeartbeat } from './lease-heartbeat.js'

export type InboxRunResult =
  | { outcome: 'idle' }
  | { outcome: 'ignored'; updateId: number }
  | { outcome: 'enqueued'; updateId: number; deliveryJobId: string }
  | { outcome: 'retry_wait'; updateId: number; retryAtMs: number }
  | { outcome: 'failed'; updateId: number }

export interface InboxProcessingWorkerOptions {
  workerId: string
  leaseDurationMs?: number
  leaseHeartbeatMs?: number
  retryPolicy?: RetryPolicy
  now?: () => number
  errorSummary?: (error: unknown) => string
  commandHandler?: CommandHandler
}

const DEFAULT_LEASE_MS = 60_000

function operationKey(update: InboxUpdate): string {
  return `telegram:${encodeURIComponent(update.botId)}:${update.updateId}:turn`
}

export class InboxProcessingWorker {
  private readonly workerId: string
  private readonly leaseDurationMs: number
  private readonly leaseHeartbeatMs: number
  private readonly retryPolicy: RetryPolicy
  private readonly now: () => number
  private readonly errorSummary: (error: unknown) => string
  private readonly commandHandler: CommandHandler | undefined

  constructor(
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly coordinator: SessionCoordinator,
    private readonly telegram: TelegramGateway,
    options: InboxProcessingWorkerOptions,
  ) {
    this.workerId = options.workerId
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.leaseDurationMs / 3))
    this.retryPolicy = options.retryPolicy ?? exponentialRetryPolicy()
    this.now = options.now ?? Date.now
    this.errorSummary = options.errorSummary ?? safeErrorSummary
    this.commandHandler = options.commandHandler
    if (
      !Number.isSafeInteger(this.leaseHeartbeatMs) ||
      this.leaseHeartbeatMs <= 0 ||
      this.leaseHeartbeatMs > this.leaseDurationMs
    ) {
      throw new TypeError('leaseHeartbeatMs must be positive and no greater than leaseDurationMs')
    }
  }

  async runOnce(): Promise<InboxRunResult> {
    const claimedAtMs = this.now()
    const update = this.inbox.claimNext({
      workerId: this.workerId,
      nowMs: claimedAtMs,
      leaseDurationMs: this.leaseDurationMs,
    })
    if (update === null) return { outcome: 'idle' }

    try {
      return await withLeaseHeartbeat(
        {
          intervalMs: this.leaseHeartbeatMs,
          renew: () => {
            this.inbox.renewLease(update.id, {
              workerId: this.workerId,
              nowMs: this.now(),
              leaseDurationMs: this.leaseDurationMs,
            })
          },
        },
        () => this.processClaimed(update),
      )
    } catch (error) {
      if (error instanceof LeaseHeartbeatError) throw error
      return this.handleFailure(update, error)
    }
  }

  private async processClaimed(update: InboxUpdate): Promise<InboxRunResult> {
    const command = this.telegram.extractCommand?.(update) ?? null
    if (command !== null && this.commandHandler !== undefined) {
      const commandKey = `${operationKey(update)}:command:${command.name}`
      const result = await this.commandHandler.handleCommand({
        operationKey: commandKey,
        botId: update.botId,
        inboxUpdateId: update.id,
        updateId: update.updateId,
        command,
      })
      const completedAtMs = this.now()
      const buildDelivery = this.telegram.buildCommandDelivery
      if (buildDelivery === undefined) {
        throw new Error('Telegram gateway cannot build command replies')
      }
      const enqueue = this.outbox.enqueue({
        ...buildDelivery.call(this.telegram, {
          update,
          command,
          result,
          sourceKey: `${commandKey}:reply`,
          nowMs: completedAtMs,
        }),
        sourceKey: `${commandKey}:reply`,
        createdAtMs: completedAtMs,
      })
      this.inbox.markProcessed(update.id, this.workerId, completedAtMs)
      return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
    }

    const message = this.telegram.extractText(update)
    if (message === null) {
      this.inbox.markProcessed(update.id, this.workerId, this.now())
      return { outcome: 'ignored', updateId: update.id }
    }

    const turnKey = operationKey(update)
    const result = await this.coordinator.runTextTurn({
      operationKey: turnKey,
      inboxUpdateId: update.id,
      botId: update.botId,
      updateId: update.updateId,
      chatId: message.chatId,
      projectId: message.projectId,
      text: message.text,
    })
    const completedAtMs = this.now()
    const enqueue = this.outbox.enqueue({
      ...this.telegram.buildFinalTextDelivery({
        update,
        message,
        result,
        sourceKey: `${turnKey}:final`,
        nowMs: completedAtMs,
      }),
      sourceKey: `${turnKey}:final`,
      createdAtMs: completedAtMs,
    })
    this.inbox.markProcessed(update.id, this.workerId, completedAtMs)
    return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
  }

  private handleFailure(update: InboxUpdate, error: unknown): InboxRunResult {
    const failedAtMs = this.now()
    const retryAtMs = this.retryPolicy.nextRetryAt(update, failedAtMs)
    const summary = this.errorSummary(error)
    if (retryAtMs === null) {
      this.inbox.fail(update.id, this.workerId, summary, failedAtMs)
      return { outcome: 'failed', updateId: update.id }
    }
    this.inbox.retry(update.id, this.workerId, summary, retryAtMs)
    return { outcome: 'retry_wait', updateId: update.id, retryAtMs }
  }
}
