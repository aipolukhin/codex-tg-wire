import { randomBytes, randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import type { TextTurnOperation, TextTurnResult } from '../bridge/contracts.js'

export type BusyAction = 'steer' | 'queue' | 'replace' | 'cancel'
export type BusyState =
  | 'PENDING'
  | 'PROCESSING'
  | 'STEERED'
  | 'QUEUED'
  | 'REPLACED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED'

export interface BusyPromptRecord {
  id: string
  token: string
  sourceOperationKey: string
  botId: string
  chatId: string
  projectId: string
  input: TextTurnOperation
  blockingThreadId: string
  blockingTurnId: string
  state: BusyState
  action: BusyAction | null
  actionOperationKey: string | null
  response: TextTurnResult | null
  createdAtMs: number
  updatedAtMs: number
  resolvedAtMs: number | null
}

interface BusyRow {
  id: string
  token: string
  source_operation_key: string
  bot_id: string
  chat_id: string
  project_id: string
  input_json: string
  blocking_thread_id: string
  blocking_turn_id: string
  state: BusyState
  action: BusyAction | null
  action_operation_key: string | null
  response_json: string | null
  created_at_ms: number
  updated_at_ms: number
  resolved_at_ms: number | null
}

export type GuidedPlanState =
  | 'AWAITING_CONFIRMATION'
  | 'REVISION_REQUESTED'
  | 'REVISING'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'

export interface GuidedPlanRecord {
  id: string
  token: string
  sourceOperationKey: string
  botId: string
  chatId: string
  projectId: string
  input: TextTurnOperation
  threadId: string
  planningTurnId: string
  planText: string
  revision: number
  state: GuidedPlanState
  actionOperationKey: string | null
  result: TextTurnResult | null
  lastError: string | null
  createdAtMs: number
  updatedAtMs: number
  resolvedAtMs: number | null
}

interface PlanRow {
  id: string
  token: string
  source_operation_key: string
  bot_id: string
  chat_id: string
  project_id: string
  input_json: string
  thread_id: string
  planning_turn_id: string
  plan_text: string
  revision: number
  state: GuidedPlanState
  action_operation_key: string | null
  result_json: string | null
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
  resolved_at_ms: number | null
}

function token(): string {
  return randomBytes(6).toString('hex')
}

function busyFromRow(row: BusyRow): BusyPromptRecord {
  return {
    id: row.id,
    token: row.token,
    sourceOperationKey: row.source_operation_key,
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    input: JSON.parse(row.input_json) as TextTurnOperation,
    blockingThreadId: row.blocking_thread_id,
    blockingTurnId: row.blocking_turn_id,
    state: row.state,
    action: row.action,
    actionOperationKey: row.action_operation_key,
    response: row.response_json === null ? null : JSON.parse(row.response_json) as TextTurnResult,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  }
}

function planFromRow(row: PlanRow): GuidedPlanRecord {
  return {
    id: row.id,
    token: row.token,
    sourceOperationKey: row.source_operation_key,
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    input: JSON.parse(row.input_json) as TextTurnOperation,
    threadId: row.thread_id,
    planningTurnId: row.planning_turn_id,
    planText: row.plan_text,
    revision: row.revision,
    state: row.state,
    actionOperationKey: row.action_operation_key,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as TextTurnResult,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  }
}

export class SqliteControlInteractionRepository {
  constructor(private readonly database: Database) {}

  createBusy(input: {
    operation: TextTurnOperation
    blockingThreadId: string
    blockingTurnId: string
    nowMs: number
  }): BusyPromptRecord {
    const existing = this.getBusyBySource(input.operation.operationKey)
    if (existing !== null) return existing
    const id = randomUUID()
    this.database.run(
      `INSERT INTO telegram_busy_prompts
        (id, token, source_operation_key, bot_id, chat_id, project_id, input_json,
         blocking_thread_id, blocking_turn_id, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        token(),
        input.operation.operationKey,
        input.operation.botId,
        input.operation.chatId,
        input.operation.projectId,
        JSON.stringify(input.operation),
        input.blockingThreadId,
        input.blockingTurnId,
        input.nowMs,
        input.nowMs,
      ],
    )
    return this.requireBusy(id)
  }

  getBusyByToken(value: string): BusyPromptRecord | null {
    const row = this.database
      .query<BusyRow, [string]>('SELECT * FROM telegram_busy_prompts WHERE token = ?')
      .get(value)
    return row === null ? null : busyFromRow(row)
  }

  getBusyBySource(operationKey: string): BusyPromptRecord | null {
    const row = this.database
      .query<BusyRow, [string]>(
        'SELECT * FROM telegram_busy_prompts WHERE source_operation_key = ?',
      )
      .get(operationKey)
    return row === null ? null : busyFromRow(row)
  }

  beginBusyAction(
    value: string,
    chatId: string,
    action: BusyAction,
    operationKey: string,
    nowMs: number,
  ): { outcome: 'started' | 'resumed' | 'closed' | 'not_found'; prompt: BusyPromptRecord | null } {
    return this.database.transaction((): {
      outcome: 'started' | 'resumed' | 'closed' | 'not_found'
      prompt: BusyPromptRecord | null
    } => {
      const current = this.getBusyByToken(value)
      if (current === null || current.chatId !== chatId) return { outcome: 'not_found', prompt: null }
      if (
        current.state === 'PROCESSING' &&
        current.action === action &&
        current.actionOperationKey === operationKey
      ) {
        return { outcome: 'resumed', prompt: current }
      }
      if (current.state !== 'PENDING') return { outcome: 'closed', prompt: current }
      this.database.run(
        `UPDATE telegram_busy_prompts
         SET state = 'PROCESSING', action = ?, action_operation_key = ?, updated_at_ms = ?
         WHERE id = ? AND state = 'PENDING'`,
        [action, operationKey, nowMs, current.id],
      )
      return { outcome: 'started', prompt: this.requireBusy(current.id) }
    }).immediate()
  }

  completeBusy(
    id: string,
    state: Exclude<BusyState, 'PENDING' | 'PROCESSING'>,
    response: TextTurnResult | null,
    nowMs: number,
  ): BusyPromptRecord {
    this.database.run(
      `UPDATE telegram_busy_prompts
       SET state = ?, response_json = ?, updated_at_ms = ?, resolved_at_ms = ?
       WHERE id = ? AND state = 'PROCESSING'`,
      [state, response === null ? null : JSON.stringify(response), nowMs, nowMs, id],
    )
    return this.requireBusy(id)
  }

  createPlan(input: {
    operation: TextTurnOperation
    result: TextTurnResult
    nowMs: number
  }): GuidedPlanRecord {
    const existing = this.getPlanBySource(input.operation.operationKey)
    if (existing !== null) return existing
    const id = randomUUID()
    this.database.run(
      `INSERT INTO guided_plans
        (id, token, source_operation_key, bot_id, chat_id, project_id, input_json,
         thread_id, planning_turn_id, plan_text, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        token(),
        input.operation.operationKey,
        input.operation.botId,
        input.operation.chatId,
        input.operation.projectId,
        JSON.stringify(input.operation),
        input.result.threadId,
        input.result.turnId,
        input.result.finalText,
        input.nowMs,
        input.nowMs,
      ],
    )
    return this.requirePlan(id)
  }

  getPlanByToken(value: string): GuidedPlanRecord | null {
    const row = this.database
      .query<PlanRow, [string]>('SELECT * FROM guided_plans WHERE token = ?')
      .get(value)
    return row === null ? null : planFromRow(row)
  }

  getPlanBySource(operationKey: string): GuidedPlanRecord | null {
    const row = this.database
      .query<PlanRow, [string]>('SELECT * FROM guided_plans WHERE source_operation_key = ?')
      .get(operationKey)
    return row === null ? null : planFromRow(row)
  }

  getPlanByActionOperation(operationKey: string): GuidedPlanRecord | null {
    const row = this.database
      .query<PlanRow, [string]>(
        'SELECT * FROM guided_plans WHERE action_operation_key = ? ORDER BY updated_at_ms DESC LIMIT 1',
      )
      .get(operationKey)
    return row === null ? null : planFromRow(row)
  }

  getOpenPlan(input: {
    botId: string
    chatId: string
    projectId: string
    threadId: string
  }): GuidedPlanRecord | null {
    const row = this.database.query<PlanRow, [string, string, string, string]>(
      `SELECT * FROM guided_plans
       WHERE bot_id = ? AND chat_id = ? AND project_id = ? AND thread_id = ?
         AND state IN ('AWAITING_CONFIRMATION', 'REVISION_REQUESTED', 'REVISING', 'EXECUTING')
       ORDER BY updated_at_ms DESC LIMIT 1`,
    ).get(input.botId, input.chatId, input.projectId, input.threadId)
    return row === null ? null : planFromRow(row)
  }

  beginDiscussionRevision(
    value: string,
    chatId: string,
    operationKey: string,
    nowMs: number,
  ): { outcome: 'started' | 'resumed' | 'closed' | 'not_found'; plan: GuidedPlanRecord | null } {
    return this.database.transaction((): {
      outcome: 'started' | 'resumed' | 'closed' | 'not_found'
      plan: GuidedPlanRecord | null
    } => {
      const current = this.getPlanByToken(value)
      if (current === null || current.chatId !== chatId) return { outcome: 'not_found', plan: null }
      if (current.state === 'REVISING' && current.actionOperationKey === operationKey) {
        return { outcome: 'resumed', plan: current }
      }
      if (
        current.state !== 'AWAITING_CONFIRMATION' &&
        current.state !== 'REVISION_REQUESTED'
      ) return { outcome: 'closed', plan: current }
      this.database.run(
        `UPDATE guided_plans
         SET state = 'REVISING', action_operation_key = ?, updated_at_ms = ?
         WHERE id = ? AND state IN ('AWAITING_CONFIRMATION', 'REVISION_REQUESTED')`,
        [operationKey, nowMs, current.id],
      )
      return { outcome: 'started', plan: this.requirePlan(current.id) }
    }).immediate()
  }

  finishDiscussionRevision(
    id: string,
    operation: TextTurnOperation,
    result: TextTurnResult,
    nowMs: number,
  ): GuidedPlanRecord {
    this.database.run(
      `UPDATE guided_plans
       SET state = 'AWAITING_CONFIRMATION', input_json = ?, thread_id = ?,
           planning_turn_id = ?, plan_text = ?, revision = revision + 1,
           updated_at_ms = ?, last_error = NULL
       WHERE id = ? AND state = 'REVISING'`,
      [
        JSON.stringify(operation),
        result.threadId,
        result.turnId,
        result.finalText,
        nowMs,
        id,
      ],
    )
    return this.requirePlan(id)
  }

  beginPlanExecution(
    value: string,
    chatId: string,
    operationKey: string,
    nowMs: number,
  ): { outcome: 'started' | 'resumed' | 'closed' | 'not_found'; plan: GuidedPlanRecord | null } {
    return this.database.transaction((): {
      outcome: 'started' | 'resumed' | 'closed' | 'not_found'
      plan: GuidedPlanRecord | null
    } => {
      const current = this.getPlanByToken(value)
      if (current === null || current.chatId !== chatId) return { outcome: 'not_found', plan: null }
      if (current.state === 'EXECUTING' && current.actionOperationKey === operationKey) {
        return { outcome: 'resumed', plan: current }
      }
      if (current.state !== 'AWAITING_CONFIRMATION') return { outcome: 'closed', plan: current }
      this.database.run(
        `UPDATE guided_plans
         SET state = 'EXECUTING', action_operation_key = ?, updated_at_ms = ?
         WHERE id = ? AND state = 'AWAITING_CONFIRMATION'`,
        [operationKey, nowMs, current.id],
      )
      return { outcome: 'started', plan: this.requirePlan(current.id) }
    }).immediate()
  }

  requestPlanRevision(value: string, chatId: string, nowMs: number): GuidedPlanRecord | null {
    const current = this.getPlanByToken(value)
    if (current === null || current.chatId !== chatId) return null
    this.database.run(
      `UPDATE guided_plans
       SET state = 'REVISION_REQUESTED', action_operation_key = NULL, updated_at_ms = ?
       WHERE id = ? AND state = 'AWAITING_CONFIRMATION'`,
      [nowMs, current.id],
    )
    return this.requirePlan(current.id)
  }

  beginPlanRevision(
    value: string,
    chatId: string,
    operationKey: string,
    nowMs: number,
  ): { outcome: 'started' | 'resumed' | 'closed' | 'not_found'; plan: GuidedPlanRecord | null } {
    return this.database.transaction((): {
      outcome: 'started' | 'resumed' | 'closed' | 'not_found'
      plan: GuidedPlanRecord | null
    } => {
      const current = this.getPlanByToken(value)
      if (current === null || current.chatId !== chatId) return { outcome: 'not_found', plan: null }
      if (current.state === 'REVISING' && current.actionOperationKey === operationKey) {
        return { outcome: 'resumed', plan: current }
      }
      if (current.state !== 'REVISION_REQUESTED') return { outcome: 'closed', plan: current }
      this.database.run(
        `UPDATE guided_plans
         SET state = 'REVISING', action_operation_key = ?, updated_at_ms = ?
         WHERE id = ? AND state = 'REVISION_REQUESTED'`,
        [operationKey, nowMs, current.id],
      )
      return { outcome: 'started', plan: this.requirePlan(current.id) }
    }).immediate()
  }

  finishPlanRevision(id: string, result: TextTurnResult, nowMs: number): GuidedPlanRecord {
    this.database.run(
      `UPDATE guided_plans
       SET state = 'AWAITING_CONFIRMATION', thread_id = ?, planning_turn_id = ?,
           plan_text = ?, revision = revision + 1, action_operation_key = NULL,
           updated_at_ms = ?, last_error = NULL
       WHERE id = ? AND state = 'REVISING'`,
      [result.threadId, result.turnId, result.finalText, nowMs, id],
    )
    return this.requirePlan(id)
  }

  cancelPlan(value: string, chatId: string, nowMs: number): GuidedPlanRecord | null {
    const current = this.getPlanByToken(value)
    if (current === null || current.chatId !== chatId) return null
    this.database.run(
      `UPDATE guided_plans
       SET state = 'CANCELLED', updated_at_ms = ?, resolved_at_ms = ?
       WHERE id = ? AND state IN ('AWAITING_CONFIRMATION', 'REVISION_REQUESTED')`,
      [nowMs, nowMs, current.id],
    )
    return this.requirePlan(current.id)
  }

  completePlan(id: string, result: TextTurnResult, nowMs: number): GuidedPlanRecord {
    this.database.run(
      `UPDATE guided_plans
       SET state = 'COMPLETED', result_json = ?, updated_at_ms = ?, resolved_at_ms = ?
       WHERE id = ? AND state = 'EXECUTING'`,
      [JSON.stringify(result), nowMs, nowMs, id],
    )
    return this.requirePlan(id)
  }

  private requireBusy(id: string): BusyPromptRecord {
    const row = this.database
      .query<BusyRow, [string]>('SELECT * FROM telegram_busy_prompts WHERE id = ?')
      .get(id)
    if (row === null) throw new Error(`busy prompt ${id} not found`)
    return busyFromRow(row)
  }

  private requirePlan(id: string): GuidedPlanRecord {
    const row = this.database
      .query<PlanRow, [string]>('SELECT * FROM guided_plans WHERE id = ?')
      .get(id)
    if (row === null) throw new Error(`guided plan ${id} not found`)
    return planFromRow(row)
  }
}
