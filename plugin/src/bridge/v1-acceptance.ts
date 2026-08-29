import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  AgentModel,
  AgentTextTurnInput,
  AgentTurnLifecycle,
  TextTurnResult,
} from './contracts.js'
import { runBridgeDoctor } from './doctor.js'
import {
  DurableSessionCoordinator,
  StaticProjectResolver,
} from './durable-session-coordinator.js'
import { InboxProcessingWorker } from './inbox-processing-worker.js'
import { initializeBridgeInstallation } from './installation.js'
import { OutboxDeliveryWorker } from './outbox-delivery-worker.js'
import { loadBridgeServiceConfig } from './service-config.js'
import { openDurableDatabase } from '../durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../durable/sqlite-repositories.js'
import { SqliteSessionRepository } from '../durable/session-repository.js'
import {
  DurableTelegramTextGateway,
  type TelegramMessageOptions,
  type TelegramTextApi,
} from '../telegram/durable-text-gateway.js'

export interface V1AcceptanceReport {
  configInitialized: true
  doctorPassed: true
  updatesProcessed: 2
  deliveriesProven: 2
  threadPreservedAcrossRestart: true
  databaseQuickCheck: 'ok'
}

const BOT_ID = 'acceptance-bot'
const OWNER_ID = '7001'
const PROJECT_ID = 'main'
const THREAD_ID = 'acceptance-thread'

class AcceptanceBackend implements AgentBackend {
  readonly calls: AgentTextTurnInput[] = []

  constructor(private readonly sequence: number) {}

  async listModels(): Promise<AgentModel[]> { return [] }

  async runTextTurn(
    input: AgentTextTurnInput,
    lifecycle: AgentTurnLifecycle = {},
  ): Promise<TextTurnResult> {
    this.calls.push(input)
    const threadId = input.threadId ?? THREAD_ID
    const turnId = `acceptance-turn-${this.sequence}`
    await lifecycle.onThreadReady?.(threadId, input.threadId === null)
    await lifecycle.onTurnStarted?.(threadId, turnId)
    return { threadId, turnId, finalText: `acceptance response ${this.sequence}` }
  }

  async interruptTurn(): Promise<void> {}
  async steerTurn(): Promise<void> {}
}

class AcceptanceTelegram implements TelegramTextApi {
  readonly sent: Array<{ chatId: string; text: string }> = []
  private nextMessageId = 1

  async sendMessage(
    chatId: string,
    text: string,
    _options: TelegramMessageOptions,
  ): Promise<{ message_id: number }> {
    this.sent.push({ chatId, text })
    return { message_id: this.nextMessageId++ }
  }
}

interface PhaseResult {
  backendThreadId: string | null
  delivered: number
}

async function runPhase(
  database: Database,
  config: ReturnType<typeof loadBridgeServiceConfig>,
  sequence: number,
  nowMs: number,
): Promise<PhaseResult> {
  const inbox = new SqliteInboxRepository(database)
  const outbox = new SqliteOutboxRepository(database)
  const sessions = new SqliteSessionRepository(database)
  const backend = new AcceptanceBackend(sequence)
  const coordinator = new DurableSessionCoordinator(
    sessions,
    backend,
    new StaticProjectResolver(config.projects.map((project) => ({
      id: project.id,
      cwd: project.cwd,
      writableRoots: project.writableRoots,
      networkAccess: project.networkAccess,
      ...(project.sandboxMode === undefined ? {} : { sandboxMode: project.sandboxMode }),
    }))),
    { now: () => nowMs },
  )
  const api = new AcceptanceTelegram()
  const gateway = new DurableTelegramTextGateway(api, {
    allowedUserIds: config.telegram.allowedUserIds,
    allowedChatIds: config.telegram.allowedChatIds,
    defaultProjectId: config.defaultProjectId,
  })
  inbox.ingest({
    botId: BOT_ID,
    updateId: sequence,
    chatId: OWNER_ID,
    routingClass: 'MESSAGE',
    payload: {
      update_id: sequence,
      message: {
        chat: { id: Number(OWNER_ID), type: 'private' },
        from: { id: Number(OWNER_ID), is_bot: false },
        text: `acceptance request ${sequence}`,
      },
    },
    receivedAtMs: nowMs,
  })
  const inboxResult = await new InboxProcessingWorker(inbox, outbox, coordinator, gateway, {
    workerId: `acceptance-inbox-${sequence}`,
    now: () => nowMs,
  }).runOnce()
  if (inboxResult.outcome !== 'enqueued') {
    throw new Error(`acceptance inbox phase ${sequence} did not enqueue a delivery`)
  }

  const deliveryWorker = new OutboxDeliveryWorker(outbox, gateway, {
    workerId: `acceptance-outbox-${sequence}`,
    now: () => nowMs,
  })
  let delivered = 0
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await deliveryWorker.runOnce()
    if (result.outcome === 'idle') break
    if (result.outcome !== 'delivered') {
      throw new Error(`acceptance delivery phase ${sequence} became ${result.outcome}`)
    }
    delivered += 1
  }
  if (delivered !== 1 || api.sent.length !== 1) {
    throw new Error(`acceptance phase ${sequence} did not prove exactly one final delivery`)
  }
  const backendThreadId = backend.calls[0]?.threadId ?? null
  return { backendThreadId, delivered }
}

export async function runV1AcceptanceGate(): Promise<V1AcceptanceReport> {
  const root = mkdtempSync(join(tmpdir(), 'dashi-v1-acceptance-'))
  try {
    const projectPath = join(root, 'project')
    mkdirSync(projectPath)
    const installation = initializeBridgeInstallation({
      configDirectory: join(root, 'config'),
      stateDirectory: join(root, 'state'),
      projectPath,
      telegramUserId: OWNER_ID,
      telegramChatId: OWNER_ID,
      projectId: PROJECT_ID,
    })
    writeFileSync(installation.telegramCredentialPath, 'acceptance-not-a-real-token\n', {
      mode: 0o600,
    })
    const env = {
      DASHI_CODEX_BRIDGE_CONFIG: installation.configPath,
      DASHI_TELEGRAM_BOT_TOKEN_FILE: installation.telegramCredentialPath,
    }
    const config = loadBridgeServiceConfig({ env })
    const doctor = await runBridgeDoctor({
      env,
      runCommand: () => ({
        status: 0,
        stdout: 'codex-cli 0.149.1\n',
        stderr: '',
      }),
    })
    if (!doctor.ok) throw new Error('acceptance doctor failed')

    let first: PhaseResult
    let database = openDurableDatabase(config.stateDatabase)
    try {
      first = await runPhase(database, config, 1, 1_800_000_000_000)
    } finally {
      database.close()
    }
    if (first.backendThreadId !== null) {
      throw new Error('first acceptance phase unexpectedly resumed a thread')
    }

    database = openDurableDatabase(config.stateDatabase)
    try {
      const second = await runPhase(database, config, 2, 1_800_000_001_000)
      if (second.backendThreadId !== THREAD_ID) {
        throw new Error('follow-up did not resume the durable thread after restart')
      }
      const updates = database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM telegram_updates WHERE state = 'PROCESSED'",
      ).get()?.count ?? 0
      const delivered = database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM delivery_jobs WHERE state = 'DELIVERED' AND remote_id IS NOT NULL",
      ).get()?.count ?? 0
      const problems = database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM delivery_jobs WHERE state IN ('FAILED', 'EXPIRED', 'AMBIGUOUS')",
      ).get()?.count ?? 0
      const quickCheckRow = database.query<Record<string, string>, []>('PRAGMA quick_check').get()
      const quickCheck = quickCheckRow === null ? null : Object.values(quickCheckRow)[0]
      if (updates !== 2 || delivered !== 2 || problems !== 0 || quickCheck !== 'ok') {
        throw new Error('acceptance durable state verification failed')
      }
      return {
        configInitialized: true,
        doctorPassed: true,
        updatesProcessed: 2,
        deliveriesProven: 2,
        threadPreservedAcrossRestart: true,
        databaseQuickCheck: 'ok',
      }
    } finally {
      database.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
