import type { Database } from 'bun:sqlite'
import { dirname } from 'node:path'

import type { CodexAppServerClient } from '../codex/app-server-client.js'
import {
  CodexAppServerBackend,
  type CodexAppServerBackendOptions,
} from '../codex/app-server-backend.js'
import {
  CodexInteractionBroker,
  type CodexInteractionRecoverySweep,
} from '../codex/interaction-broker.js'
import type {
  EnqueueResult,
  TelegramUpdateInput,
  IngestResult,
  UpdateRoutingClass,
} from '../durable/contracts.js'
import { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import { SqliteAttachmentRepository } from '../durable/attachment-repository.js'
import { SqliteCodexEventRepository } from '../durable/codex-event-repository.js'
import { SqliteCodexArtifactRepository } from '../durable/codex-artifact-repository.js'
import { SqliteControlInteractionRepository } from '../durable/control-interaction-repository.js'
import { SqliteTelegramMessageRouteRepository } from '../durable/message-route-repository.js'
import { SqliteCodexInteractionRepository } from '../durable/interaction-repository.js'
import { DurableLeaseReaper, type LeaseRecoverySweep } from '../durable/lease-reaper.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../durable/session-repository.js'
import { DurableDataRetention } from '../durable/retention.js'
import {
  DurableTelegramTextGateway,
  type DurableTelegramTextGatewayOptions,
  type TelegramTextApi,
} from '../telegram/durable-text-gateway.js'
import {
  DurableAttachmentStore,
  type DurableAttachmentStoreOptions,
} from '../telegram/durable-attachment-store.js'
import {
  DurableOutboundMediaStore,
  type DurableOutboundMediaOptions,
  type TelegramAlbumMediaKind,
  type TelegramMediaKind,
} from '../telegram/durable-outbound-media.js'
import type { VoiceTranscriber } from '../telegram/durable-voice-transcriber.js'
import {
  DurableSessionCoordinator,
  type ProjectDefinition,
} from './durable-session-coordinator.js'
import { DurableProjectCatalog } from './durable-project-catalog.js'
import { DurableTurnUxProjector, type DurableTurnUxOptions } from './durable-turn-ux.js'
import { DurableTurnPlanCards } from './durable-turn-plan-cards.js'
import {
  TelegramNativeTurnUx,
  type TelegramNativeTurnUxOptions,
} from './telegram-native-ux.js'
import {
  InboxProcessingWorker,
  type InboxProcessingWorkerOptions,
  type InboxRunResult,
} from './inbox-processing-worker.js'
import {
  OutboxDeliveryWorker,
  type DeliveryRunResult,
  type OutboxDeliveryWorkerOptions,
} from './outbox-delivery-worker.js'
import { PersonalAlphaCommands } from './personal-alpha-commands.js'
import { M65SessionCoordinator } from './m65-session-coordinator.js'
import { M65InteractionHandler } from './m65-interaction-handler.js'
import { GitWorkspaceControl } from './git-workspace-control.js'
import type {
  AgentApprovalPolicy,
  AgentSandboxMode,
  AgentTurnUxObserver,
} from './contracts.js'
import {
  StartupTurnRecovery,
  type TurnRecoverySweep,
} from './startup-recovery.js'
import type { VoiceCredentialControl } from './voice-credentials.js'

export interface DurableTextRuntimeOptions {
  database: Database
  codexClient: CodexAppServerClient
  telegramApi: TelegramTextApi
  botId: string
  projects: readonly ProjectDefinition[]
  telegram: DurableTelegramTextGatewayOptions
    & Partial<Omit<DurableAttachmentStoreOptions, 'directory'>>
    & { attachmentDirectory?: string }
  codex?: CodexAppServerBackendOptions & {
    interactionTimeoutMs?: number
    allowedSandboxModes?: readonly AgentSandboxMode[]
  }
  inboxWorker?: Omit<InboxProcessingWorkerOptions, 'workerId' | 'commandHandler'> & { workerId?: string }
  outboxWorker?: Omit<OutboxDeliveryWorkerOptions, 'workerId'> & { workerId?: string }
  ux?: DurableTurnUxOptions & TelegramNativeTurnUxOptions & {
    receivedReaction?: boolean
  }
  outboundMedia?: Omit<DurableOutboundMediaOptions, 'allowedRoots'> & {
    allowedRoots?: readonly string[]
  }
  albumFlushMs?: number
  voiceTranscriber?: VoiceTranscriber
  voiceCredentials?: VoiceCredentialControl
  bridgeVersion?: string
  codexVersion?: string
  retention?: {
    enabled: boolean
    payloadMaxAgeMs: number
    intervalMs: number
    attachmentDirectory?: string
    outboundMediaDirectory?: string
  }
}

export interface EnqueueOutboundMediaInput {
  sourceKey: string
  chatId: string
  path: string
  fileName?: string
  mimeType: string
  kind: TelegramMediaKind
  caption?: string
  createdAtMs?: number
}

export interface EnqueueOutboundAlbumInput {
  sourceKey: string
  chatId: string
  items: readonly {
    path: string
    fileName?: string
    mimeType: string
    kind: TelegramAlbumMediaKind
    caption?: string
  }[]
  createdAtMs?: number
}

export interface DurableTextRuntime {
  ingest(update: unknown, receivedAtMs?: number): IngestResult
  processInboundOnce(): Promise<InboxRunResult>
  deliverOutboundOnce(): Promise<DeliveryRunResult>
  recoverExpiredLeases(): LeaseRecoverySweep
  runUxHeartbeat(): number
  refreshNativeStatus(chatId: string): Promise<void>
  enqueueOutboundMedia(input: EnqueueOutboundMediaInput): Promise<EnqueueResult>
  enqueueOutboundAlbum(input: EnqueueOutboundAlbumInput): Promise<EnqueueResult>
  recoverStartup(): Promise<{
    turns: TurnRecoverySweep
    interactions: CodexInteractionRecoverySweep
    uxRecovered: number
  }>
  close(): void
}

function telegramUpdateId(update: unknown): number {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    throw new TypeError('Telegram update must be an object')
  }
  const updateId = (update as { update_id?: unknown }).update_id
  if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
    throw new TypeError('Telegram update_id must be a non-negative safe integer')
  }
  return updateId as number
}

function telegramRoute(update: unknown): {
  chatId: string | null
  routingClass: UpdateRoutingClass
  mediaGroupId: string | null
  messageId: number | null
  senderId: string | null
  chatType: string | null
} {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return {
      chatId: null,
      routingClass: 'OTHER',
      mediaGroupId: null,
      messageId: null,
      senderId: null,
      chatType: null,
    }
  }
  const value = update as {
    message?: {
      message_id?: unknown
      chat?: { id?: unknown; type?: unknown }
      from?: { id?: unknown }
      text?: unknown
      caption?: unknown
      photo?: unknown
      document?: unknown
      voice?: unknown
      audio?: unknown
      video?: unknown
      media_group_id?: unknown
    }
    callback_query?: { message?: { chat?: { id?: unknown } } }
  }
  const callbackChatId = value.callback_query?.message?.chat?.id
  if (callbackChatId !== undefined) {
    return {
      chatId: String(callbackChatId),
      routingClass: 'CONTROL',
      mediaGroupId: null,
      messageId: null,
      senderId: null,
      chatType: null,
    }
  }
  const chatId = value.message?.chat?.id
  if (chatId === undefined) {
    return {
      chatId: null,
      routingClass: 'OTHER',
      mediaGroupId: null,
      messageId: null,
      senderId: null,
      chatType: null,
    }
  }
  const rawMessageId = value.message?.message_id
  const messageId = Number.isSafeInteger(rawMessageId) && (rawMessageId as number) > 0
    ? rawMessageId as number
    : null
  const senderId = value.message?.from?.id === undefined
    ? null
    : String(value.message.from.id)
  const chatType = typeof value.message?.chat?.type === 'string'
    ? value.message.chat.type
    : null
  const hasAttachment = Array.isArray(value.message?.photo) ||
    (typeof value.message?.document === 'object' && value.message.document !== null) ||
    (typeof value.message?.voice === 'object' && value.message.voice !== null) ||
    (typeof value.message?.audio === 'object' && value.message.audio !== null) ||
    (typeof value.message?.video === 'object' && value.message.video !== null)
  const messageText = value.message?.text
  if (typeof messageText !== 'string' && !hasAttachment) {
    return {
      chatId: String(chatId),
      routingClass: 'OTHER',
      mediaGroupId: null,
      messageId,
      senderId,
      chatType,
    }
  }
  const rawMediaGroupId = value.message?.media_group_id
  const mediaGroupId = typeof rawMediaGroupId === 'string' && rawMediaGroupId.trim().length > 0
    ? rawMediaGroupId.trim().slice(0, 256)
    : null
  return {
    chatId: String(chatId),
    routingClass: typeof messageText === 'string' && messageText.trimStart().startsWith('/')
      ? 'CONTROL'
      : 'MESSAGE',
    mediaGroupId,
    messageId,
    senderId,
    chatType,
  }
}

export function createDurableTextRuntime(options: DurableTextRuntimeOptions): DurableTextRuntime {
  if (options.botId.trim().length === 0) throw new TypeError('botId must not be empty')
  if (options.projects.length === 0) throw new TypeError('at least one project is required')
  const projectIds = new Set<string>()
  for (const project of options.projects) {
    if (project.id.trim().length === 0 || project.cwd.trim().length === 0) {
      throw new TypeError('project id and cwd must not be empty')
    }
    if (projectIds.has(project.id)) throw new TypeError(`duplicate project id: ${project.id}`)
    projectIds.add(project.id)
  }
  if (!projectIds.has(options.telegram.defaultProjectId)) {
    throw new TypeError(
      `default Telegram project is not configured: ${options.telegram.defaultProjectId}`,
    )
  }
  const albumFlushMs = options.albumFlushMs ?? 2_000
  if (!Number.isSafeInteger(albumFlushMs) || albumFlushMs < 100 || albumFlushMs > 60_000) {
    throw new TypeError('albumFlushMs must be a safe integer between 100 and 60000')
  }

  const inbox = new SqliteInboxRepository(options.database)
  const outbox = new SqliteOutboxRepository(options.database)
  const sessions = new SqliteSessionRepository(options.database)
  const settings = new SqliteAgentSettingsRepository(options.database)
  const approvalDefault = options.codex?.turnDefaults?.approvalPolicy
  const sandboxDefault = options.codex?.threadStartDefaults?.sandbox
  const configuredDefault = options.projects.find(
    (project) => project.id === options.telegram.defaultProjectId,
  )
  if (configuredDefault === undefined) throw new TypeError('default project disappeared')
  const projectCatalog = new DurableProjectCatalog(options.database, {
    staticProjects: options.projects,
    dynamicRegistrationEnabled:
      approvalDefault === 'never' && sandboxDefault === 'danger-full-access',
    discoveryRoots: [...new Set(options.projects.map((project) => dirname(project.cwd)))],
    dynamicDefaults: {
      sandboxMode: configuredDefault.sandboxMode ?? sandboxDefault ?? 'workspace-write',
      writableRoots: configuredDefault.writableRoots ?? [],
      networkAccess: configuredDefault.networkAccess ?? false,
    },
  })
  const controls = new SqliteControlInteractionRepository(options.database)
  const messageRoutes = new SqliteTelegramMessageRouteRepository(options.database)
  const attachmentStore = options.telegram.attachmentDirectory === undefined
    ? undefined
    : options.telegramApi.downloadAttachment === undefined
      ? undefined
      : new DurableAttachmentStore(
          { downloadAttachment: options.telegramApi.downloadAttachment.bind(options.telegramApi) },
          new SqliteAttachmentRepository(options.database),
          {
            directory: options.telegram.attachmentDirectory,
            ...(options.telegram.maxBytes === undefined
              ? {}
              : { maxBytes: options.telegram.maxBytes }),
            ...(options.telegram.allowedMimeTypes === undefined
              ? {}
              : { allowedMimeTypes: options.telegram.allowedMimeTypes }),
          },
        )
  const outboundMediaStore = options.outboundMedia === undefined
    ? undefined
    : new DurableOutboundMediaStore({
        ...options.outboundMedia,
        allowedRoots: options.outboundMedia.allowedRoots ?? options.projects.map((project) => project.cwd),
        allowedRootsProvider: () => projectCatalog.list().map((project) => project.cwd),
      })
  const interactionTimeoutMs = options.codex?.interactionTimeoutMs
  const backendOptions: CodexAppServerBackendOptions = {
    eventDiagnostics: new SqliteCodexEventRepository(options.database),
    artifactStore: new SqliteCodexArtifactRepository(options.database),
    ...(options.codex?.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.codex.turnTimeoutMs }),
    ...(options.codex?.threadStartDefaults === undefined
      ? {}
      : { threadStartDefaults: options.codex.threadStartDefaults }),
    ...(options.codex?.threadResumeDefaults === undefined
      ? {}
      : { threadResumeDefaults: options.codex.threadResumeDefaults }),
    ...(options.codex?.turnDefaults === undefined ? {} : { turnDefaults: options.codex.turnDefaults }),
  }
  const backend = new CodexAppServerBackend(options.codexClient, backendOptions)
  const interactions = new CodexInteractionBroker(
    options.codexClient,
    new SqliteCodexInteractionRepository(options.database),
    sessions,
    outbox,
    interactionTimeoutMs === undefined ? {} : { interactionTimeoutMs },
  )
  const ux = new DurableTurnUxProjector(options.database, outbox, sessions, options.ux)
  const planCards = new DurableTurnPlanCards(
    options.database,
    outbox,
    sessions,
    backend,
  )
  const nativeUx = new TelegramNativeTurnUx(
    options.database,
    options.telegramApi,
    backend,
    ux,
    options.botId,
    {
      ...options.ux,
      projectCwd: (projectId) => projectCatalog.resolve(projectId)?.cwd,
      settingsForChat: (chatId, projectId) => {
        const current = settings.getProjectSettings(options.botId, chatId, projectId)
        return current === null
          ? null
          : {
              ...(current.model === null ? {} : { model: current.model }),
              ...(current.effort === null ? {} : { effort: current.effort }),
            }
      },
    },
  )
  // Persist telemetry first; the native projection then reads the new snapshot.
  const uxObserver: AgentTurnUxObserver = {
    onPreparing(operation, turnSettings) {
      ux.onPreparing(operation, turnSettings)
      planCards.onPreparing(operation, turnSettings)
      nativeUx.onPreparing(operation, turnSettings)
    },
    onThreadReady(operation, threadId) {
      ux.onThreadReady(operation, threadId)
      planCards.onThreadReady(operation, threadId)
      nativeUx.onThreadReady(operation, threadId)
    },
    onTurnStarted(operation, threadId, turnId) {
      ux.onTurnStarted(operation, threadId, turnId)
      planCards.onTurnStarted(operation, threadId, turnId)
      nativeUx.onTurnStarted(operation, threadId, turnId)
    },
    onProgress(operation, progress) {
      ux.onProgress(operation, progress)
      planCards.onProgress(operation, progress)
      nativeUx.onProgress(operation, progress)
    },
    onCompleted(operation, result) {
      ux.onCompleted(operation, result)
      planCards.onCompleted(operation, result)
      nativeUx.onCompleted(operation, result)
    },
    onTerminal(operation, state, errorName) {
      ux.onTerminal(operation, state, errorName)
      planCards.onTerminal(operation, state, errorName)
      nativeUx.onTerminal(operation, state, errorName)
    },
  }
  const projectIdForChat = (chatId: string): string => {
    const selected = settings.getSelectedProject(options.botId, chatId)
    return selected !== null && projectCatalog.resolve(selected) !== null
      ? selected
      : options.telegram.defaultProjectId
  }
  const telegram = new DurableTelegramTextGateway(options.telegramApi, {
    ...options.telegram,
    ...(attachmentStore === undefined ? {} : { attachmentStore }),
    projectIdForChat,
    deliveryProofForSourceKey: (sourceKey) =>
      outbox.getBySourceKey(sourceKey)?.remoteId ?? null,
    ...(outboundMediaStore === undefined ? {} : { outboundMediaStore }),
    albumSource: inbox,
    ...(options.voiceTranscriber === undefined ? {} : { voiceTranscriber: options.voiceTranscriber }),
    messageRoutes,
  })
  const baseCoordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    projectCatalog,
    { settingsProvider: settings, uxObserver },
  )
  const coordinator = new M65SessionCoordinator(
    baseCoordinator,
    sessions,
    settings,
    controls,
    backend,
  )
  const commands = new PersonalAlphaCommands(sessions, backend, outbox, settings, {
    projects: options.projects,
    projectCatalog,
    defaultProjectId: options.telegram.defaultProjectId,
    defaultApprovalPolicy: typeof approvalDefault === 'string'
      ? approvalDefault as AgentApprovalPolicy
      : 'on-request',
    defaultSandbox: sandboxDefault ?? 'workspace-write',
    ...(options.codex?.allowedSandboxModes === undefined
      ? {}
      : { allowedSandboxModes: options.codex.allowedSandboxModes }),
    uxStatus: ux,
    ...(options.bridgeVersion === undefined ? {} : { bridgeVersion: options.bridgeVersion }),
    ...(options.codexVersion === undefined ? {} : { codexVersion: options.codexVersion }),
    ...(outboundMediaStore === undefined ? {} : { outboundMediaStore }),
    ...(options.voiceCredentials === undefined ? {} : { voiceCredentials: options.voiceCredentials }),
  })
  const gitWorkspace = new GitWorkspaceControl(projectCatalog, { turnDiffProvider: backend })
  const featureInteractions = new M65InteractionHandler(
    interactions,
    controls,
    sessions,
    settings,
    backend,
    baseCoordinator,
    commands,
    outbox,
    telegram,
    options.telegram.defaultProjectId,
    gitWorkspace,
    Date.now,
    planCards,
  )
  const inbound = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
    ...options.inboxWorker,
    workerId: options.inboxWorker?.workerId ?? 'inbox-1',
    commandHandler: commands,
    interactionHandler: featureInteractions,
    turnCompletionReporter: gitWorkspace,
  })
  const outbound = new OutboxDeliveryWorker(outbox, telegram, {
    ...options.outboxWorker,
    workerId: options.outboxWorker?.workerId ?? 'outbox-1',
  })
  const reaper = new DurableLeaseReaper(inbox, outbox)
  const retention = options.retention?.enabled === true
    ? new DurableDataRetention(options.database, {
        payloadMaxAgeMs: options.retention.payloadMaxAgeMs,
        intervalMs: options.retention.intervalMs,
        ...(options.retention.attachmentDirectory === undefined
          ? {}
          : { attachmentDirectory: options.retention.attachmentDirectory }),
        ...(options.retention.outboundMediaDirectory === undefined
          ? {}
          : { outboundMediaDirectory: options.retention.outboundMediaDirectory }),
      })
    : undefined
  const startupRecovery = new StartupTurnRecovery(sessions, inbox, outbox, backend)
  const allowedUsers = new Set(options.telegram.allowedUserIds.map(String))
  const allowedChats = new Set(options.telegram.allowedChatIds.map(String))
  const receivedReaction = options.ux?.enabled !== false &&
    (options.ux?.receivedReaction ?? false)

  return {
    ingest(update: unknown, receivedAtMs = Date.now()): IngestResult {
      const route = telegramRoute(update)
      const input: TelegramUpdateInput = {
        botId: options.botId,
        updateId: telegramUpdateId(update),
        chatId: route.chatId,
        routingClass: route.routingClass,
        payload: update,
        receivedAtMs,
      }
      const result = inbox.ingest(input)
      if (
        receivedReaction &&
        options.telegramApi.setMessageReaction !== undefined &&
        route.routingClass === 'MESSAGE' &&
        route.chatType === 'private' &&
        route.chatId !== null &&
        route.messageId !== null &&
        route.senderId !== null &&
        allowedChats.has(route.chatId) &&
        allowedUsers.has(route.senderId)
      ) {
        // Like Telemax receipts: acknowledgement is useful, but never part of delivery correctness.
        void options.telegramApi
          .setMessageReaction(route.chatId, route.messageId, '👀')
          .catch(() => undefined)
      }
      if (result.created && route.mediaGroupId !== null && route.routingClass === 'MESSAGE') {
        inbox.registerAlbumFragment({
          updateRowId: result.update.id,
          mediaGroupId: route.mediaGroupId,
          readyAtMs: receivedAtMs + albumFlushMs,
          nowMs: receivedAtMs,
        })
      }
      return result
    },
    processInboundOnce: () => inbound.runOnce(),
    deliverOutboundOnce: () => outbound.runOnce(),
    recoverExpiredLeases: () => {
      const sweep = reaper.runOnce()
      retention?.runIfDue()
      return sweep
    },
    runUxHeartbeat: () => ux.runHeartbeat() + nativeUx.runHeartbeat(),
    refreshNativeStatus: (chatId) => nativeUx.refreshChat(chatId, projectIdForChat(chatId), true),
    async enqueueOutboundMedia(input) {
      if (outboundMediaStore === undefined) throw new Error('outbound media is not configured')
      const reference = await outboundMediaStore.register(input)
      return outbox.enqueue({
        sourceKey: input.sourceKey,
        kind: 'send_media',
        payload: {
          chatId: input.chatId,
          mediaKind: input.kind,
          reference,
          ...(input.caption === undefined ? {} : { caption: input.caption }),
        },
        ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
      })
    },
    async enqueueOutboundAlbum(input) {
      if (outboundMediaStore === undefined) throw new Error('outbound media is not configured')
      if (input.items.length < 2 || input.items.length > 10) {
        throw new TypeError('outbound album must contain 2 to 10 items')
      }
      const items = await Promise.all(input.items.map(async (item) => ({
        mediaKind: item.kind,
        reference: await outboundMediaStore.register(item),
        ...(item.caption === undefined ? {} : { caption: item.caption }),
      })))
      return outbox.enqueue({
        sourceKey: input.sourceKey,
        kind: 'send_album',
        payload: { chatId: input.chatId, items },
        ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs }),
      })
    },
    async recoverStartup() {
      const interactionSweep = interactions.recoverStartup()
      const turnSweep = await startupRecovery.run()
      const uxRecovered = ux.recoverStartup() + await planCards.recoverStartup()
      return { turns: turnSweep, interactions: interactionSweep, uxRecovered }
    },
    close(): void {
      nativeUx.close()
      interactions.close()
      backend.close()
    },
  }
}
