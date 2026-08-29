import { describe, expect, test } from 'bun:test'

import {
  createHealthRequestHandler,
  DurableBridgeHealth,
  DurableHealthServer,
  SystemdWatchdog,
  type SystemdNotifier,
  type SystemdNotifyResult,
} from '../../src/bridge/health.js'

function healthFixture(overrides: { databaseProbe?: () => boolean } = {}): {
  health: DurableBridgeHealth
  advance(ms: number): void
} {
  let now = 1_000
  return {
    health: new DurableBridgeHealth({
      inboundConcurrency: 2,
      startupGraceMs: 1_000,
      staleAfterMs: 5_000,
      maxConsecutiveErrors: 2,
      databaseProbe: overrides.databaseProbe ?? (() => true),
      now: () => now,
    }),
    advance(ms: number): void {
      now += ms
    },
  }
}

function recordEveryLoop(health: DurableBridgeHealth): void {
  health.recordActivity({ component: 'poller', workerIndex: null })
  health.recordActivity({ component: 'inbox', workerIndex: 0 })
  health.recordActivity({ component: 'inbox', workerIndex: 1 })
  health.recordActivity({ component: 'outbox', workerIndex: null })
  health.recordActivity({ component: 'reaper', workerIndex: null })
  health.recordActivity({ component: 'ux', workerIndex: null })
}

class RecordingNotifier implements SystemdNotifier {
  readonly calls: string[][] = []

  async notify(fields: readonly string[]): Promise<SystemdNotifyResult> {
    this.calls.push([...fields])
    return { ok: true }
  }
}

describe('DurableBridgeHealth', () => {
  test('uses a startup grace then requires every worker loop to stay fresh', () => {
    const fixture = healthFixture()
    expect(fixture.health.snapshot().live).toBeFalse()
    fixture.health.markRunning()
    expect(fixture.health.snapshot().ready).toBeTrue()

    recordEveryLoop(fixture.health)
    fixture.advance(5_001)
    const stale = fixture.health.snapshot()
    expect(stale.ready).toBeFalse()
    expect(stale.loops['inbox.0']?.healthy).toBeFalse()
    expect(stale.loops['inbox.1']?.lastSuccessAgoMs).toBe(5_001)
  })

  test('degrades after consecutive safe error events and recovers on activity', () => {
    const fixture = healthFixture()
    fixture.health.markRunning()
    fixture.health.recordError({ component: 'inbox', workerIndex: 1, errorName: 'SecretError' })
    expect(fixture.health.snapshot().ready).toBeTrue()
    fixture.health.recordError({ component: 'inbox', workerIndex: 1, errorName: 'SecretError' })
    const degraded = fixture.health.snapshot()
    expect(degraded.ready).toBeFalse()
    expect(JSON.stringify(degraded)).not.toContain('SecretError')

    fixture.health.recordActivity({ component: 'inbox', workerIndex: 1 })
    expect(fixture.health.snapshot().ready).toBeTrue()
  })

  test('fails readiness when the database probe fails or lifecycle stops', () => {
    let databaseHealthy = true
    const fixture = healthFixture({ databaseProbe: () => databaseHealthy })
    fixture.health.markRunning()
    databaseHealthy = false
    expect(fixture.health.snapshot().ready).toBeFalse()
    databaseHealthy = true
    fixture.health.markStopping()
    expect(fixture.health.snapshot()).toMatchObject({ live: false, ready: false, lifecycle: 'stopping' })
    fixture.health.markStopped()
    expect(fixture.health.snapshot().lifecycle).toBe('stopped')
  })

  test('serves payload-free live and readiness responses', async () => {
    const fixture = healthFixture()
    fixture.health.markRunning()
    const handler = createHealthRequestHandler(fixture.health)
    const ready = handler(new Request('http://localhost/ready'))
    expect(ready.status).toBe(200)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    const body = await ready.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('botId')
    expect(body).not.toHaveProperty('projects')
    expect(handler(new Request('http://localhost/missing')).status).toBe(404)
    expect(handler(new Request('http://localhost/live', { method: 'POST' })).status).toBe(405)
  })

  test('binds an actual health server and closes it cleanly', async () => {
    const fixture = healthFixture()
    fixture.health.markRunning()
    const server = new DurableHealthServer(fixture.health, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    })
    server.start()
    const port = server.boundPort
    expect(port).not.toBeNull()
    const response = await fetch(`http://127.0.0.1:${String(port)}/live`)
    expect(response.status).toBe(200)
    server.stop()
    expect(server.boundPort).toBeNull()
  })
})

describe('SystemdWatchdog', () => {
  test('notifies READY, pulses only while ready, then notifies STOPPING', async () => {
    const fixture = healthFixture()
    fixture.health.markRunning()
    const notifier = new RecordingNotifier()
    const watchdog = new SystemdWatchdog(fixture.health, {
      env: {
        NOTIFY_SOCKET: '/run/systemd/notify',
        WATCHDOG_USEC: '7200000000',
        WATCHDOG_PID: '42',
      },
      pid: 42,
      notifier,
    })
    watchdog.start()
    watchdog.pulse()
    await Bun.sleep(0)
    expect(notifier.calls).toContainEqual(['--ready'])
    expect(notifier.calls).toContainEqual(['WATCHDOG=1'])

    fixture.health.markStopping()
    const callsBeforeDegradedPulse = notifier.calls.length
    watchdog.pulse()
    await Bun.sleep(0)
    expect(notifier.calls).toHaveLength(callsBeforeDegradedPulse)
    await watchdog.stop()
    expect(notifier.calls.at(-1)).toEqual(['--stopping'])
  })

  test('stays inert outside systemd activation', async () => {
    const fixture = healthFixture()
    fixture.health.markRunning()
    const notifier = new RecordingNotifier()
    const watchdog = new SystemdWatchdog(fixture.health, { env: {}, notifier })
    watchdog.start()
    watchdog.pulse()
    await watchdog.stop()
    expect(watchdog.enabled).toBeFalse()
    expect(notifier.calls).toEqual([])
  })
})
