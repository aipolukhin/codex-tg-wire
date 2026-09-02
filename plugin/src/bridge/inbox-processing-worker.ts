import type {
  DeliveryJobInput,
  InboxRepository,
  InboxUpdate,
  OutboxRepository,
} from '../durable/contracts.js'
import type {
  CommandHandler,
  InteractionHandler,
  PreparedIncomingMessage,
  SessionCoordinator,
  TelegramGateway,
  TextTurnResult,
  TurnCompletionReporter,
} from './contracts.js'
import {
  exponentialRetryPolicy,
  safeErrorSummary,
  type RetryPolicy,
} from './retry-policy.js'
import { LeaseHeartbeatError, withLeaseHeartbeat } from './lease-heartbeat.js'
import {
  isDefiniteTurnError,
  TurnQueuedBehindTurnError,
  TurnRecoveryRequiredError,
} from './durable-session-coordinator.js'

export type InboxRunResult =
  | { outcome: 'idle' }
  | { outcome: 'ignored'; updateId: number }
  | { outcome: 'enqueued'; updateId: number; deliveryJobId: string }
  | { outcome: 'retry_wait'; updateId: number; retryAtMs: number }
  | { outcome: 'queued'; updateId: number; retryAtMs: number; localTurnId: string }
  | { outcome: 'failed'; updateId: number }

export interface InboxProcessingWorkerOptions {
  workerId: string
  leaseDurationMs?: number
  leaseHeartbeatMs?: number
  retryPolicy?: RetryPolicy
  now?: () => number
  errorSummary?: (error: unknown) => string
  commandHandler?: CommandHandler
  interactionHandler?: InteractionHandler
  turnCompletionReporter?: TurnCompletionReporter
  queuePollMs?: number
}

const DEFAULT_LEASE_MS = 60_000

function operationKey(update: InboxUpdate): string {
  return `telegram:${encodeURIComponent(update.botId)}:${update.updateId}:turn`
}

function terminalTurnNotice(error: unknown): string | null {
  if (error instanceof TurnRecoveryRequiredError) {
    if (error.state === 'INTERRUPTED') {
      return '⏹ Предыдущий turn был остановлен. Контекст thread сохранён — отправь «продолжай» или начни новый через /new.'
    }
    if (error.state === 'FAILED') {
      return '⚠️ Codex завершил предыдущий turn с ошибкой. Контекст thread сохранён — повтори запрос или начни новый через /new.'
    }
    return '⚠️ Состояние предыдущего turn нельзя надёжно определить, поэтому мост не стал повторять запрос и рисковать двойным выполнением. Проверь результат и используй /new force, если нужен новый thread.'
  }
  if (error instanceof Error && error.name === 'CodexTurnTimeoutError') {
    if (isDefiniteTurnError(error)) {
      return '⏱ Codex не завершил turn за отведённое время и был остановлен. Контекст thread сохранён — отправь «продолжай», чтобы продолжить.'
    }
    return '⚠️ Истёк настроенный timeout до получения turn ID. Мост не может доказать результат и не будет повторять запрос автоматически.'
  }
  if (!isDefiniteTurnError(error)) return null
  if (error.agentTurnState === 'INTERRUPTED') {
    return '⏹ Turn был остановлен. Контекст thread сохранён — отправь «продолжай» или начни новый через /new.'
  }
  if (
    error instanceof Error &&
    'retryable' in error && error.retryable === true &&
    'failureCode' in error && error.failureCode === 'serverOverloaded'
  ) {
    return '⚠️ Модель всё ещё перегружена после автоматических попыток. Прогресс сохранён в thread — отправь «продолжай», и Codex сначала проверит текущее состояние.'
  }
  return '⚠️ Codex завершил turn с ошибкой. Контекст thread сохранён — повтори запрос или начни новый через /new.'
}

export class InboxProcessingWorker {
  private readonly workerId: string
  private readonly leaseDurationMs: number
  private readonly leaseHeartbeatMs: number
  private readonly retryPolicy: RetryPolicy
  private readonly now: () => number
  private readonly errorSummary: (error: unknown) => string
  private readonly commandHandler: CommandHandler | undefined
  private readonly interactionHandler: InteractionHandler | undefined
  private readonly turnCompletionReporter: TurnCompletionReporter | undefined
  private readonly queuePollMs: number

  constructor(
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly coordinator: SessionCoordinator,
    private readonly telegram: TelegramGateway,
    options: InboxProcessingWorkerOptions,
  ) {
    this.workerId = options.workerId
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.leaseDurationMs / 3))
    this.retryPolicy = options.retryPolicy ?? exponentialRetryPolicy()
    this.now = options.now ?? Date.now
    this.errorSummary = options.errorSummary ?? safeErrorSummary
    this.commandHandler = options.commandHandler
    this.interactionHandler = options.interactionHandler
    this.turnCompletionReporter = options.turnCompletionReporter
    this.queuePollMs = options.queuePollMs ?? 500
    if (
      !Number.isSafeInteger(this.leaseHeartbeatMs) ||
      this.leaseHeartbeatMs <= 0 ||
      this.leaseHeartbeatMs > this.leaseDurationMs
    ) {
      throw new TypeError('leaseHeartbeatMs must be positive and no greater than leaseDurationMs')
    }
    if (!Number.isSafeInteger(this.queuePollMs) || this.queuePollMs <= 0) {
      throw new TypeError('queuePollMs must be a positive safe integer')
    }
  }

  async runOnce(): Promise<InboxRunResult> {
    const claimedAtMs = this.now()
    const update = this.inbox.claimNext({
      workerId: this.workerId,
      nowMs: claimedAtMs,
      leaseDurationMs: this.leaseDurationMs,
    })
    if (update === null) return { outcome: 'idle' }

    try {
      return await withLeaseHeartbeat(
        {
          intervalMs: this.leaseHeartbeatMs,
          renew: () => {
            this.inbox.renewLease(update.id, {
              workerId: this.workerId,
              nowMs: this.now(),
              leaseDurationMs: this.leaseDurationMs,
            })
          },
        },
        () => this.processClaimed(update),
      )
    } catch (error) {
      if (error instanceof LeaseHeartbeatError) throw error
      if (error instanceof TurnQueuedBehindTurnError) {
        const retryAtMs = this.now() + this.queuePollMs
        this.inbox.deferQueued(update.id, this.workerId, retryAtMs)
        return {
          outcome: 'queued',
          updateId: update.id,
          retryAtMs,
          localTurnId: error.localTurnId,
        }
      }
      return this.handleFailure(update, error)
    }
  }

  private async processClaimed(update: InboxUpdate): Promise<InboxRunResult> {
    const interaction = this.telegram.extractInteractionResponse?.(update) ?? null
    if (interaction !== null && this.interactionHandler !== undefined) {
      const result = await this.interactionHandler.handleInteraction({
        operationKey: `${operationKey(update)}:interaction`,
        botId: update.botId,
        inboxUpdateId: update.id,
        updateId: update.updateId,
        response: interaction,
      })
      this.inbox.markProcessed(update.id, this.workerId, this.now())
      if (result.deliveryJobId === null) return { outcome: 'ignored', updateId: update.id }
      return { outcome: 'enqueued', updateId: update.id, deliveryJobId: result.deliveryJobId }
    }

    const command = this.telegram.extractCommand?.(update) ?? null
    if (command !== null && this.commandHandler !== undefined) {
      const commandKey = `${operationKey(update)}:command:${command.name}`
      const result = await this.commandHandler.handleCommand({
        operationKey: commandKey,
        botId: update.botId,
        inboxUpdateId: update.id,
        updateId: update.updateId,
        command,
      })
      const completedAtMs = this.now()
      if (result.sensitiveInput === true) {
        if (this.inbox.scrubPayload === undefined) {
          throw new Error('Inbox repository cannot scrub a sensitive command')
        }
        this.inbox.scrubPayload(update.id, this.workerId)
      }
      const buildDelivery = this.telegram.buildCommandDelivery
      if (buildDelivery === undefined) {
        throw new Error('Telegram gateway cannot build command replies')
      }
      if (result.deleteSourceMessage === true) {
        const buildCleanup = this.telegram.buildCommandCleanupDelivery
        if (buildCleanup === undefined) {
          throw new Error('Telegram gateway cannot delete a sensitive command')
        }
        this.outbox.enqueue(buildCleanup.call(this.telegram, {
          update,
          command,
          result,
          sourceKey: `${commandKey}:reply`,
          nowMs: completedAtMs,
        }))
      }
      const enqueue = this.outbox.enqueue({
        ...buildDelivery.call(this.telegram, {
          update,
          command,
          result,
          sourceKey: `${commandKey}:reply`,
          nowMs: completedAtMs,
        }),
        sourceKey: `${commandKey}:reply`,
        createdAtMs: completedAtMs,
      })
      this.inbox.markProcessed(update.id, this.workerId, completedAtMs)
      return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
    }

    const message = this.telegram.extractText(update)
    if (message === null) {
      this.inbox.markProcessed(update.id, this.workerId, this.now())
      return { outcome: 'ignored', updateId: update.id }
    }

    let preparedMessage: PreparedIncomingMessage = {
      chatId: message.chatId,
      projectId: message.projectId,
      text: message.text,
      attachments: [],
      ...(message.sourceMessageId === undefined
        ? {}
        : { sourceMessageId: message.sourceMessageId }),
      ...(message.quote === undefined ? {} : { quote: message.quote }),
      ...(message.preferredThreadId === undefined
        ? {}
        : { preferredThreadId: message.preferredThreadId }),
    }
    if (this.telegram.prepareInboundMessage !== undefined) {
      const prepared = await this.telegram.prepareInboundMessage(update, message)
      if (prepared.outcome === 'rejected') {
        const buildDelivery = this.telegram.buildInboundRejectionDelivery
        if (buildDelivery === undefined) {
          throw new Error('Telegram gateway cannot build inbound rejection replies')
        }
        const rejectedAtMs = this.now()
        const rejectionKey = `${operationKey(update)}:rejected`
        const enqueue = this.outbox.enqueue({
          ...buildDelivery.call(this.telegram, {
            update,
            message,
            text: prepared.text,
            sourceKey: rejectionKey,
            nowMs: rejectedAtMs,
          }),
          sourceKey: rejectionKey,
          createdAtMs: rejectedAtMs,
        })
        this.inbox.markProcessed(update.id, this.workerId, rejectedAtMs)
        return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
      }
      preparedMessage = prepared.message
    } else if ((message.attachments?.length ?? 0) > 0) {
      throw new Error('Telegram gateway cannot prepare inbound attachments')
    }

    const turnKey = operationKey(update)
    let result: TextTurnResult
    try {
      result = await this.coordinator.runTextTurn({
        operationKey: turnKey,
        inboxUpdateId: update.id,
        botId: update.botId,
        updateId: update.updateId,
        chatId: preparedMessage.chatId,
        projectId: preparedMessage.projectId,
        text: preparedMessage.text,
        ...(preparedMessage.sourceMessageId === undefined
          ? {}
          : { sourceMessageId: preparedMessage.sourceMessageId }),
        ...(preparedMessage.attachments.length === 0
          ? {}
          : { attachments: preparedMessage.attachments }),
        ...(preparedMessage.quote === undefined ? {} : { quote: preparedMessage.quote }),
        ...(preparedMessage.preferredThreadId === undefined
          ? {}
          : { preferredThreadId: preparedMessage.preferredThreadId }),
      })
    } catch (error) {
      const notice = terminalTurnNotice(error)
      if (notice === null) throw error
      const buildDelivery = this.telegram.buildInboundRejectionDelivery
      if (buildDelivery === undefined) {
        throw new Error('Telegram gateway cannot build terminal turn notices')
      }
      const terminalAtMs = this.now()
      const terminalKey = `${turnKey}:terminal`
      const enqueue = this.outbox.enqueue({
        ...buildDelivery.call(this.telegram, {
          update,
          message,
          text: notice,
          sourceKey: terminalKey,
          nowMs: terminalAtMs,
        }),
        sourceKey: terminalKey,
        createdAtMs: terminalAtMs,
      })
      this.inbox.markProcessed(update.id, this.workerId, terminalAtMs)
      return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
    }
    const completedAtMs = this.now()
    const finalSourceKey = `${turnKey}:final`
    const textDeliveries = this.telegram.buildFinalTextDeliveries({
      update,
      message,
      result,
      sourceKey: finalSourceKey,
      nowMs: completedAtMs,
    })
    let artifactDeliveries: readonly DeliveryJobInput[] = []
    if ((result.artifacts?.length ?? 0) > 0) {
      const buildArtifacts = this.telegram.buildFinalArtifactDeliveries
      if (buildArtifacts === undefined) {
        throw new Error('Telegram gateway cannot deliver agent artifacts')
      }
      const dependsOnSourceKey = textDeliveries.at(-1)?.sourceKey
      artifactDeliveries = await buildArtifacts.call(this.telegram, {
        update,
        message,
        result,
        sourceKey: `${turnKey}:artifact`,
        ...(dependsOnSourceKey === undefined ? {} : { dependsOnSourceKey }),
        nowMs: completedAtMs,
      })
      if (artifactDeliveries.length === 0) {
        throw new Error('Telegram gateway dropped all agent artifacts')
      }
    }
    const finalDeliveries = [...textDeliveries, ...artifactDeliveries]
    let completionDeliveries: readonly DeliveryJobInput[] = []
    // `busy_choice` and `guided_plan` are UI presentations, not completed work.
    // In particular, a busy choice reuses the active turn id; treating it as a
    // completion leaks that active turn's diff into an unrelated Git card.
    if (
      this.turnCompletionReporter !== undefined &&
      (result.presentation ?? 'answer') === 'answer'
    ) {
      const dependsOnSourceKey = finalDeliveries.at(-1)?.sourceKey
      completionDeliveries = await this.turnCompletionReporter.buildTurnCompletionDeliveries({
        update,
        message,
        result,
        operationKey: turnKey,
        sourceKey: `${turnKey}:completion`,
        ...(dependsOnSourceKey === undefined ? {} : { dependsOnSourceKey }),
        nowMs: completedAtMs,
      })
    }
    const deliveries = [...finalDeliveries, ...completionDeliveries]
    let firstDeliveryJobId: string | null = null
    for (const delivery of deliveries) {
      const enqueue = this.outbox.enqueue({
        ...delivery,
        createdAtMs: delivery.createdAtMs ?? completedAtMs,
      })
      firstDeliveryJobId ??= enqueue.job.id
    }
    if (firstDeliveryJobId === null) throw new Error('Telegram gateway produced no final deliveries')
    this.inbox.markProcessed(update.id, this.workerId, completedAtMs)
    return {
      outcome: 'enqueued',
      updateId: update.id,
      deliveryJobId: firstDeliveryJobId,
    }
  }

  private handleFailure(update: InboxUpdate, error: unknown): InboxRunResult {
    const failedAtMs = this.now()
    const retryAtMs = this.retryPolicy.nextRetryAt(update, failedAtMs)
    const summary = this.errorSummary(error)
    if (retryAtMs === null) {
      this.inbox.fail(update.id, this.workerId, summary, failedAtMs)
      const message = this.telegram.extractText(update)
      const buildDelivery = this.telegram.buildInboundRejectionDelivery
      if (message !== null && buildDelivery !== undefined) {
        const failureKey = `${operationKey(update)}:failed`
        try {
          const enqueue = this.outbox.enqueue({
            ...buildDelivery.call(this.telegram, {
              update,
              message,
              text: '⚠️ Мост не смог обработать сообщение после допустимого числа попыток. Автоповтор остановлен; проверь /status перед повторной отправкой.',
              sourceKey: failureKey,
              nowMs: failedAtMs,
            }),
            sourceKey: failureKey,
            createdAtMs: failedAtMs,
          })
          return { outcome: 'enqueued', updateId: update.id, deliveryJobId: enqueue.job.id }
        } catch {
          // FAILED remains recoverable even if the user notice cannot be enqueued.
        }
      }
      return { outcome: 'failed', updateId: update.id }
    }
    this.inbox.retry(update.id, this.workerId, summary, retryAtMs)
    return { outcome: 'retry_wait', updateId: update.id, retryAtMs }
  }
}
