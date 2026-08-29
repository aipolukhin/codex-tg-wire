import { spawnSync } from 'node:child_process'

import type {
  SupervisorActivityEvent,
  SupervisorComponent,
  SupervisorErrorEvent,
} from './durable-supervisor.js'

export type HealthLifecycle = 'starting' | 'running' | 'stopping' | 'stopped'

export interface DurableLoopHealth {
  healthy: boolean
  lastSuccessAgoMs: number | null
  consecutiveErrors: number
  totalErrors: number
}

export interface DurableHealthSnapshot {
  live: boolean
  ready: boolean
  lifecycle: HealthLifecycle
  uptimeMs: number
  database: { healthy: boolean }
  loops: Record<string, DurableLoopHealth>
}

export interface DurableBridgeHealthOptions {
  inboundConcurrency: number
  startupGraceMs: number
  staleAfterMs: number
  maxConsecutiveErrors: number
  databaseProbe: () => boolean
  now?: () => number
}

interface LoopState {
  lastSuccessAtMs: number | null
  consecutiveErrors: number
  totalErrors: number
}

function loopKey(component: SupervisorComponent, workerIndex: number | null): string {
  return component === 'inbox' ? `inbox.${workerIndex ?? 0}` : component
}

function requiredLoopKeys(inboundConcurrency: number): string[] {
  return [
    'poller',
    ...Array.from({ length: inboundConcurrency }, (_, index) => `inbox.${index}`),
    'outbox',
    'reaper',
    'ux',
  ]
}

/** Payload-free readiness state for the durable transport loops. */
export class DurableBridgeHealth {
  private readonly states = new Map<string, LoopState>()
  private readonly now: () => number
  private readonly startedAtMs: number
  private lifecycle: HealthLifecycle = 'starting'

  constructor(private readonly options: DurableBridgeHealthOptions) {
    if (!Number.isSafeInteger(options.inboundConcurrency) || options.inboundConcurrency < 1) {
      throw new TypeError('inboundConcurrency must be a positive safe integer')
    }
    this.now = options.now ?? Date.now
    this.startedAtMs = this.now()
    for (const key of requiredLoopKeys(options.inboundConcurrency)) {
      this.states.set(key, {
        lastSuccessAtMs: null,
        consecutiveErrors: 0,
        totalErrors: 0,
      })
    }
  }

  markRunning(): void {
    if (this.lifecycle !== 'starting') throw new Error(`cannot run health from ${this.lifecycle}`)
    this.lifecycle = 'running'
  }

  markStopping(): void {
    if (this.lifecycle === 'stopped') return
    this.lifecycle = 'stopping'
  }

  markStopped(): void {
    this.lifecycle = 'stopped'
  }

  recordActivity(event: SupervisorActivityEvent): void {
    const state = this.states.get(loopKey(event.component, event.workerIndex))
    if (state === undefined) return
    state.lastSuccessAtMs = this.now()
    state.consecutiveErrors = 0
  }

  recordError(event: SupervisorErrorEvent): void {
    const state = this.states.get(loopKey(event.component, event.workerIndex))
    if (state === undefined) return
    state.consecutiveErrors += 1
    state.totalErrors += 1
  }

  snapshot(): DurableHealthSnapshot {
    const now = this.now()
    const withinStartupGrace = now - this.startedAtMs <= this.options.startupGraceMs
    const loops: Record<string, DurableLoopHealth> = {}
    for (const [key, state] of this.states) {
      const lastSuccessAgoMs = state.lastSuccessAtMs === null ? null : Math.max(0, now - state.lastSuccessAtMs)
      const fresh = lastSuccessAgoMs !== null && lastSuccessAgoMs <= this.options.staleAfterMs
      loops[key] = {
        healthy:
          this.lifecycle === 'running' &&
          (fresh || (withinStartupGrace && state.lastSuccessAtMs === null)) &&
          state.consecutiveErrors < this.options.maxConsecutiveErrors,
        lastSuccessAgoMs,
        consecutiveErrors: state.consecutiveErrors,
        totalErrors: state.totalErrors,
      }
    }
    let databaseHealthy = false
    try {
      databaseHealthy = this.options.databaseProbe()
    } catch {
      databaseHealthy = false
    }
    const live = this.lifecycle === 'running'
    const ready = live && databaseHealthy && Object.values(loops).every((loop) => loop.healthy)
    return {
      live,
      ready,
      lifecycle: this.lifecycle,
      uptimeMs: Math.max(0, now - this.startedAtMs),
      database: { healthy: databaseHealthy },
      loops,
    }
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function createHealthRequestHandler(
  health: DurableBridgeHealth,
): (request: Request) => Response {
  return (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405)
    }
    const path = new URL(request.url).pathname
    const snapshot = health.snapshot()
    if (path === '/live') {
      return json(
        { live: snapshot.live, lifecycle: snapshot.lifecycle, uptimeMs: snapshot.uptimeMs },
        snapshot.live ? 200 : 503,
      )
    }
    if (path === '/ready' || path === '/health') {
      return json(snapshot, snapshot.ready ? 200 : 503)
    }
    return json({ error: 'not_found' }, 404)
  }
}

export interface DurableHealthServerOptions {
  enabled: boolean
  host: '127.0.0.1' | '::1'
  port: number
}

export class DurableHealthServer {
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(
    private readonly health: DurableBridgeHealth,
    private readonly options: DurableHealthServerOptions,
  ) {}

  get boundPort(): number | null {
    return this.server?.port ?? null
  }

  start(): void {
    if (!this.options.enabled) return
    if (this.server !== null) throw new Error('durable health server is already started')
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      fetch: createHealthRequestHandler(this.health),
    })
  }

  stop(): void {
    this.server?.stop(true)
    this.server = null
  }
}

export interface SystemdNotifyResult {
  ok: boolean
  errorName?: string
}

export interface SystemdNotifier {
  notify(fields: readonly string[]): Promise<SystemdNotifyResult>
}

export interface CommandSystemdNotifierOptions {
  command?: string
  env?: NodeJS.ProcessEnv
}

export class CommandSystemdNotifier implements SystemdNotifier {
  private readonly command: string
  private readonly env: NodeJS.ProcessEnv

  constructor(options: CommandSystemdNotifierOptions = {}) {
    this.command = options.command ?? 'systemd-notify'
    this.env = options.env ?? process.env
  }

  async notify(fields: readonly string[]): Promise<SystemdNotifyResult> {
    const result = spawnSync(this.command, [...fields], {
      env: this.env,
      encoding: 'utf8',
      timeout: 5_000,
    })
    if (result.error !== undefined) return { ok: false, errorName: result.error.name }
    return result.status === 0
      ? { ok: true }
      : { ok: false, errorName: `ExitStatus${String(result.status)}` }
  }
}

export interface SystemdWatchdogOptions {
  env?: NodeJS.ProcessEnv
  pid?: number
  notifier?: SystemdNotifier
  onError?: (event: { operation: 'ready' | 'watchdog' | 'stopping'; errorName: string }) => void
}

/** Sends READY/WATCHDOG only when systemd activation is present and health is ready. */
export class SystemdWatchdog {
  private readonly env: NodeJS.ProcessEnv
  private readonly pid: number
  private readonly notifier: SystemdNotifier
  private readonly onError: SystemdWatchdogOptions['onError']
  private timer: ReturnType<typeof setInterval> | null = null
  private active = false
  private watchdogActive = false
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly health: DurableBridgeHealth,
    options: SystemdWatchdogOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.pid = options.pid ?? process.pid
    this.notifier = options.notifier ?? new CommandSystemdNotifier({ env: this.env })
    this.onError = options.onError
  }

  get enabled(): boolean {
    return Boolean(this.env.NOTIFY_SOCKET)
  }

  start(): void {
    if (!this.enabled || this.active) return
    this.active = true
    this.send('ready', ['--ready'])
    const intervalMs = this.watchdogIntervalMs()
    if (intervalMs === null) return
    this.watchdogActive = true
    this.timer = setInterval(() => {
      if (this.health.snapshot().ready) this.send('watchdog', ['WATCHDOG=1'])
    }, intervalMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.watchdogActive = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.send('stopping', ['--stopping'])
    await Promise.all([...this.pending])
  }

  pulse(): void {
    if (this.active && this.watchdogActive && this.health.snapshot().ready) {
      this.send('watchdog', ['WATCHDOG=1'])
    }
  }

  private watchdogIntervalMs(): number | null {
    const watchdogPid = this.env.WATCHDOG_PID?.trim()
    if (watchdogPid && watchdogPid !== String(this.pid)) return null
    const microseconds = Number(this.env.WATCHDOG_USEC)
    if (!Number.isSafeInteger(microseconds) || microseconds <= 0) return null
    return Math.max(50, Math.floor(microseconds / 2_000))
  }

  private send(
    operation: 'ready' | 'watchdog' | 'stopping',
    fields: readonly string[],
  ): void {
    let task: Promise<void>
    task = this.notifier.notify(fields).then((result) => {
      if (!result.ok) {
        try {
          this.onError?.({ operation, errorName: result.errorName ?? 'NotifyError' })
        } catch {
          // Diagnostics must not break the service lifecycle.
        }
      }
    }).catch((error: unknown) => {
      try {
        this.onError?.({
          operation,
          errorName: error instanceof Error ? error.name : 'NotifyError',
        })
      } catch {
        // Diagnostics must not break the service lifecycle.
      }
    }).finally(() => this.pending.delete(task))
    this.pending.add(task)
  }
}
