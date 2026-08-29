import type {
  InboxRepository,
  InboxUpdate,
  OutboxRepository,
} from '../durable/contracts.js'
import type { SessionCoordinator, TelegramGateway } from './contracts.js'
import {
  exponentialRetryPolicy,
  safeErrorSummary,
  type RetryPolicy,
} from './retry-policy.js'

export type InboxRunResult =
  | { outcome: 'idle' }
  | { outcome: 'ignored'; updateId: number }
  | { outcome: 'enqueued'; updateId: number; deliveryJobId: string }
  | { outcome: 'retry_wait'; updateId: number; retryAtMs: number }
  | { outcome: 'failed'; updateId: number }

export interface InboxProcessingWorkerOptions {
  workerId: string
  leaseDurationMs?: number
  retryPolicy?: RetryPolicy
  now?: () => number
  errorSummary?: (error: unknown) => string
}

const DEFAULT_LEASE_MS = 60_000

function operationKey(update: InboxUpdate): string {
  return `telegram:${encodeURIComponent(update.botId)}:${update.updateId}:turn`
}

export class InboxProcessingWorker {
  private readonly workerId: string
  private readonly leaseDurationMs: number
  private readonly retryPolicy: RetryPolicy
  private readonly now: () => number
  private readonly errorSummary: (error: unknown) => string

  constructor(
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly coordinator: SessionCoordinator,
    private readonly telegram: TelegramGateway,
    options: InboxProcessingWorkerOptions,
  ) {
    this.workerId = options.workerId
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
    this.retryPolicy = options.retryPolicy ?? exponentialRetryPolicy()
    this.now = options.now ?? Date.now
    this.errorSummary = options.errorSummary ?? safeErrorSummary
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
    } catch (error) {
      return this.handleFailure(update, error)
    }
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
