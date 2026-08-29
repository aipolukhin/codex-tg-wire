import type { Database } from 'bun:sqlite'

import type { CodexAppServerClient } from '../codex/app-server-client.js'
import {
  CodexAppServerBackend,
  type CodexAppServerBackendOptions,
} from '../codex/app-server-backend.js'
import { CodexInteractionBroker } from '../codex/interaction-broker.js'
import type { TelegramUpdateInput, IngestResult } from '../durable/contracts.js'
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

export interface DurableTextRuntimeOptions {
  database: Database
  codexClient: CodexAppServerClient
  telegramApi: TelegramTextApi
  botId: string
  projects: readonly ProjectDefinition[]
  telegram: DurableTelegramTextGatewayOptions
  codex?: CodexAppServerBackendOptions & { interactionTimeoutMs?: number }
  inboxWorker?: Omit<InboxProcessingWorkerOptions, 'workerId' | 'commandHandler'> & { workerId?: string }
  outboxWorker?: Omit<OutboxDeliveryWorkerOptions, 'workerId'> & { workerId?: string }
}

export interface DurableTextRuntime {
  ingest(update: unknown, receivedAtMs?: number): IngestResult
  processInboundOnce(): Promise<InboxRunResult>
  deliverOutboundOnce(): Promise<DeliveryRunResult>
  recoverExpiredLeases(): LeaseRecoverySweep
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
  const interactionTimeoutMs = options.codex?.interactionTimeoutMs
  const backendOptions: CodexAppServerBackendOptions = {
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
  const telegram = new DurableTelegramTextGateway(options.telegramApi, options.telegram)
  const coordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    new StaticProjectResolver(options.projects),
  )
  const commands = new PersonalAlphaCommands(sessions, backend)
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

  return {
    ingest(update: unknown, receivedAtMs = Date.now()): IngestResult {
      const input: TelegramUpdateInput = {
        botId: options.botId,
        updateId: telegramUpdateId(update),
        payload: update,
        receivedAtMs,
      }
      return inbox.ingest(input)
    },
    processInboundOnce: () => inbound.runOnce(),
    deliverOutboundOnce: () => outbound.runOnce(),
    recoverExpiredLeases: () => reaper.runOnce(),
    close(): void {
      interactions.close()
      backend.close()
    },
  }
}
