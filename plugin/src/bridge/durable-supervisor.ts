import type { InboxRunResult } from './inbox-processing-worker.js'
import type { DeliveryRunResult } from './outbox-delivery-worker.js'
import type { LeaseRecoverySweep } from '../durable/lease-reaper.js'
import type { DurablePollResult } from '../telegram/durable-poller.js'

export type SupervisorComponent = 'poller' | 'inbox' | 'outbox' | 'reaper' | 'ux'

export interface SupervisorErrorEvent {
  component: SupervisorComponent
  workerIndex: number | null
  errorName: string
}

export interface DurableSupervisorPoller {
  pollOnce(signal?: AbortSignal): Promise<DurablePollResult>
}

export interface DurableSupervisorRuntime {
  processInboundOnce(): Promise<InboxRunResult>
  deliverOutboundOnce(): Promise<DeliveryRunResult>
  recoverExpiredLeases(): LeaseRecoverySweep
  runUxHeartbeat?(): number
}

export interface DurableBridgeSupervisorOptions {
  inboundConcurrency?: number
  pollIdleDelayMs?: number
  workerIdleDelayMs?: number
  errorDelayMs?: number
  reaperIntervalMs?: number
  uxIntervalMs?: number
  onError?: (event: SupervisorErrorEvent) => void
}

interface ActiveRun {
  controller: AbortController
  done: Promise<void>
}

const DEFAULT_INBOUND_CONCURRENCY = 2
const DEFAULT_POLL_IDLE_DELAY_MS = 100
const DEFAULT_WORKER_IDLE_DELAY_MS = 50
const DEFAULT_ERROR_DELAY_MS = 1_000
const DEFAULT_REAPER_INTERVAL_MS = 5_000
const DEFAULT_UX_INTERVAL_MS = 30_000

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0 ? error.name : 'UnknownError'
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Runs polling, durable workers and lease recovery as one drainable service. */
export class DurableBridgeSupervisor {
  private readonly inboundConcurrency: number
  private readonly pollIdleDelayMs: number
  private readonly workerIdleDelayMs: number
  private readonly errorDelayMs: number
  private readonly reaperIntervalMs: number
  private readonly uxIntervalMs: number
  private readonly onError: ((event: SupervisorErrorEvent) => void) | undefined
  private active: ActiveRun | null = null

  constructor(
    private readonly poller: DurableSupervisorPoller,
    private readonly runtime: DurableSupervisorRuntime,
    options: DurableBridgeSupervisorOptions = {},
  ) {
    this.inboundConcurrency = positiveInteger(
      options.inboundConcurrency ?? DEFAULT_INBOUND_CONCURRENCY,
      'inboundConcurrency',
    )
    this.pollIdleDelayMs = positiveInteger(
      options.pollIdleDelayMs ?? DEFAULT_POLL_IDLE_DELAY_MS,
      'pollIdleDelayMs',
    )
    this.workerIdleDelayMs = positiveInteger(
      options.workerIdleDelayMs ?? DEFAULT_WORKER_IDLE_DELAY_MS,
      'workerIdleDelayMs',
    )
    this.errorDelayMs = positiveInteger(options.errorDelayMs ?? DEFAULT_ERROR_DELAY_MS, 'errorDelayMs')
    this.reaperIntervalMs = positiveInteger(
      options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS,
      'reaperIntervalMs',
    )
    this.uxIntervalMs = positiveInteger(options.uxIntervalMs ?? DEFAULT_UX_INTERVAL_MS, 'uxIntervalMs')
    this.onError = options.onError
  }

  get running(): boolean {
    return this.active !== null
  }

  start(): void {
    if (this.active !== null) throw new Error('durable bridge supervisor is already running')
    const controller = new AbortController()
    const loops: Promise<void>[] = [
      this.runReaperLoop(controller.signal),
      this.runUxLoop(controller.signal),
      this.runPollerLoop(controller.signal),
      ...Array.from({ length: this.inboundConcurrency }, (_, index) =>
        this.runInboxLoop(index, controller.signal),
      ),
      this.runOutboxLoop(controller.signal),
    ]
    this.active = { controller, done: Promise.all(loops).then(() => undefined) }
  }

  async stop(): Promise<void> {
    const active = this.active
    if (active === null) return
    active.controller.abort()
    await active.done
    if (this.active === active) this.active = null
  }

  async wait(): Promise<void> {
    await this.active?.done
  }

  private async runPollerLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.poller.pollOnce(signal)
        if (result.fetched === 0) await abortableDelay(this.pollIdleDelayMs, signal)
      } catch (error) {
        if (signal.aborted) return
        this.reportError('poller', null, error)
        await abortableDelay(this.errorDelayMs, signal)
      }
    }
  }

  private async runInboxLoop(workerIndex: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.runtime.processInboundOnce()
        if (result.outcome === 'idle') await abortableDelay(this.workerIdleDelayMs, signal)
      } catch (error) {
        if (signal.aborted) return
        this.reportError('inbox', workerIndex, error)
        await abortableDelay(this.errorDelayMs, signal)
      }
    }
  }

  private async runOutboxLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await this.runtime.deliverOutboundOnce()
        if (result.outcome === 'idle') await abortableDelay(this.workerIdleDelayMs, signal)
      } catch (error) {
        if (signal.aborted) return
        this.reportError('outbox', null, error)
        await abortableDelay(this.errorDelayMs, signal)
      }
    }
  }

  private async runReaperLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.runtime.recoverExpiredLeases()
      } catch (error) {
        this.reportError('reaper', null, error)
      }
      await abortableDelay(this.reaperIntervalMs, signal)
    }
  }

  private async runUxLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.runtime.runUxHeartbeat?.()
      } catch (error) {
        this.reportError('ux', null, error)
      }
      await abortableDelay(this.uxIntervalMs, signal)
    }
  }

  private reportError(
    component: SupervisorComponent,
    workerIndex: number | null,
    error: unknown,
  ): void {
    try {
      this.onError?.({ component, workerIndex, errorName: errorName(error) })
    } catch {
      // Diagnostics must never terminate a transport loop.
    }
  }
}
