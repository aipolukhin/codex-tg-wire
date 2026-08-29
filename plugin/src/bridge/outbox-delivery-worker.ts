import type { DeliveryJob, OutboxRepository } from '../durable/contracts.js'
import type { TelegramGateway } from './contracts.js'
import {
  exponentialRetryPolicy,
  safeErrorSummary,
  type RetryPolicy,
} from './retry-policy.js'
import { LeaseHeartbeatError, withLeaseHeartbeat } from './lease-heartbeat.js'

export type DeliveryRunResult =
  | { outcome: 'idle' }
  | { outcome: 'delivered'; jobId: string; remoteId: string }
  | { outcome: 'retry_wait'; jobId: string; retryAtMs: number }
  | { outcome: 'failed'; jobId: string }
  | { outcome: 'ambiguous'; jobId: string }

export interface OutboxDeliveryWorkerOptions {
  workerId: string
  leaseDurationMs?: number
  leaseHeartbeatMs?: number
  retryPolicy?: RetryPolicy
  now?: () => number
  errorSummary?: (error: unknown) => string
}

const DEFAULT_LEASE_MS = 60_000

export class OutboxDeliveryWorker<PreparedDelivery = unknown> {
  private readonly workerId: string
  private readonly leaseDurationMs: number
  private readonly leaseHeartbeatMs: number
  private readonly retryPolicy: RetryPolicy
  private readonly now: () => number
  private readonly errorSummary: (error: unknown) => string

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly telegram: TelegramGateway<PreparedDelivery>,
    options: OutboxDeliveryWorkerOptions,
  ) {
    this.workerId = options.workerId
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.leaseDurationMs / 3))
    this.retryPolicy = options.retryPolicy ?? exponentialRetryPolicy()
    this.now = options.now ?? Date.now
    this.errorSummary = options.errorSummary ?? safeErrorSummary
    if (
      !Number.isSafeInteger(this.leaseHeartbeatMs) ||
      this.leaseHeartbeatMs <= 0 ||
      this.leaseHeartbeatMs > this.leaseDurationMs
    ) {
      throw new TypeError('leaseHeartbeatMs must be positive and no greater than leaseDurationMs')
    }
  }

  async runOnce(): Promise<DeliveryRunResult> {
    const job = this.outbox.claimNext({
      workerId: this.workerId,
      nowMs: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    })
    if (job === null) return { outcome: 'idle' }

    let prepared: PreparedDelivery
    try {
      prepared = await this.withHeartbeat(job, () => this.telegram.prepareDelivery(job))
    } catch (error) {
      if (error instanceof LeaseHeartbeatError) throw error
      return this.failBeforeSend(job, error)
    }

    this.outbox.markSendStarted(job.id, this.workerId, this.now())
    let remoteId: string
    try {
      const proof = await this.withHeartbeat(job, () => this.telegram.executeDelivery(prepared))
      remoteId = proof.remoteId
      if (remoteId.trim().length === 0) throw new TypeError('Telegram returned empty delivery proof')
    } catch (error) {
      if (error instanceof LeaseHeartbeatError) throw error
      const failure = this.outbox.failLease(
        job.id,
        this.workerId,
        this.errorSummary(error),
        this.now(),
      )
      if (!failure.becameAmbiguous) {
        throw new Error(`delivery job ${job.id} lost send_started state`)
      }
      return { outcome: 'ambiguous', jobId: job.id }
    }

    const delivered = this.outbox.markDelivered(job.id, this.workerId, remoteId, this.now())
    return { outcome: 'delivered', jobId: job.id, remoteId: delivered.remoteId as string }
  }

  private withHeartbeat<T>(job: DeliveryJob, operation: () => Promise<T>): Promise<T> {
    return withLeaseHeartbeat(
      {
        intervalMs: this.leaseHeartbeatMs,
        renew: () => {
          this.outbox.renewLease(job.id, {
            workerId: this.workerId,
            nowMs: this.now(),
            leaseDurationMs: this.leaseDurationMs,
          })
        },
      },
      operation,
    )
  }

  private failBeforeSend(job: DeliveryJob, error: unknown): DeliveryRunResult {
    const failedAtMs = this.now()
    const retryAtMs = this.retryPolicy.nextRetryAt(job, failedAtMs)
    const failure = this.outbox.failLease(
      job.id,
      this.workerId,
      this.errorSummary(error),
      failedAtMs,
      retryAtMs ?? undefined,
    )
    if (failure.becameAmbiguous) {
      throw new Error(`delivery job ${job.id} entered send_started during preparation`)
    }
    if (retryAtMs === null) return { outcome: 'failed', jobId: job.id }
    return { outcome: 'retry_wait', jobId: job.id, retryAtMs }
  }
}
