import { describe, expect, test } from 'bun:test'

import {
  DurableBridgeSupervisor,
  type SupervisorActivityEvent,
  type SupervisorErrorEvent,
} from '../../src/bridge/durable-supervisor.js'
import type { DurableSupervisorRuntime } from '../../src/bridge/durable-supervisor.js'
import type { DurablePollResult } from '../../src/telegram/durable-poller.js'

const EMPTY_POLL: DurablePollResult = {
  fetched: 0,
  inserted: 0,
  duplicates: 0,
  nextUpdateId: null,
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('condition was not reached')
}

class BlockingPoller {
  calls = 0

  async pollOnce(signal?: AbortSignal): Promise<DurablePollResult> {
    this.calls += 1
    if (signal?.aborted === true) return EMPTY_POLL
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
    return EMPTY_POLL
  }
}

class ControlledRuntime implements DurableSupervisorRuntime {
  inboundCalls = 0
  activeInbound = 0
  outboundCalls = 0
  recoveryCalls = 0
  failFirstInbound = false
  private releaseInbound: (() => void) | undefined
  private readonly inboundGate = new Promise<void>((resolve) => {
    this.releaseInbound = resolve
  })

  async processInboundOnce(): Promise<{ outcome: 'idle' }> {
    this.inboundCalls += 1
    if (this.failFirstInbound) {
      this.failFirstInbound = false
      throw new Error('sensitive request text')
    }
    this.activeInbound += 1
    await this.inboundGate
    this.activeInbound -= 1
    return { outcome: 'idle' }
  }

  async deliverOutboundOnce(): Promise<{ outcome: 'idle' }> {
    this.outboundCalls += 1
    return { outcome: 'idle' }
  }

  recoverExpiredLeases(): {
    inboxRecovered: number
    outbox: { retryable: number; ambiguous: number; expired: number }
  } {
    this.recoveryCalls += 1
    return { inboxRecovered: 0, outbox: { retryable: 0, ambiguous: 0, expired: 0 } }
  }

  release(): void {
    this.releaseInbound?.()
  }
}

describe('DurableBridgeSupervisor', () => {
  test('starts recovery and concurrent workers, then drains active work on stop', async () => {
    const poller = new BlockingPoller()
    const runtime = new ControlledRuntime()
    const supervisor = new DurableBridgeSupervisor(poller, runtime, {
      inboundConcurrency: 2,
      pollIdleDelayMs: 1,
      workerIdleDelayMs: 1,
      errorDelayMs: 1,
      reaperIntervalMs: 5,
    })

    supervisor.start()
    await waitUntil(() => runtime.activeInbound === 2)
    expect(runtime.recoveryCalls).toBeGreaterThan(0)
    expect(runtime.outboundCalls).toBeGreaterThan(0)

    let stopped = false
    const stopping = supervisor.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(5)
    expect(stopped).toBe(false)
    expect(supervisor.running).toBe(true)

    runtime.release()
    await stopping
    expect(stopped).toBe(true)
    expect(supervisor.running).toBe(false)
  })

  test('contains loop failures and reports only a safe error class', async () => {
    const poller = new BlockingPoller()
    const runtime = new ControlledRuntime()
    runtime.failFirstInbound = true
    const events: SupervisorErrorEvent[] = []
    const supervisor = new DurableBridgeSupervisor(poller, runtime, {
      inboundConcurrency: 1,
      pollIdleDelayMs: 1,
      workerIdleDelayMs: 1,
      errorDelayMs: 1,
      reaperIntervalMs: 5,
      onError: (event) => events.push(event),
    })

    supervisor.start()
    await waitUntil(() => runtime.activeInbound === 1)
    expect(events).toEqual([{ component: 'inbox', workerIndex: 0, errorName: 'Error' }])
    expect(JSON.stringify(events)).not.toContain('sensitive request text')
    expect(runtime.inboundCalls).toBe(2)

    const stopping = supervisor.stop()
    runtime.release()
    await stopping
  })

  test('reports successful loop activity without payloads', async () => {
    const poller = new BlockingPoller()
    const runtime = new ControlledRuntime()
    const events: SupervisorActivityEvent[] = []
    const supervisor = new DurableBridgeSupervisor(poller, runtime, {
      inboundConcurrency: 1,
      workerIdleDelayMs: 1,
      reaperIntervalMs: 5,
      uxIntervalMs: 5,
      onActivity: (event) => events.push(event),
    })

    supervisor.start()
    await waitUntil(() => events.some((event) => event.component === 'outbox'))
    expect(events).toContainEqual({ component: 'reaper', workerIndex: null })
    expect(events).toContainEqual({ component: 'ux', workerIndex: null })
    expect(JSON.stringify(events)).not.toContain('request')
    const stopping = supervisor.stop()
    runtime.release()
    await stopping
  })
})
