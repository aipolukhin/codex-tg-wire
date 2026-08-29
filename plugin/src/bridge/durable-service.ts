import type { Database } from 'bun:sqlite'

import { Bot } from 'grammy'

import pkg from '../../package.json'
import { CodexAppServerClient } from '../codex/app-server-client.js'
import { openDurableDatabase } from '../durable/database.js'
import { SqlitePollCursorRepository } from '../durable/poll-cursor-repository.js'
import { DurableTelegramPoller } from '../telegram/durable-poller.js'
import { GrammyDurableAdapter } from '../telegram/grammy-durable-adapter.js'
import {
  DurableBridgeSupervisor,
  type DurableBridgeSupervisorOptions,
} from './durable-supervisor.js'
import { createDurableTextRuntime, type DurableTextRuntime } from './text-runtime.js'
import type { BridgeServiceConfig } from './service-config.js'

export interface DurableBridgeServiceLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
}

export interface DurableBridgeIdentity {
  botId: string
  botUsername: string
}

interface ClosableCodexClient {
  close(): Promise<void>
}

interface ClosableDatabase {
  close(): void
}

export class DurableBridgeService {
  private stopPromise: Promise<void> | null = null
  private started = false

  constructor(
    readonly identity: DurableBridgeIdentity,
    private readonly supervisor: DurableBridgeSupervisor,
    private readonly runtime: DurableTextRuntime,
    private readonly codexClient: ClosableCodexClient,
    private readonly database: ClosableDatabase,
  ) {}

  start(): void {
    if (this.stopPromise !== null) throw new Error('durable bridge service is stopped')
    if (this.started) throw new Error('durable bridge service is already started')
    this.supervisor.start()
    this.started = true
  }

  wait(): Promise<void> {
    return this.supervisor.wait()
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopResources()
    return this.stopPromise
  }

  private async stopResources(): Promise<void> {
    let firstError: unknown
    try {
      await this.supervisor.stop()
    } catch (error) {
      firstError = error
    }
    try {
      this.runtime.close()
    } catch (error) {
      firstError ??= error
    }
    try {
      await this.codexClient.close()
    } catch (error) {
      firstError ??= error
    }
    try {
      this.database.close()
    } catch (error) {
      firstError ??= error
    }
    if (firstError !== undefined) throw firstError
  }
}

export interface BootstrapDurableBridgeOptions {
  logger?: DurableBridgeServiceLogger
  signal?: AbortSignal
}

export async function bootstrapDurableBridgeService(
  config: BridgeServiceConfig,
  options: BootstrapDurableBridgeOptions = {},
): Promise<DurableBridgeService> {
  const bot = new Bot(config.telegramToken, {
    ...(config.telegram.apiRoot === undefined
      ? {}
      : { client: { apiRoot: config.telegram.apiRoot } }),
  })
  await bot.init(options.signal)
  const identity = {
    botId: String(bot.botInfo.id),
    botUsername: bot.botInfo.username,
  }

  let database: Database | undefined
  let codexClient: CodexAppServerClient | undefined
  let runtime: DurableTextRuntime | undefined
  try {
    database = openDurableDatabase(config.stateDatabase)
    codexClient = CodexAppServerClient.spawn({
      ...(config.codex.binary === undefined ? {} : { command: config.codex.binary }),
      ...(config.codex.args === undefined ? {} : { args: config.codex.args }),
      requestTimeoutMs: config.codex.requestTimeoutMs,
    })
    await codexClient.initialize({
      clientInfo: {
        name: 'dashi_codex_bridge',
        title: 'Dashi Codex Telegram Bridge',
        version: pkg.version,
      },
      capabilities: null,
    })

    const telegram = new GrammyDurableAdapter(bot.api)
    runtime = createDurableTextRuntime({
      database,
      codexClient,
      telegramApi: telegram,
      botId: identity.botId,
      projects: config.projects,
      telegram: {
        allowedUserIds: config.telegram.allowedUserIds,
        allowedChatIds: config.telegram.allowedChatIds,
        defaultProjectId: config.defaultProjectId,
        maxTextLength: config.telegram.maxTextLength,
        botUsername: identity.botUsername,
        extraSecrets: [config.telegramToken],
      },
      codex: {
        turnTimeoutMs: config.codex.turnTimeoutMs,
        interactionTimeoutMs: config.codex.interactionTimeoutMs,
        threadStartDefaults: {
          approvalPolicy: config.codex.approvalPolicy,
          sandbox: config.codex.sandboxMode,
        },
        threadResumeDefaults: {
          approvalPolicy: config.codex.approvalPolicy,
          sandbox: config.codex.sandboxMode,
        },
        allowedSandboxModes: config.codex.allowedSandboxModes,
        turnDefaults: { approvalPolicy: config.codex.approvalPolicy },
      },
      inboxWorker: { leaseDurationMs: config.workers.leaseDurationMs },
      outboxWorker: { leaseDurationMs: config.workers.leaseDurationMs },
    })
    const poller = new DurableTelegramPoller(
      identity.botId,
      telegram,
      runtime,
      new SqlitePollCursorRepository(database),
      { timeoutSeconds: config.telegram.pollingTimeoutSeconds },
    )
    const supervisorOptions: DurableBridgeSupervisorOptions = {
      inboundConcurrency: config.workers.inboundConcurrency,
      reaperIntervalMs: config.workers.reaperIntervalMs,
      onError: (event) => options.logger?.warn('durable loop failed', { ...event }),
    }
    const supervisor = new DurableBridgeSupervisor(poller, runtime, supervisorOptions)
    const service = new DurableBridgeService(identity, supervisor, runtime, codexClient, database)
    service.start()
    options.logger?.info('durable bridge started', {
      botId: identity.botId,
      botUsername: identity.botUsername,
      projects: config.projects.length,
    })
    return service
  } catch (error) {
    try {
      runtime?.close()
    } catch {
      // Preserve the startup error.
    }
    await codexClient?.close().catch(() => undefined)
    try {
      database?.close()
    } catch {
      // Preserve the startup error.
    }
    throw error
  }
}
