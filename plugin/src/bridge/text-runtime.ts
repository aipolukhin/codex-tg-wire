import type { Database } from 'bun:sqlite'

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
  TelegramUpdateInput,
  IngestResult,
  UpdateRoutingClass,
} from '../durable/contracts.js'
import { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import { SqliteAttachmentRepository } from '../durable/attachment-repository.js'
import { SqliteCodexEventRepository } from '../durable/codex-event-repository.js'
import { SqliteCodexInteractionRepository } from '../durable/interaction-repository.js'
import { DurableLeaseReaper, type LeaseRecoverySweep } from '../durable/lease-reaper.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../durable/session-repository.js'
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
  DurableSessionCoordinator,
  StaticProjectResolver,
  type ProjectDefinition,
} from './durable-session-coordinator.js'
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
import type { AgentApprovalPolicy, AgentSandboxMode } from './contracts.js'
import {
  StartupTurnRecovery,
  type TurnRecoverySweep,
} from './startup-recovery.js'

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
}

export interface DurableTextRuntime {
  ingest(update: unknown, receivedAtMs?: number): IngestResult
  processInboundOnce(): Promise<InboxRunResult>
  deliverOutboundOnce(): Promise<DeliveryRunResult>
  recoverExpiredLeases(): LeaseRecoverySweep
  recoverStartup(): Promise<{
    turns: TurnRecoverySweep
    interactions: CodexInteractionRecoverySweep
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

function telegramRoute(update: unknown): { chatId: string | null; routingClass: UpdateRoutingClass } {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    return { chatId: null, routingClass: 'OTHER' }
  }
  const value = update as {
    message?: {
      chat?: { id?: unknown }
      text?: unknown
      caption?: unknown
      photo?: unknown
      document?: unknown
    }
    callback_query?: { message?: { chat?: { id?: unknown } } }
  }
  const callbackChatId = value.callback_query?.message?.chat?.id
  if (callbackChatId !== undefined) {
    return { chatId: String(callbackChatId), routingClass: 'CONTROL' }
  }
  const chatId = value.message?.chat?.id
  if (chatId === undefined) return { chatId: null, routingClass: 'OTHER' }
  const hasAttachment = Array.isArray(value.message?.photo) ||
    (typeof value.message?.document === 'object' && value.message.document !== null)
  const messageText = value.message?.text
  if (typeof messageText !== 'string' && !hasAttachment) {
    return { chatId: String(chatId), routingClass: 'OTHER' }
  }
  return {
    chatId: String(chatId),
    routingClass: typeof messageText === 'string' && messageText.trimStart().startsWith('/')
      ? 'CONTROL'
      : 'MESSAGE',
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

  const inbox = new SqliteInboxRepository(options.database)
  const outbox = new SqliteOutboxRepository(options.database)
  const sessions = new SqliteSessionRepository(options.database)
  const settings = new SqliteAgentSettingsRepository(options.database)
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
  const interactionTimeoutMs = options.codex?.interactionTimeoutMs
  const backendOptions: CodexAppServerBackendOptions = {
    eventDiagnostics: new SqliteCodexEventRepository(options.database),
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
  const telegram = new DurableTelegramTextGateway(options.telegramApi, {
    ...options.telegram,
    ...(attachmentStore === undefined ? {} : { attachmentStore }),
    projectIdForChat: (chatId) => {
      const selected = settings.getSelectedProject(options.botId, chatId)
      return selected !== null && projectIds.has(selected)
        ? selected
        : options.telegram.defaultProjectId
    },
  })
  const coordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    new StaticProjectResolver(options.projects),
    { settingsProvider: settings },
  )
  const approvalDefault = options.codex?.turnDefaults?.approvalPolicy
  const sandboxDefault = options.codex?.threadStartDefaults?.sandbox
  const commands = new PersonalAlphaCommands(sessions, backend, outbox, settings, {
    projects: options.projects,
    defaultProjectId: options.telegram.defaultProjectId,
    defaultApprovalPolicy: typeof approvalDefault === 'string'
      ? approvalDefault as AgentApprovalPolicy
      : 'on-request',
    defaultSandbox: sandboxDefault ?? 'workspace-write',
    ...(options.codex?.allowedSandboxModes === undefined
      ? {}
      : { allowedSandboxModes: options.codex.allowedSandboxModes }),
  })
  const inbound = new InboxProcessingWorker(inbox, outbox, coordinator, telegram, {
    ...options.inboxWorker,
    workerId: options.inboxWorker?.workerId ?? 'inbox-1',
    commandHandler: commands,
    interactionHandler: interactions,
  })
  const outbound = new OutboxDeliveryWorker(outbox, telegram, {
    ...options.outboxWorker,
    workerId: options.outboxWorker?.workerId ?? 'outbox-1',
  })
  const reaper = new DurableLeaseReaper(inbox, outbox)
  const startupRecovery = new StartupTurnRecovery(sessions, inbox, outbox, backend)

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
      return inbox.ingest(input)
    },
    processInboundOnce: () => inbound.runOnce(),
    deliverOutboundOnce: () => outbound.runOnce(),
    recoverExpiredLeases: () => reaper.runOnce(),
    async recoverStartup() {
      const interactionSweep = interactions.recoverStartup()
      const turnSweep = await startupRecovery.run()
      return { turns: turnSweep, interactions: interactionSweep }
    },
    close(): void {
      interactions.close()
      backend.close()
    },
  }
}
