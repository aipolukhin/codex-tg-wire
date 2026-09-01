import { randomBytes, randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import type {
  ProductDecisionBrief,
  ProductDecisionMode,
} from '../bridge/product-decision.js'

export type ProductDecisionFlowState =
  | 'DISCUSSING'
  | 'AWAITING_ACCEPTANCE'
  | 'ACCEPTING'
  | 'ACCEPTED'
  | 'REJECTED'

export type ProductDecisionDraftState =
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'ACCEPTING'
  | 'ACCEPTED'
  | 'REJECTED'

export interface ProductDecisionFlowRecord {
  id: string
  sourceOperationKey: string
  botId: string
  chatId: string
  projectId: string
  mode: ProductDecisionMode
  sourceUpdateId: string
  sourceMessageId: string
  threadId: string
  lastTurnId: string
  currentVersion: number
  currentDraftId: string | null
  state: ProductDecisionFlowState
  createdAtMs: number
  updatedAtMs: number
  resolvedAtMs: number | null
}

export interface ProductDecisionDraftRecord {
  id: string
  flowId: string
  token: string
  version: number
  turnId: string
  brief: ProductDecisionBrief
  briefSha256: string
  state: ProductDecisionDraftState
  action: 'edit' | 'data' | 'reject' | 'accept' | null
  actionOperationKey: string | null
  acceptanceUpdateId: string | null
  acceptanceMessageId: string | null
  acceptanceCallbackQueryId: string | null
  decisionId: string | null
  gitCommit: string | null
  pushed: boolean | null
  lastError: string | null
  createdAtMs: number
  updatedAtMs: number
  resolvedAtMs: number | null
}

interface FlowRow {
  id: string
  source_operation_key: string
  bot_id: string
  chat_id: string
  project_id: string
  mode: ProductDecisionMode
  source_update_id: string
  source_message_id: string
  thread_id: string
  last_turn_id: string
  current_version: number
  current_draft_id: string | null
  state: ProductDecisionFlowState
  created_at_ms: number
  updated_at_ms: number
  resolved_at_ms: number | null
}

interface DraftRow {
  id: string
  flow_id: string
  token: string
  version: number
  turn_id: string
  brief_json: string
  brief_sha256: string
  state: ProductDecisionDraftState
  action: ProductDecisionDraftRecord['action']
  action_operation_key: string | null
  acceptance_update_id: string | null
  acceptance_message_id: string | null
  acceptance_callback_query_id: string | null
  decision_id: string | null
  git_commit: string | null
  pushed: number | null
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
  resolved_at_ms: number | null
}

function flowFromRow(row: FlowRow): ProductDecisionFlowRecord {
  return {
    id: row.id,
    sourceOperationKey: row.source_operation_key,
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    mode: row.mode,
    sourceUpdateId: row.source_update_id,
    sourceMessageId: row.source_message_id,
    threadId: row.thread_id,
    lastTurnId: row.last_turn_id,
    currentVersion: row.current_version,
    currentDraftId: row.current_draft_id,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  }
}

function draftFromRow(row: DraftRow): ProductDecisionDraftRecord {
  return {
    id: row.id,
    flowId: row.flow_id,
    token: row.token,
    version: row.version,
    turnId: row.turn_id,
    brief: JSON.parse(row.brief_json) as ProductDecisionBrief,
    briefSha256: row.brief_sha256,
    state: row.state,
    action: row.action,
    actionOperationKey: row.action_operation_key,
    acceptanceUpdateId: row.acceptance_update_id,
    acceptanceMessageId: row.acceptance_message_id,
    acceptanceCallbackQueryId: row.acceptance_callback_query_id,
    decisionId: row.decision_id,
    gitCommit: row.git_commit,
    pushed: row.pushed === null ? null : row.pushed === 1,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    resolvedAtMs: row.resolved_at_ms,
  }
}

function token(): string {
  return randomBytes(6).toString('hex')
}

export class SqliteProductDecisionRepository {
  constructor(private readonly database: Database) {}

  createFlow(input: {
    sourceOperationKey: string
    botId: string
    chatId: string
    projectId: string
    mode: ProductDecisionMode
    sourceUpdateId: string
    sourceMessageId: string
    threadId: string
    turnId: string
    nowMs: number
  }): ProductDecisionFlowRecord {
    const existing = this.getFlowBySource(input.sourceOperationKey)
    if (existing !== null) return existing
    const id = randomUUID()
    this.database.run(
      `INSERT INTO product_decision_flows
        (id, source_operation_key, bot_id, chat_id, project_id, mode,
         source_update_id, source_message_id, thread_id, last_turn_id,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.sourceOperationKey, input.botId, input.chatId, input.projectId,
        input.mode, input.sourceUpdateId, input.sourceMessageId, input.threadId,
        input.turnId, input.nowMs, input.nowMs,
      ],
    )
    return this.requireFlow(id)
  }

  getFlowBySource(sourceOperationKey: string): ProductDecisionFlowRecord | null {
    const row = this.database.query<FlowRow, [string]>(
      'SELECT * FROM product_decision_flows WHERE source_operation_key = ?',
    ).get(sourceOperationKey)
    return row === null ? null : flowFromRow(row)
  }

  getOpenFlow(botId: string, chatId: string, projectId: string): ProductDecisionFlowRecord | null {
    const row = this.database.query<FlowRow, [string, string, string]>(
      `SELECT * FROM product_decision_flows
       WHERE bot_id = ? AND chat_id = ? AND project_id = ?
         AND state IN ('DISCUSSING', 'AWAITING_ACCEPTANCE', 'ACCEPTING')
       ORDER BY updated_at_ms DESC LIMIT 1`,
    ).get(botId, chatId, projectId)
    return row === null ? null : flowFromRow(row)
  }

  getCurrentDraft(flow: ProductDecisionFlowRecord): ProductDecisionDraftRecord | null {
    return flow.currentDraftId === null ? null : this.getDraft(flow.currentDraftId)
  }

  getLatestDraft(flowId: string): ProductDecisionDraftRecord | null {
    const row = this.database.query<DraftRow, [string]>(
      `SELECT * FROM product_decision_drafts
       WHERE flow_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(flowId)
    return row === null ? null : draftFromRow(row)
  }

  getDraftByToken(value: string): ProductDecisionDraftRecord | null {
    const row = this.database.query<DraftRow, [string]>(
      'SELECT * FROM product_decision_drafts WHERE token = ?',
    ).get(value)
    return row === null ? null : draftFromRow(row)
  }

  getFlow(id: string): ProductDecisionFlowRecord | null {
    const row = this.database.query<FlowRow, [string]>(
      'SELECT * FROM product_decision_flows WHERE id = ?',
    ).get(id)
    return row === null ? null : flowFromRow(row)
  }

  updateConversation(flowId: string, threadId: string, turnId: string, nowMs: number): void {
    this.database.run(
      `UPDATE product_decision_flows
       SET thread_id = ?, last_turn_id = ?, state = 'DISCUSSING', updated_at_ms = ?
       WHERE id = ? AND state != 'ACCEPTED' AND state != 'REJECTED'`,
      [threadId, turnId, nowMs, flowId],
    )
  }

  storeDraft(input: {
    flowId: string
    turnId: string
    brief: ProductDecisionBrief
    briefSha256: string
    nowMs: number
  }): ProductDecisionDraftRecord {
    return this.database.transaction(() => {
      const existing = this.database.query<DraftRow, [string, string]>(
        'SELECT * FROM product_decision_drafts WHERE flow_id = ? AND turn_id = ?',
      ).get(input.flowId, input.turnId)
      if (existing !== null) return draftFromRow(existing)
      const flow = this.requireFlow(input.flowId)
      const version = flow.currentVersion + 1
      const id = randomUUID()
      if (flow.currentDraftId !== null) {
        this.database.run(
          `UPDATE product_decision_drafts
           SET state = 'SUPERSEDED', updated_at_ms = ?, resolved_at_ms = ?
           WHERE id = ? AND state = 'ACTIVE'`,
          [input.nowMs, input.nowMs, flow.currentDraftId],
        )
      }
      this.database.run(
        `INSERT INTO product_decision_drafts
          (id, flow_id, token, version, turn_id, brief_json, brief_sha256,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, input.flowId, token(), version, input.turnId,
          JSON.stringify(input.brief), input.briefSha256, input.nowMs, input.nowMs,
        ],
      )
      this.database.run(
        `UPDATE product_decision_flows
         SET current_version = ?, current_draft_id = ?, state = 'AWAITING_ACCEPTANCE',
             last_turn_id = ?, updated_at_ms = ?
         WHERE id = ?`,
        [version, id, input.turnId, input.nowMs, input.flowId],
      )
      return this.requireDraft(id)
    }).immediate()
  }

  invalidateCurrentDraft(flowId: string, action: 'edit' | 'data', operationKey: string, nowMs: number): ProductDecisionFlowRecord {
    return this.database.transaction(() => {
      const flow = this.requireFlow(flowId)
      if (flow.currentDraftId !== null) {
        this.database.run(
          `UPDATE product_decision_drafts
           SET state = 'SUPERSEDED', action = ?, action_operation_key = ?,
               updated_at_ms = ?, resolved_at_ms = ?
           WHERE id = ? AND state = 'ACTIVE'`,
          [action, operationKey, nowMs, nowMs, flow.currentDraftId],
        )
      }
      this.database.run(
        `UPDATE product_decision_flows
         SET state = 'DISCUSSING', current_draft_id = NULL, updated_at_ms = ?
         WHERE id = ? AND state = 'AWAITING_ACCEPTANCE'`,
        [nowMs, flowId],
      )
      return this.requireFlow(flowId)
    }).immediate()
  }

  replaceFlow(flowId: string, operationKey: string, nowMs: number): ProductDecisionFlowRecord {
    return this.database.transaction(() => {
      const flow = this.requireFlow(flowId)
      if (flow.currentDraftId !== null) {
        this.database.run(
          `UPDATE product_decision_drafts
           SET state = 'SUPERSEDED', action = 'edit', action_operation_key = ?,
               updated_at_ms = ?, resolved_at_ms = ?
           WHERE id = ? AND state = 'ACTIVE'`,
          [operationKey, nowMs, nowMs, flow.currentDraftId],
        )
      }
      this.database.run(
        `UPDATE product_decision_flows
         SET state = 'REJECTED', current_draft_id = NULL, updated_at_ms = ?, resolved_at_ms = ?
         WHERE id = ? AND state IN ('DISCUSSING', 'AWAITING_ACCEPTANCE')`,
        [nowMs, nowMs, flowId],
      )
      return this.requireFlow(flowId)
    }).immediate()
  }

  beginDraftAction(input: {
    token: string
    chatId: string
    action: 'edit' | 'data' | 'reject'
    operationKey: string
    nowMs: number
  }): { outcome: 'started' | 'replayed' | 'closed' | 'not_found'; flow: ProductDecisionFlowRecord | null; draft: ProductDecisionDraftRecord | null } {
    return this.database.transaction(() => {
      const draft = this.getDraftByToken(input.token)
      if (draft === null) return { outcome: 'not_found' as const, flow: null, draft: null }
      const flow = this.requireFlow(draft.flowId)
      if (flow.chatId !== input.chatId) return { outcome: 'not_found' as const, flow: null, draft: null }
      if (draft.actionOperationKey === input.operationKey && draft.action === input.action) {
        return { outcome: 'replayed' as const, flow, draft }
      }
      if (draft.state !== 'ACTIVE' || flow.currentDraftId !== draft.id) {
        return { outcome: 'closed' as const, flow, draft }
      }
      const draftState = input.action === 'reject' ? 'REJECTED' : 'SUPERSEDED'
      const flowState = input.action === 'reject' ? 'REJECTED' : 'DISCUSSING'
      this.database.run(
        `UPDATE product_decision_drafts
         SET state = ?, action = ?, action_operation_key = ?, updated_at_ms = ?, resolved_at_ms = ?
         WHERE id = ? AND state = 'ACTIVE'`,
        [draftState, input.action, input.operationKey, input.nowMs, input.nowMs, draft.id],
      )
      this.database.run(
        `UPDATE product_decision_flows
         SET state = ?, current_draft_id = NULL, updated_at_ms = ?, resolved_at_ms = ?
         WHERE id = ? AND state = 'AWAITING_ACCEPTANCE'`,
        [flowState, input.nowMs, input.action === 'reject' ? input.nowMs : null, flow.id],
      )
      return {
        outcome: 'started' as const,
        flow: this.requireFlow(flow.id),
        draft: this.requireDraft(draft.id),
      }
    }).immediate()
  }

  beginAcceptance(input: {
    token: string
    chatId: string
    operationKey: string
    acceptanceUpdateId: string
    acceptanceMessageId: string
    acceptanceCallbackQueryId: string
    nowMs: number
  }): { outcome: 'started' | 'resumed' | 'accepted' | 'closed' | 'not_found'; flow: ProductDecisionFlowRecord | null; draft: ProductDecisionDraftRecord | null } {
    return this.database.transaction(() => {
      const draft = this.getDraftByToken(input.token)
      if (draft === null) return { outcome: 'not_found' as const, flow: null, draft: null }
      const flow = this.requireFlow(draft.flowId)
      if (flow.chatId !== input.chatId) return { outcome: 'not_found' as const, flow: null, draft: null }
      if (draft.state === 'ACCEPTED') return { outcome: 'accepted' as const, flow, draft }
      if (draft.state === 'ACCEPTING' && draft.actionOperationKey === input.operationKey) {
        return { outcome: 'resumed' as const, flow, draft }
      }
      if (draft.state !== 'ACTIVE' || flow.currentDraftId !== draft.id) {
        return { outcome: 'closed' as const, flow, draft }
      }
      this.database.run(
        `UPDATE product_decision_drafts
         SET state = 'ACCEPTING', action = 'accept', action_operation_key = ?,
             acceptance_update_id = coalesce(acceptance_update_id, ?),
             acceptance_message_id = coalesce(acceptance_message_id, ?),
             acceptance_callback_query_id = coalesce(acceptance_callback_query_id, ?),
             updated_at_ms = ?, last_error = NULL
         WHERE id = ? AND state = 'ACTIVE'`,
        [
          input.operationKey, input.acceptanceUpdateId, input.acceptanceMessageId,
          input.acceptanceCallbackQueryId, input.nowMs, draft.id,
        ],
      )
      this.database.run(
        `UPDATE product_decision_flows SET state = 'ACCEPTING', updated_at_ms = ?
         WHERE id = ? AND state = 'AWAITING_ACCEPTANCE'`,
        [input.nowMs, flow.id],
      )
      return {
        outcome: 'started' as const,
        flow: this.requireFlow(flow.id),
        draft: this.requireDraft(draft.id),
      }
    }).immediate()
  }

  completeAcceptance(input: {
    draftId: string
    decisionId: string
    gitCommit: string
    pushed: boolean
    nowMs: number
  }): ProductDecisionDraftRecord {
    return this.database.transaction(() => {
      const draft = this.requireDraft(input.draftId)
      this.database.run(
        `UPDATE product_decision_drafts
         SET state = 'ACCEPTED', decision_id = ?, git_commit = ?, pushed = ?,
             updated_at_ms = ?, resolved_at_ms = ?, last_error = NULL
         WHERE id = ? AND state = 'ACCEPTING'`,
        [input.decisionId, input.gitCommit, input.pushed ? 1 : 0, input.nowMs, input.nowMs, draft.id],
      )
      this.database.run(
        `UPDATE product_decision_flows
         SET state = 'ACCEPTED', updated_at_ms = ?, resolved_at_ms = ?
         WHERE id = ? AND state = 'ACCEPTING'`,
        [input.nowMs, input.nowMs, draft.flowId],
      )
      return this.requireDraft(draft.id)
    }).immediate()
  }

  failAcceptance(draftId: string, error: string, nowMs: number): ProductDecisionDraftRecord {
    return this.database.transaction(() => {
      const draft = this.requireDraft(draftId)
      this.database.run(
        `UPDATE product_decision_drafts
         SET state = 'ACTIVE', updated_at_ms = ?, last_error = ?
         WHERE id = ? AND state = 'ACCEPTING'`,
        [nowMs, error.slice(0, 500), draft.id],
      )
      this.database.run(
        `UPDATE product_decision_flows SET state = 'AWAITING_ACCEPTANCE', updated_at_ms = ?
         WHERE id = ? AND state = 'ACCEPTING'`,
        [nowMs, draft.flowId],
      )
      return this.requireDraft(draft.id)
    }).immediate()
  }

  private getDraft(id: string): ProductDecisionDraftRecord | null {
    const row = this.database.query<DraftRow, [string]>(
      'SELECT * FROM product_decision_drafts WHERE id = ?',
    ).get(id)
    return row === null ? null : draftFromRow(row)
  }

  private requireFlow(id: string): ProductDecisionFlowRecord {
    const flow = this.getFlow(id)
    if (flow === null) throw new Error(`product decision flow ${id} not found`)
    return flow
  }

  private requireDraft(id: string): ProductDecisionDraftRecord {
    const draft = this.getDraft(id)
    if (draft === null) throw new Error(`product decision draft ${id} not found`)
    return draft
  }
}
