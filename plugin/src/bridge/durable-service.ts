import type { Database } from 'bun:sqlite'

import { Bot } from 'grammy'

import compatibility from '../../codex-app-server.compatibility.json'
import { CodexAppServerClient } from '../codex/app-server-client.js'
import { openDurableDatabase } from '../durable/database.js'
import { SqlitePollCursorRepository } from '../durable/poll-cursor-repository.js'
import { DurableTelegramPoller } from '../telegram/durable-poller.js'
import { GrammyDurableAdapter } from '../telegram/grammy-durable-adapter.js'
import {
  DurableBridgeSupervisor,
  type DurableBridgeSupervisorOptions,
} from './durable-supervisor.js'
import {
  DurableBridgeHealth,
  DurableHealthServer,
  SystemdWatchdog,
} from './health.js'
import { createDurableTextRuntime, type DurableTextRuntime } from './text-runtime.js'
import { GroqVoiceTranscriber } from '../telegram/durable-voice-transcriber.js'
import { DurableTelegramRateLimiter } from '../telegram/durable-rate-limiter.js'
import type { BridgeServiceConfig } from './service-config.js'
import {
  GroqCredentialManager,
  ManagedGroqVoiceTranscriber,
} from './voice-credentials.js'
import {
  ownerPrivateChatIds,
  registerOwnerScopedCommands,
} from '../telegram/command-scope.js'
import { PERSONAL_ALPHA_BOT_COMMANDS } from './personal-alpha-command-menu.js'

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

export interface DurableBridgeOperations {
  health?: DurableBridgeHealth
  healthServer?: DurableHealthServer
  watchdog?: SystemdWatchdog
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
    private readonly operations: DurableBridgeOperations = {},
  ) {}

  start(): void {
    if (this.stopPromise !== null) throw new Error('durable bridge service is stopped')
    if (this.started) throw new Error('durable bridge service is already started')
    try {
      this.operations.healthServer?.start()
      this.supervisor.start()
      this.operations.health?.markRunning()
      this.operations.watchdog?.start()
      this.started = true
    } catch (error) {
      this.operations.health?.markStopped()
      this.operations.healthServer?.stop()
      throw error
    }
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
    this.operations.health?.markStopping()
    try {
      await this.operations.watchdog?.stop()
    } catch (error) {
      firstError = error
    }
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
    this.operations.health?.markStopped()
    try {
      this.operations.healthServer?.stop()
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

  await registerOwnerScopedCommands(
    {
      deleteMyCommands: (commandOptions) => bot.api.deleteMyCommands(commandOptions),
      setMyCommands: (commands, commandOptions) =>
        bot.api.setMyCommands([...commands], commandOptions),
    },
    PERSONAL_ALPHA_BOT_COMMANDS,
    [...config.telegram.allowedUserIds, ...config.telegram.allowedChatIds],
    options.logger ?? { info() {}, warn() {} },
  )

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
        title: 'codex-tg-wire',
        version: compatibility.bridgeVersion,
      },
      capabilities: null,
    })

    const telegramLimiter = new DurableTelegramRateLimiter({
      ...config.telegram.rateLimit,
      onBackoff: (event) => options.logger?.warn('Telegram rate limit backoff', event),
    })
    const telegram = new GrammyDurableAdapter(
      bot.api,
      config.telegramToken,
      config.telegram.apiRoot,
      telegramLimiter,
    )
    const voiceCredentials = config.voice.provider === 'groq' && config.voiceCredentialPath !== null
      ? new GroqCredentialManager(config.voiceCredentialPath, {
          apiRoot: config.voice.apiRoot,
          requestTimeoutMs: Math.min(config.voice.requestTimeoutMs, 30_000),
        })
      : undefined
    const voiceOptions = {
      model: config.voice.model,
      language: config.voice.language,
      apiRoot: config.voice.apiRoot,
      maxBytes: config.voice.maxBytes,
      requestTimeoutMs: config.voice.requestTimeoutMs,
    }
    const voiceTranscriber = config.voice.provider !== 'groq'
      ? undefined
      : voiceCredentials !== undefined
        ? new ManagedGroqVoiceTranscriber(voiceCredentials, voiceOptions)
        : config.voiceApiKey !== null
          ? new GroqVoiceTranscriber({ ...voiceOptions, apiKey: config.voiceApiKey })
          : undefined
    runtime = createDurableTextRuntime({
      database,
      codexClient,
      telegramApi: telegram,
      botId: identity.botId,
      bridgeVersion: compatibility.bridgeVersion,
      codexVersion: compatibility.codexCliVersion,
      projects: config.projects.map((project) => ({
        id: project.id,
        cwd: project.cwd,
        writableRoots: project.writableRoots,
        networkAccess: project.networkAccess,
        ...(project.sandboxMode === undefined ? {} : { sandboxMode: project.sandboxMode }),
      })),
      telegram: {
        allowedUserIds: config.telegram.allowedUserIds,
        allowedChatIds: config.telegram.allowedChatIds,
        defaultProjectId: config.defaultProjectId,
        maxTextLength: config.telegram.maxTextLength,
        botUsername: identity.botUsername,
        extraSecrets: [
          config.telegramToken,
          ...(config.voiceApiKey === null ? [] : [config.voiceApiKey]),
        ],
        attachmentDirectory: config.attachments.directory,
        maxBytes: config.attachments.maxBytes,
        allowedMimeTypes: config.attachments.allowedMimeTypes,
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
      albumFlushMs: config.albums.flushMs,
      ...(voiceTranscriber === undefined ? {} : { voiceTranscriber }),
      ...(voiceCredentials === undefined ? {} : { voiceCredentials }),
      ux: {
        enabled: config.ux.enabled,
        chatStatusMessages: config.ux.chatStatusMessages,
        typingIndicator: config.ux.typingIndicator,
        receivedReaction: config.ux.receivedReaction,
        pinnedStatus: config.ux.pinnedStatus,
        typingRefreshMs: config.ux.typingRefreshMs,
        quotaRefreshMs: config.ux.quotaRefreshMs,
        heartbeatAfterMs: config.ux.heartbeatAfterMs,
        heartbeatIntervalMs: config.ux.heartbeatIntervalMs,
      },
      ...(config.outboundMedia.enabled
        ? {
            outboundMedia: {
              directory: config.outboundMedia.directory,
              allowedRoots: config.projects.map((project) => project.cwd),
              maxBytes: config.outboundMedia.maxBytes,
              allowedMimeTypes: config.outboundMedia.allowedMimeTypes,
            },
          }
        : {}),
      retention: {
        enabled: config.retention.enabled,
        payloadMaxAgeMs: config.retention.payloadMaxAgeDays * 24 * 60 * 60_000,
        intervalMs: config.retention.intervalMs,
        attachmentDirectory: config.attachments.directory,
        ...(config.outboundMedia.enabled
          ? { outboundMediaDirectory: config.outboundMedia.directory }
          : {}),
      },
    })
    const recovery = await runtime.recoverStartup()
    options.logger?.info('durable startup recovery completed', recovery)
    for (const chatId of ownerPrivateChatIds([
      ...config.telegram.allowedUserIds,
      ...config.telegram.allowedChatIds,
    ])) {
      await runtime.refreshNativeStatus(String(chatId))
    }
    const poller = new DurableTelegramPoller(
      identity.botId,
      telegram,
      runtime,
      new SqlitePollCursorRepository(database),
      { timeoutSeconds: config.telegram.pollingTimeoutSeconds },
    )
    const health = new DurableBridgeHealth({
      inboundConcurrency: config.workers.inboundConcurrency,
      startupGraceMs: config.health.startupGraceMs,
      staleAfterMs: config.health.staleAfterMs,
      maxConsecutiveErrors: config.health.maxConsecutiveErrors,
      databaseProbe: () => {
        try {
          return database?.query<{ value: number }, []>('SELECT 1 AS value').get()?.value === 1
        } catch {
          return false
        }
      },
    })
    const healthServer = new DurableHealthServer(health, {
      enabled: config.health.enabled,
      host: config.health.host,
      port: config.health.port,
    })
    const watchdog = new SystemdWatchdog(health, {
      onError: (event) => options.logger?.warn('systemd notification failed', event),
    })
    const supervisorOptions: DurableBridgeSupervisorOptions = {
      inboundConcurrency: config.workers.inboundConcurrency,
      reaperIntervalMs: config.workers.reaperIntervalMs,
      uxIntervalMs: config.ux.pollIntervalMs,
      onError: (event) => {
        health.recordError(event)
        options.logger?.warn('durable loop failed', { ...event })
      },
      onActivity: (event) => health.recordActivity(event),
    }
    const supervisor = new DurableBridgeSupervisor(poller, runtime, supervisorOptions)
    const service = new DurableBridgeService(identity, supervisor, runtime, codexClient, database, {
      health,
      healthServer,
      watchdog,
    })
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
