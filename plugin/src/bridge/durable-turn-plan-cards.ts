import { randomBytes } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import type { OutboxRepository } from '../durable/contracts.js'
import type { SqliteSessionRepository, TurnState } from '../durable/session-repository.js'
import { escapeHtml } from '../format/html.js'
import type {
  AgentBackend,
  AgentTurnProgress,
  AgentTurnSettings,
  AgentTurnUxObserver,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'

type PlanPhase = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN'
type CancelState = 'AVAILABLE' | 'CONFIRMING' | 'REQUESTED' | 'CLOSED'
type StepStatus = 'pending' | 'in_progress' | 'completed'

interface PlanStep {
  step: string
  status: StepStatus
}

interface PlanCardRow {
  operation_key: string
  token: string
  bot_id: string
  chat_id: string
  project_id: string
  thread_id: string
  turn_id: string
  root_source_key: string
  tail_source_key: string
  revision: number
  phase: PlanPhase
  cancel_state: CancelState
  cancel_operation_key: string | null
  interrupt_sent_at_ms: number | null
  steps_json: string
  created_at_ms: number
  updated_at_ms: number
}

export interface TurnPlanCardActionResult {
  deliveryJobId: string | null
  toast: string
}

const MIN_VISIBLE_PLAN_STEPS = 2
const MAX_VISIBLE_PLAN_STEPS = 20
const MAX_VISIBLE_STEP_CHARS = 160

function token(): string {
  return randomBytes(6).toString('hex')
}

function stepsFromRow(row: PlanCardRow): PlanStep[] {
  try {
    const value = JSON.parse(row.steps_json) as unknown
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const candidate = item as { step?: unknown; status?: unknown }
      if (
        typeof candidate.step !== 'string' ||
        (candidate.status !== 'pending' &&
          candidate.status !== 'in_progress' &&
          candidate.status !== 'completed')
      ) return []
      return [{ step: candidate.step, status: candidate.status }]
    })
  } catch {
    return []
  }
}

function normalizeSteps(steps: AgentTurnProgress & { kind: 'plan' }): PlanStep[] {
  return steps.steps.flatMap((item) => {
    const step = item.step.trim().replace(/\s+/g, ' ').slice(0, MAX_VISIBLE_STEP_CHARS)
    return step.length === 0 ? [] : [{ step, status: item.status }]
  }).slice(0, MAX_VISIBLE_PLAN_STEPS)
}

function escapeRichInline(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&')
}

function title(phase: PlanPhase): string {
  switch (phase) {
    case 'ACTIVE': return 'Ход задачи'
    case 'COMPLETED': return 'Задача выполнена'
    case 'FAILED': return 'Задача не завершена'
    case 'INTERRUPTED': return 'Задача отменена'
    case 'UNKNOWN': return 'Статус задачи неизвестен'
  }
}

function buttons(row: PlanCardRow): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  if (row.phase !== 'ACTIVE' || row.cancel_state === 'CLOSED' || row.cancel_state === 'REQUESTED') {
    return { inline_keyboard: [] }
  }
  if (row.cancel_state === 'CONFIRMING') {
    return {
      inline_keyboard: [[
        { text: '⏹ Подтвердить', callback_data: `dx:t:${row.token}:confirm` },
        { text: '↩ Продолжить', callback_data: `dx:t:${row.token}:keep` },
      ]],
    }
  }
  return {
    inline_keyboard: [[
      { text: '⏹ Отменить задачу', callback_data: `dx:t:${row.token}:cancel` },
    ]],
  }
}

function richText(row: PlanCardRow): string {
  const steps = stepsFromRow(row)
  const completed = steps.filter((step) => step.status === 'completed').length
  const lines = [`## ${title(row.phase)}`, '']
  for (const item of steps) {
    const checked = item.status === 'completed' ? 'x' : ' '
    const prefix = item.status === 'in_progress' ? '⏳ ' : ''
    lines.push(`- [${checked}] ${prefix}${escapeRichInline(item.step)}`)
  }
  lines.push('', `**Выполнено: ${completed} / ${steps.length}**`)
  if (row.cancel_state === 'CONFIRMING') {
    lines.push('', '> Отменить эту задачу? Подтверди ниже.')
  } else if (row.cancel_state === 'REQUESTED') {
    lines.push('', '> Отмена запрошена…')
  }
  return lines.join('\n')
}

function fallbackText(row: PlanCardRow): string {
  const steps = stepsFromRow(row)
  const completed = steps.filter((step) => step.status === 'completed').length
  const lines = [`<b>${escapeHtml(title(row.phase))}</b>`, '']
  for (const item of steps) {
    const mark = item.status === 'completed' ? '☑️' : item.status === 'in_progress' ? '⏳' : '☐'
    lines.push(`${mark} ${escapeHtml(item.step)}`)
  }
  lines.push('', `<b>Выполнено: ${completed} / ${steps.length}</b>`)
  if (row.cancel_state === 'CONFIRMING') {
    lines.push('', 'Отменить эту задачу? Подтверди ниже.')
  } else if (row.cancel_state === 'REQUESTED') {
    lines.push('', 'Отмена запрошена…')
  }
  return lines.join('\n')
}

function payload(row: PlanCardRow): unknown {
  const replyMarkup = buttons(row)
  return {
    chatId: row.chat_id,
    text: richText(row),
    format: 'rich',
    options: { reply_markup: replyMarkup },
    fallback: [{
      text: fallbackText(row),
      options: { parse_mode: 'HTML', reply_markup: replyMarkup },
    }],
  }
}

function terminalPhase(state: Exclude<TurnState, 'QUEUED' | 'ACTIVE'>): PlanPhase {
  return state
}

/** Durable Rich Message projection for native Codex plans and confirmed cancellation. */
export class DurableTurnPlanCards implements AgentTurnUxObserver {
  constructor(
    private readonly database: Database,
    private readonly outbox: OutboxRepository,
    private readonly sessions: SqliteSessionRepository,
    private readonly backend: Pick<AgentBackend, 'interruptTurn'>,
    private readonly now: () => number = Date.now,
  ) {}

  onPreparing(_operation: TextTurnOperation, _settings: AgentTurnSettings): void {}

  onThreadReady(_operation: TextTurnOperation, _threadId: string): void {}

  onTurnStarted(operation: TextTurnOperation, threadId: string, turnId: string): void {
    const cancellationRequested = this.database.transaction(() => {
      const row = this.getByOperation(operation.operationKey)
      if (row === null || row.phase !== 'ACTIVE' || row.turn_id === turnId) return false
      row.thread_id = threadId
      row.turn_id = turnId
      if (row.cancel_state === 'REQUESTED') row.interrupt_sent_at_ms = null
      row.updated_at_ms = this.now()
      this.enqueueEdit(row, row.updated_at_ms)
      return row.cancel_state === 'REQUESTED'
    }).immediate()
    if (cancellationRequested) {
      void this.backend.interruptTurn(threadId, turnId)
        .then(() => this.markInterruptSent(operation.operationKey))
        .catch(() => undefined)
    }
  }

  onProgress(operation: TextTurnOperation, progress: AgentTurnProgress): void {
    if (progress.kind !== 'plan') return
    const steps = normalizeSteps(progress)
    if (steps.length < MIN_VISIBLE_PLAN_STEPS) return
    const nowMs = this.now()
    this.database.transaction(() => {
      const existing = this.getByOperation(operation.operationKey)
      if (existing === null) {
        const rootSourceKey = `${operation.operationKey}:plan-progress`
        const inserted = this.database.run(
          `INSERT INTO telegram_turn_plan_cards
            (operation_key, token, bot_id, chat_id, project_id, thread_id, turn_id,
             root_source_key, tail_source_key, steps_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [
            operation.operationKey,
            token(),
            operation.botId,
            operation.chatId,
            operation.projectId,
            progress.threadId,
            progress.turnId,
            rootSourceKey,
            rootSourceKey,
            JSON.stringify(steps),
            nowMs,
            nowMs,
          ],
        ).changes
        if (inserted !== 1) return
        const created = this.requireByOperation(operation.operationKey)
        this.outbox.enqueue({
          sourceKey: rootSourceKey,
          kind: 'send_text',
          payload: payload(created),
          createdAtMs: nowMs,
        })
        return
      }
      if (existing.phase !== 'ACTIVE' || existing.turn_id !== progress.turnId) return
      const serialized = JSON.stringify(steps)
      if (serialized === existing.steps_json) return
      existing.steps_json = serialized
      existing.thread_id = progress.threadId
      existing.updated_at_ms = nowMs
      this.enqueueEdit(existing, nowMs)
    }).immediate()
  }

  onCompleted(operation: TextTurnOperation, _result: TextTurnResult): void {
    this.close(operation.operationKey, 'COMPLETED', true)
  }

  onTerminal(
    operation: TextTurnOperation,
    state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
    _errorName: string,
  ): void {
    this.close(operation.operationKey, state, false)
  }

  async handleAction(input: {
    operationKey: string
    token: string
    chatId: string
    action: string
  }): Promise<TurnPlanCardActionResult> {
    if (input.action === 'cancel') return this.requestConfirmation(input)
    if (input.action === 'keep') return this.keepRunning(input)
    if (input.action === 'confirm') return this.confirmCancel(input)
    return { deliveryJobId: null, toast: 'Неизвестное действие' }
  }

  async recoverStartup(): Promise<number> {
    const rows = this.database.query<PlanCardRow, []>(
      `SELECT * FROM telegram_turn_plan_cards
       WHERE phase = 'ACTIVE' ORDER BY created_at_ms, operation_key`,
    ).all()
    let recovered = 0
    for (const row of rows) {
      const turn = this.sessions.getTurnByOperationKey(row.operation_key)
      if (turn === null) continue
      if (turn.state !== 'ACTIVE' && turn.state !== 'QUEUED') {
        this.close(row.operation_key, terminalPhase(turn.state), turn.state === 'COMPLETED')
        recovered += 1
        continue
      }
      if (
        turn.state === 'ACTIVE' &&
        row.cancel_state === 'REQUESTED' &&
        row.interrupt_sent_at_ms === null
      ) {
        try {
          await this.backend.interruptTurn(row.thread_id, row.turn_id)
          this.markInterruptSent(row.operation_key)
          recovered += 1
        } catch {
          // Leave REQUESTED durable; the next startup or callback retry can resume it.
        }
      }
    }
    return recovered
  }

  private requestConfirmation(input: {
    token: string
    chatId: string
  }): TurnPlanCardActionResult {
    return this.database.transaction(() => {
      const row = this.getByToken(input.token, input.chatId)
      if (row === null) return { deliveryJobId: null, toast: 'Задача не найдена' }
      if (row.phase !== 'ACTIVE' || row.cancel_state === 'CLOSED') {
        return { deliveryJobId: null, toast: 'Задача уже завершена' }
      }
      if (row.cancel_state === 'REQUESTED') {
        return { deliveryJobId: null, toast: 'Отмена уже запрошена' }
      }
      if (row.cancel_state === 'CONFIRMING') {
        return { deliveryJobId: null, toast: 'Подтверди отмену ниже' }
      }
      row.cancel_state = 'CONFIRMING'
      row.updated_at_ms = this.now()
      return {
        deliveryJobId: this.enqueueEdit(row, row.updated_at_ms),
        toast: 'Нужно подтверждение',
      }
    }).immediate()
  }

  private keepRunning(input: {
    token: string
    chatId: string
  }): TurnPlanCardActionResult {
    return this.database.transaction(() => {
      const row = this.getByToken(input.token, input.chatId)
      if (row === null) return { deliveryJobId: null, toast: 'Задача не найдена' }
      if (row.phase !== 'ACTIVE' || row.cancel_state === 'CLOSED') {
        return { deliveryJobId: null, toast: 'Задача уже завершена' }
      }
      if (row.cancel_state === 'REQUESTED') {
        return { deliveryJobId: null, toast: 'Отмена уже запрошена' }
      }
      if (row.cancel_state === 'AVAILABLE') {
        return { deliveryJobId: null, toast: 'Задача всё ещё выполняется' }
      }
      row.cancel_state = 'AVAILABLE'
      row.cancel_operation_key = null
      row.updated_at_ms = this.now()
      return {
        deliveryJobId: this.enqueueEdit(row, row.updated_at_ms),
        toast: 'Задача продолжается',
      }
    }).immediate()
  }

  private async confirmCancel(input: {
    operationKey: string
    token: string
    chatId: string
  }): Promise<TurnPlanCardActionResult> {
    const began = this.database.transaction(() => {
      const row = this.getByToken(input.token, input.chatId)
      if (row === null) return { row: null, deliveryJobId: null, toast: 'Задача не найдена' }
      if (row.phase !== 'ACTIVE' || row.cancel_state === 'CLOSED') {
        return { row: null, deliveryJobId: null, toast: 'Задача уже завершена' }
      }
      if (row.cancel_state === 'AVAILABLE') {
        return { row: null, deliveryJobId: null, toast: 'Сначала нажми «Отменить задачу»' }
      }
      if (row.cancel_state === 'REQUESTED' && row.interrupt_sent_at_ms !== null) {
        return { row: null, deliveryJobId: null, toast: 'Отмена уже запрошена' }
      }
      let deliveryJobId: string | null = null
      if (row.cancel_state === 'CONFIRMING') {
        row.cancel_state = 'REQUESTED'
        row.cancel_operation_key = input.operationKey
        row.updated_at_ms = this.now()
        deliveryJobId = this.enqueueEdit(row, row.updated_at_ms)
      }
      return { row: this.requireByOperation(row.operation_key), deliveryJobId, toast: 'Отменяю задачу…' }
    }).immediate()
    if (began.row === null) {
      return { deliveryJobId: began.deliveryJobId, toast: began.toast }
    }

    const turn = this.sessions.getTurnByOperationKey(began.row.operation_key)
    if (turn === null || turn.state !== 'ACTIVE') {
      if (turn !== null && turn.state !== 'ACTIVE' && turn.state !== 'QUEUED') {
        this.close(
          began.row.operation_key,
          terminalPhase(turn.state),
          turn.state === 'COMPLETED',
        )
      }
      return { deliveryJobId: began.deliveryJobId, toast: 'Задача уже завершена' }
    }

    await this.backend.interruptTurn(began.row.thread_id, began.row.turn_id)
    this.markInterruptSent(began.row.operation_key)
    return { deliveryJobId: began.deliveryJobId, toast: 'Отмена запрошена' }
  }

  private close(operationKey: string, phase: PlanPhase, completeSteps: boolean): void {
    const nowMs = this.now()
    this.database.transaction(() => {
      const row = this.getByOperation(operationKey)
      if (row === null || row.phase !== 'ACTIVE') return
      row.phase = phase
      row.cancel_state = 'CLOSED'
      if (completeSteps) {
        row.steps_json = JSON.stringify(
          stepsFromRow(row).map((step) => ({ ...step, status: 'completed' as const })),
        )
      }
      row.updated_at_ms = nowMs
      this.enqueueEdit(row, nowMs)
    }).immediate()
  }

  private markInterruptSent(operationKey: string): void {
    this.database.run(
      `UPDATE telegram_turn_plan_cards SET interrupt_sent_at_ms = ?, updated_at_ms = ?
       WHERE operation_key = ? AND interrupt_sent_at_ms IS NULL`,
      [this.now(), this.now(), operationKey],
    )
  }

  private enqueueEdit(row: PlanCardRow, nowMs: number): string {
    row.revision += 1
    const sourceKey = `${row.root_source_key}:edit:${row.revision}`
    const enqueued = this.outbox.enqueue({
      sourceKey,
      dependsOnSourceKey: row.tail_source_key,
      kind: 'edit',
      payload: {
        ...payload(row) as Record<string, unknown>,
        targetSourceKey: row.root_source_key,
      },
      createdAtMs: nowMs,
    })
    row.tail_source_key = sourceKey
    this.persist(row)
    return enqueued.job.id
  }

  private persist(row: PlanCardRow): void {
    this.database.run(
      `UPDATE telegram_turn_plan_cards SET
         thread_id = ?, turn_id = ?, tail_source_key = ?, revision = ?, phase = ?,
         cancel_state = ?, cancel_operation_key = ?, interrupt_sent_at_ms = ?,
         steps_json = ?, updated_at_ms = ?
       WHERE operation_key = ?`,
      [
        row.thread_id,
        row.turn_id,
        row.tail_source_key,
        row.revision,
        row.phase,
        row.cancel_state,
        row.cancel_operation_key,
        row.interrupt_sent_at_ms,
        row.steps_json,
        row.updated_at_ms,
        row.operation_key,
      ],
    )
  }

  private getByOperation(operationKey: string): PlanCardRow | null {
    return this.database.query<PlanCardRow, [string]>(
      'SELECT * FROM telegram_turn_plan_cards WHERE operation_key = ?',
    ).get(operationKey)
  }

  private requireByOperation(operationKey: string): PlanCardRow {
    const row = this.getByOperation(operationKey)
    if (row === null) throw new Error(`turn plan card ${operationKey} not found`)
    return row
  }

  private getByToken(value: string, chatId: string): PlanCardRow | null {
    return this.database.query<PlanCardRow, [string, string]>(
      'SELECT * FROM telegram_turn_plan_cards WHERE token = ? AND chat_id = ?',
    ).get(value, chatId)
  }
}
