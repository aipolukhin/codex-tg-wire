import type {
  AgentBackend,
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import type {
  GuidedPlanRecord,
  SqliteControlInteractionRepository,
} from '../durable/control-interaction-repository.js'
import type { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'

const PLAN_ONLY_INSTRUCTION = [
  'GUIDED PLAN GATE — PLANNING ONLY.',
  'Analyze the user request and produce a concrete implementation plan.',
  'Do not edit files, run mutating commands, send messages, or execute the plan.',
  'The final answer must contain the plan that can be approved in Telegram.',
].join('\n')

const DISCUSSION_ONLY_INSTRUCTION = [
  'DURABLE DISCUSSION GATE — DISCUSSION ONLY.',
  'Discuss the goal, requirements, tradeoffs and recommended scope with the owner.',
  'Read-only inspection is allowed when it materially improves the answer.',
  'Do not edit files, run mutating commands, create an execution plan, commit, push, deploy or restart services.',
  'End with one concrete recommendation when the concept is mature enough; the bridge will ask the owner whether to implement it.',
].join('\n')

const DISCUSSION_CUE = new RegExp([
  'давай\\s+(?:сначала\\s+)?(?:обсудим|подумаем|разбер[её]м)',
  'хочу\\s+(?:сначала\\s+)?обсудить',
  'твои?\\s+предложени',
  'что\\s+ты\\s+(?:думаешь|предлагаешь)',
  'как\\s+(?:будем|лучше)\\s+(?:это\\s+)?(?:делать|реализовывать|фиксить|организовать)',
  'как\\s+фиксим',
  'предложи\\s+(?:мне\\s+)?(?:решение|вариант|архитектуру|подход)',
  'обсудить\\s+(?:идею|концепцию|решение|архитектуру)',
  'концепци[яию]|продуктов(?:ая|ую)\\s+иде[яю]',
].join('|'), 'iu')

const DIRECT_EXECUTION = /^(?:(?:брат|бро)[,!:]?\s+)?(?:давай\s+)?(?:сделай|реализуй|почини|исправь|добавь|измени|перенеси|создай|удали|закоммить|запушь|чини|фикси)(?=\s|[.!?,:]|$)/iu
const DISCUSSION_APPROVAL = /^(?:да|ок(?:ей)?|делай|реализуй(?:\s+(?:это|этот\s+вариант|предложенное|план))?|погнали|вноси|запускай)(?:[.!]+)?$/iu

export function startsDiscussion(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0 || DIRECT_EXECUTION.test(normalized)) return false
  return DISCUSSION_CUE.test(normalized)
}

export function approvesDiscussion(text: string): boolean {
  return DISCUSSION_APPROVAL.test(text.trim().replace(/\s+/g, ' '))
}

function planCard(token: string): NonNullable<TextTurnResult['buttons']> {
  return [
    [{ text: '🚀 Реализовать', callbackData: `dx:p:${token}:go` }],
    [{ text: '🗑 Закрыть обсуждение', callbackData: `dx:p:${token}:cancel` }],
  ]
}

function busyCard(token: string): NonNullable<TextTurnResult['buttons']> {
  return [
    [{ text: '↪️ Steer сейчас', callbackData: `dx:b:${token}:steer` }],
    [
      { text: '🕒 В очередь', callbackData: `dx:b:${token}:queue` },
      { text: '⏹ Stop & replace', callbackData: `dx:b:${token}:replace` },
    ],
    [{ text: '❌ Не отправлять', callbackData: `dx:b:${token}:cancel` }],
  ]
}

/** Adds persisted busy choices and the optional Guided Plan gate. */
export class M65SessionCoordinator implements SessionCoordinator {
  constructor(
    private readonly delegate: SessionCoordinator,
    private readonly sessions: SqliteSessionRepository,
    private readonly settings: SqliteAgentSettingsRepository,
    private readonly controls: SqliteControlInteractionRepository,
    private readonly backend?: Pick<AgentBackend, 'getActiveTurn'>,
    private readonly now: () => number = Date.now,
  ) {}

  async runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    const existingBusy = this.controls.getBusyBySource(operation.operationKey)
    if (existingBusy !== null) return this.busyPresentation(existingBusy)

    const overview = this.sessions.getOverview(
      operation.botId,
      operation.chatId,
      operation.projectId,
      'codex',
    )
    const backendTurnId = overview.binding === null
      ? null
      : this.backend?.getActiveTurn?.(overview.binding.threadId) ?? null
    const blockingTurnId = overview.activeTurn?.state === 'ACTIVE'
      ? overview.activeTurn.backendTurnId ?? overview.activeTurn.id
      : backendTurnId
    if (blockingTurnId !== null && overview.binding !== null) {
      const busy = this.controls.createBusy({
        operation,
        blockingThreadId: overview.binding.threadId,
        blockingTurnId,
        nowMs: this.now(),
      })
      return this.busyPresentation(busy)
    }

    const actionReplay = this.controls.getPlanByActionOperation(operation.operationKey)
    if (actionReplay?.state === 'COMPLETED' && actionReplay.result !== null) {
      return actionReplay.result
    }

    const openPlan = overview.binding === null
      ? null
      : this.controls.getOpenPlan({
          botId: operation.botId,
          chatId: operation.chatId,
          projectId: operation.projectId,
          threadId: overview.binding.threadId,
        })
    if (
      openPlan !== null &&
      (
        openPlan.state === 'AWAITING_CONFIRMATION' ||
        openPlan.state === 'REVISION_REQUESTED' ||
        openPlan.state === 'REVISING'
      )
    ) {
      if (openPlan.state === 'AWAITING_CONFIRMATION' && approvesDiscussion(operation.text)) {
        return this.executeApprovedDiscussion(openPlan.token, operation)
      }
      return this.continueDiscussion(openPlan.token, operation)
    }
    if (
      openPlan?.state === 'EXECUTING' &&
      openPlan.actionOperationKey === operation.operationKey
    ) {
      return this.executeApprovedDiscussion(openPlan.token, operation)
    }

    const guided = this.settings.getProjectSettings(
      operation.botId,
      operation.chatId,
      operation.projectId,
    )?.guidedPlanEnabled ?? false
    if (!guided && !startsDiscussion(operation.text)) return this.delegate.runTextTurn(operation)

    const existingPlan = this.controls.getPlanBySource(operation.operationKey)
    if (existingPlan !== null) {
      return this.discussionPresentation(existingPlan)
    }

    const draft = await this.delegate.runTextTurn({
      ...operation,
      operationKey: `${operation.operationKey}:${guided ? 'guided-plan' : 'discussion'}:draft`,
      text: `${guided ? PLAN_ONLY_INSTRUCTION : DISCUSSION_ONLY_INSTRUCTION}\n\nUSER REQUEST:\n${operation.text}`,
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    const plan = this.controls.createPlan({ operation, result: draft, nowMs: this.now() })
    return this.discussionPresentation(plan, draft)
  }

  private async continueDiscussion(
    tokenValue: string,
    operation: TextTurnOperation,
  ): Promise<TextTurnResult> {
    const replay = this.controls.getPlanByActionOperation(operation.operationKey)
    if (replay?.state === 'AWAITING_CONFIRMATION') return this.discussionPresentation(replay)
    const began = this.controls.beginDiscussionRevision(
      tokenValue,
      operation.chatId,
      operation.operationKey,
      this.now(),
    )
    if (began.plan === null || began.outcome === 'not_found') {
      throw new Error('durable discussion was not found')
    }
    if (began.outcome === 'closed') return this.discussionPresentation(began.plan)
    const plan = began.plan
    this.ensurePlanThread(plan.threadId, plan.botId, plan.chatId, plan.projectId)
    const discussion: TextTurnOperation = {
      ...operation,
      operationKey: `${operation.operationKey}:discussion:r${plan.revision + 1}`,
      text: [
        DISCUSSION_ONLY_INSTRUCTION,
        `CURRENT RECOMMENDATION:\n${plan.planText}`,
        `OWNER MESSAGE:\n${operation.text}`,
      ].join('\n\n'),
      preferredThreadId: plan.threadId,
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    }
    const result = await this.delegate.runTextTurn(discussion)
    const updated = this.controls.finishDiscussionRevision(plan.id, operation, result, this.now())
    return this.discussionPresentation(updated, result)
  }

  private async executeApprovedDiscussion(
    tokenValue: string,
    operation: TextTurnOperation,
  ): Promise<TextTurnResult> {
    const began = this.controls.beginPlanExecution(
      tokenValue,
      operation.chatId,
      operation.operationKey,
      this.now(),
    )
    if (began.plan === null || began.outcome === 'not_found') {
      throw new Error('approved discussion was not found')
    }
    if (began.outcome === 'closed') {
      if (began.plan.state === 'COMPLETED' && began.plan.result !== null) return began.plan.result
      throw new Error(`approved discussion is already ${began.plan.state}`)
    }
    const plan = began.plan
    this.ensurePlanThread(plan.threadId, plan.botId, plan.chatId, plan.projectId)
    const execution: TextTurnOperation = {
      ...operation,
      operationKey: `${operation.operationKey}:approved:r${plan.revision}`,
      text: [
        'The owner explicitly approved the recommendation below. Execute it now.',
        'Stay within this agreed scope and carry it through verification.',
        `LATEST OWNER REQUIREMENT:\n${plan.input.text}`,
        `APPROVED RECOMMENDATION:\n${plan.planText}`,
      ].join('\n\n'),
      attachments: [],
      preferredThreadId: plan.threadId,
    }
    const result = await this.delegate.runTextTurn(execution)
    this.controls.completePlan(plan.id, result, this.now())
    return result
  }

  private discussionPresentation(
    plan: GuidedPlanRecord,
    result?: TextTurnResult,
  ): TextTurnResult {
    return {
      ...(result ?? {}),
      threadId: plan.threadId,
      turnId: plan.planningTurnId,
      finalText: `💬 Обсуждение. Изменения не выполнялись.\n\n${plan.planText}`,
      buttons: planCard(plan.token),
      presentation: 'guided_plan',
    }
  }

  private ensurePlanThread(
    threadId: string,
    botId: string,
    chatId: string,
    projectId: string,
  ): void {
    this.sessions.attachExternalThread(botId, chatId, projectId, 'codex', threadId, this.now())
  }

  private busyPresentation(prompt: ReturnType<SqliteControlInteractionRepository['createBusy']>): TextTurnResult {
    if (prompt.response !== null) return prompt.response
    return {
      threadId: prompt.blockingThreadId,
      turnId: prompt.blockingTurnId,
      finalText: 'Codex уже выполняет turn. Что сделать с новым сообщением?',
      buttons: busyCard(prompt.token),
      presentation: 'busy_choice',
    }
  }
}

export { planCard }
