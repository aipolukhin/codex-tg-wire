import type {
  AgentBackend,
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import type { SqliteControlInteractionRepository } from '../durable/control-interaction-repository.js'
import type { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'

const PLAN_ONLY_INSTRUCTION = [
  'GUIDED PLAN GATE — PLANNING ONLY.',
  'Analyze the user request and produce a concrete implementation plan.',
  'Do not edit files, run mutating commands, send messages, or execute the plan.',
  'The final answer must contain the plan that can be approved in Telegram.',
].join('\n')

function planCard(token: string): NonNullable<TextTurnResult['buttons']> {
  return [
    [{ text: '▶️ Выполнить', callbackData: `dx:p:${token}:go` }],
    [{ text: '✏️ Изменить', callbackData: `dx:p:${token}:revise` }],
    [{ text: '❌ Отменить', callbackData: `dx:p:${token}:cancel` }],
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

    const guided = this.settings.getProjectSettings(
      operation.botId,
      operation.chatId,
      operation.projectId,
    )?.guidedPlanEnabled ?? false
    if (!guided) return this.delegate.runTextTurn(operation)

    const existingPlan = this.controls.getPlanBySource(operation.operationKey)
    if (existingPlan !== null) {
      return {
        threadId: existingPlan.threadId,
        turnId: existingPlan.planningTurnId,
        finalText: `🧭 План готов. Выполнение ещё не началось.\n\n${existingPlan.planText}`,
        buttons: planCard(existingPlan.token),
        presentation: 'guided_plan',
      }
    }

    const draft = await this.delegate.runTextTurn({
      ...operation,
      operationKey: `${operation.operationKey}:guided-plan:draft`,
      text: `${PLAN_ONLY_INSTRUCTION}\n\nUSER REQUEST:\n${operation.text}`,
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    const plan = this.controls.createPlan({ operation, result: draft, nowMs: this.now() })
    return {
      ...draft,
      finalText: `🧭 План готов. Выполнение ещё не началось.\n\n${plan.planText}`,
      buttons: planCard(plan.token),
      presentation: 'guided_plan',
    }
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
