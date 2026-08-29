import type {
  AgentBackend,
  CommandResult,
  IncomingInteractionResponse,
  InteractionHandler,
  InteractionOperation,
  InteractionResult,
  SessionCoordinator,
  TelegramGateway,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import type { InboxUpdate, OutboxRepository } from '../durable/contracts.js'
import {
  type BusyAction,
  type GuidedPlanRecord,
  SqliteControlInteractionRepository,
} from '../durable/control-interaction-repository.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'
import type { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import type { PersonalAlphaCommands } from './personal-alpha-commands.js'
import { planCard } from './m65-session-coordinator.js'

type FeatureAction = Extract<IncomingInteractionResponse, { kind: 'feature_action' }>

function keyboard(result: CommandResult): unknown {
  if (result.buttons === undefined) return undefined
  return {
    reply_markup: {
      inline_keyboard: result.buttons.map((row) => row.map((button) => (
        'callbackData' in button
          ? { text: button.text, callback_data: button.callbackData }
          : { text: button.text, url: button.url }
      ))),
    },
  }
}

function fakeUpdate(operation: InteractionOperation, chatId: string): InboxUpdate {
  return {
    id: operation.inboxUpdateId,
    botId: operation.botId,
    updateId: operation.updateId,
    chatId,
    routingClass: 'CONTROL',
    payload: {},
    state: 'LEASED',
    attemptCount: 1,
    availableAtMs: 0,
    leaseOwner: null,
    leaseExpiresAtMs: null,
    receivedAtMs: 0,
    processedAtMs: null,
    lastError: null,
  }
}

export class M65InteractionHandler implements InteractionHandler {
  constructor(
    private readonly legacy: InteractionHandler,
    private readonly controls: SqliteControlInteractionRepository,
    private readonly sessions: SqliteSessionRepository,
    private readonly settings: SqliteAgentSettingsRepository,
    private readonly backend: AgentBackend,
    private readonly coordinator: SessionCoordinator,
    private readonly commands: PersonalAlphaCommands,
    private readonly outbox: OutboxRepository,
    private readonly telegram: TelegramGateway,
    private readonly defaultProjectId: string,
    private readonly now: () => number = Date.now,
  ) {}

  handleInteraction(operation: InteractionOperation): Promise<InteractionResult> {
    const response = operation.response
    if (response.kind === 'guided_plan_revision') {
      return this.revisePlan(operation, response)
    }
    if (response.kind !== 'feature_action') return this.legacy.handleInteraction(operation)
    if (response.feature === 'settings') return this.settingsAction(operation, response)
    if (response.feature === 'busy') return this.busyAction(operation, response)
    return this.planAction(operation, response)
  }

  private async settingsAction(
    operation: InteractionOperation,
    response: FeatureAction,
  ): Promise<InteractionResult> {
    const result = await this.commands.handleSettingsAction({
      botId: operation.botId,
      chatId: response.chatId,
      projectId: this.selectedProject(operation.botId, response.chatId),
      operationKey: operation.operationKey,
      action: response.action,
    })
    const edit = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:settings-edit`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text: result.text,
        ...(result.buttons === undefined ? {} : { options: keyboard(result) }),
      },
      createdAtMs: this.now(),
    })
    this.enqueueAck(operation, response, 'Сохранено')
    return { deliveryJobId: edit.job.id }
  }

  private async busyAction(
    operation: InteractionOperation,
    response: FeatureAction,
  ): Promise<InteractionResult> {
    if (!['steer', 'queue', 'replace', 'cancel'].includes(response.action)) {
      return this.closedCallback(operation, response, 'Неизвестное действие')
    }
    const action = response.action as BusyAction
    const began = this.controls.beginBusyAction(
      response.token,
      response.chatId,
      action,
      operation.operationKey,
      this.now(),
    )
    if (began.outcome === 'not_found' || began.prompt === null) {
      return this.closedCallback(operation, response, 'Сообщение не найдено')
    }
    if (began.outcome === 'closed') {
      return this.closedCallback(operation, response, `Уже обработано: ${began.prompt.state}`)
    }
    const prompt = began.prompt
    if (action === 'cancel') {
      this.controls.completeBusy(prompt.id, 'CANCELLED', null, this.now())
      return this.editAndAck(operation, response, '❌ Сообщение отменено.', 'Отменено')
    }
    if (action === 'steer') {
      const overview = this.sessions.getOverview(
        operation.botId, response.chatId, prompt.projectId, 'codex',
      )
      if (
        overview.binding?.threadId !== prompt.blockingThreadId ||
        overview.activeTurn?.backendTurnId !== prompt.blockingTurnId
      ) {
        this.controls.completeBusy(prompt.id, 'FAILED', null, this.now())
        return this.editAndAck(operation, response, '⚠️ Исходный turn уже завершён.', 'Turn закрыт')
      }
      await this.backend.steerTurn({
        operationKey: operation.operationKey,
        threadId: prompt.blockingThreadId,
        turnId: prompt.blockingTurnId,
        text: prompt.input.text,
      })
      this.controls.completeBusy(prompt.id, 'STEERED', null, this.now())
      return this.editAndAck(operation, response, '↪️ Уточнение отправлено в активный turn.', 'Steer отправлен')
    }
    if (action === 'replace' && began.outcome === 'started') {
      await this.backend.interruptTurn(prompt.blockingThreadId, prompt.blockingTurnId)
    }
    const forwarded: TextTurnOperation = {
      ...prompt.input,
      operationKey: `${prompt.sourceOperationKey}:busy-selected`,
      preferredThreadId: prompt.blockingThreadId,
    }
    const result = await this.coordinator.runTextTurn(forwarded)
    this.controls.completeBusy(prompt.id, 'COMPLETED', result, this.now())
    const first = this.enqueueFinal(operation, forwarded, result, `${operation.operationKey}:final`)
    this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:busy-card`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text: action === 'replace' ? '⏹ Предыдущий turn остановлен; сообщение выполнено.' : '✅ Сообщение выполнено из очереди.',
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: this.now(),
    })
    this.enqueueAck(operation, response, 'Готово')
    return { deliveryJobId: first }
  }

  private async planAction(
    operation: InteractionOperation,
    response: FeatureAction,
  ): Promise<InteractionResult> {
    if (response.action === 'cancel') {
      const plan = this.controls.cancelPlan(response.token, response.chatId, this.now())
      if (plan === null) return this.closedCallback(operation, response, 'План не найден')
      return this.editAndAck(operation, response, '❌ План отменён. Изменения не выполнялись.', 'Отменено')
    }
    if (response.action === 'revise') {
      const plan = this.controls.requestPlanRevision(response.token, response.chatId, this.now())
      if (plan === null) return this.closedCallback(operation, response, 'План не найден')
      return this.editAndAck(
        operation,
        response,
        `✏️ Пришли правки командой:\n/revise ${plan.token} <что изменить>`,
        'Жду правки',
      )
    }
    if (response.action !== 'go') return this.closedCallback(operation, response, 'Неизвестное действие')
    const began = this.controls.beginPlanExecution(
      response.token,
      response.chatId,
      operation.operationKey,
      this.now(),
    )
    if (began.outcome === 'not_found' || began.plan === null) {
      return this.closedCallback(operation, response, 'План не найден')
    }
    if (began.outcome === 'closed') {
      return this.closedCallback(operation, response, `План уже ${began.plan.state}`)
    }
    const plan = began.plan
    this.ensurePlanThread(plan)
    const execution: TextTurnOperation = {
      ...plan.input,
      operationKey: `${plan.sourceOperationKey}:execute:r${plan.revision}`,
      text: [
        'The user approved the following plan. Execute it now.',
        'Do not stop after restating the plan; carry the implementation through verification.',
        `ORIGINAL REQUEST:\n${plan.input.text}`,
        `APPROVED PLAN:\n${plan.planText}`,
      ].join('\n\n'),
      attachments: [],
      preferredThreadId: plan.threadId,
    }
    const result = await this.coordinator.runTextTurn(execution)
    this.controls.completePlan(plan.id, result, this.now())
    const first = this.enqueueFinal(operation, execution, result, `${operation.operationKey}:final`)
    this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:plan-card`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text: '✅ План подтверждён и выполнен.',
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: this.now(),
    })
    this.enqueueAck(operation, response, 'План выполнен')
    return { deliveryJobId: first }
  }

  private async revisePlan(
    operation: InteractionOperation,
    response: Extract<IncomingInteractionResponse, { kind: 'guided_plan_revision' }>,
  ): Promise<InteractionResult> {
    const began = this.controls.beginPlanRevision(
      response.token,
      response.chatId,
      operation.operationKey,
      this.now(),
    )
    if (began.outcome === 'not_found' || began.plan === null) {
      return this.enqueueNotice(operation, response.chatId, 'План не найден.')
    }
    if (began.outcome === 'closed') {
      return this.enqueueNotice(operation, response.chatId, `План уже ${began.plan.state}.`)
    }
    const plan = began.plan
    this.ensurePlanThread(plan)
    const revision: TextTurnOperation = {
      ...plan.input,
      operationKey: `${plan.sourceOperationKey}:revise:r${plan.revision + 1}`,
      text: [
        'GUIDED PLAN GATE — REVISE THE PLAN ONLY.',
        'Do not execute commands or modify files.',
        `ORIGINAL REQUEST:\n${plan.input.text}`,
        `CURRENT PLAN:\n${plan.planText}`,
        `USER REVISION:\n${response.text}`,
      ].join('\n\n'),
      attachments: [],
      preferredThreadId: plan.threadId,
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    }
    const result = await this.coordinator.runTextTurn(revision)
    const updated = this.controls.finishPlanRevision(plan.id, result, this.now())
    const card: TextTurnResult = {
      ...result,
      finalText: `🧭 План обновлён (revision ${updated.revision}).\n\n${updated.planText}`,
      buttons: planCard(updated.token),
      presentation: 'guided_plan',
    }
    const first = this.enqueueFinal(operation, revision, card, `${operation.operationKey}:plan-revision`)
    return { deliveryJobId: first }
  }

  private ensurePlanThread(plan: GuidedPlanRecord): void {
    const selected = this.sessions.attachExternalThread(
      plan.botId, plan.chatId, plan.projectId, 'codex', plan.threadId, this.now(),
    )
    if (selected.outcome === 'blocked') {
      // Let the durable coordinator surface its normal queued/recovery state.
      return
    }
  }

  private enqueueFinal(
    operation: InteractionOperation,
    input: TextTurnOperation,
    result: TextTurnResult,
    sourceKey: string,
  ): string {
    const deliveries = this.telegram.buildFinalTextDeliveries({
      update: fakeUpdate(operation, input.chatId),
      message: { chatId: input.chatId, projectId: input.projectId, text: input.text },
      result,
      sourceKey,
      nowMs: this.now(),
    })
    let first: string | null = null
    for (const delivery of deliveries) {
      const enqueued = this.outbox.enqueue(delivery)
      first ??= enqueued.job.id
    }
    if (first === null) throw new Error('feature interaction produced no delivery')
    return first
  }

  private selectedProject(botId: string, chatId: string): string {
    return this.settings.getSelectedProject(botId, chatId) ?? this.defaultProjectId
  }

  private editAndAck(
    operation: InteractionOperation,
    response: FeatureAction,
    text: string,
    toast: string,
  ): InteractionResult {
    const edit = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:edit`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text,
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: this.now(),
    })
    this.enqueueAck(operation, response, toast)
    return { deliveryJobId: edit.job.id }
  }

  private closedCallback(
    operation: InteractionOperation,
    response: FeatureAction,
    text: string,
  ): InteractionResult {
    const ack = this.enqueueAck(operation, response, text)
    return { deliveryJobId: ack }
  }

  private enqueueAck(operation: InteractionOperation, response: FeatureAction, text: string): string {
    return this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:callback-ack`,
      kind: 'reaction',
      payload: {
        action: 'answer_callback',
        callbackQueryId: response.callbackQueryId,
        text,
      },
      createdAtMs: this.now(),
      expiresAtMs: this.now() + 30_000,
    }).job.id
  }

  private enqueueNotice(
    operation: InteractionOperation,
    chatId: string,
    text: string,
  ): InteractionResult {
    const job = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:notice`,
      kind: 'send_text',
      payload: { chatId, text },
      createdAtMs: this.now(),
    })
    return { deliveryJobId: job.job.id }
  }
}
