import type { Database } from 'bun:sqlite'

import type { TextTurnOperation, TextTurnResult } from '../bridge/contracts.js'

export type SessionState = 'ACTIVE' | 'ARCHIVED'
export type BindingState = 'PROVISIONAL' | 'ACTIVE' | 'ARCHIVED' | 'BROKEN'
export type TurnState = 'QUEUED' | 'ACTIVE' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'UNKNOWN'

export interface SessionRecord {
  id: string
  botId: string
  chatId: string
  projectId: string
  state: SessionState
  createdAtMs: number
  updatedAtMs: number
}

export interface ThreadBindingRecord {
  id: string
  sessionId: string
  backend: string
  threadId: string
  state: BindingState
  createdAtMs: number
  updatedAtMs: number
}

export interface TurnRecord {
  id: string
  sessionId: string
  operationKey: string
  backendTurnId: string | null
  sourceUpdateId: number | null
  state: TurnState
  request: unknown
  finalResponse: unknown | null
  createdAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
}

export interface PreparedTextOperation {
  created: boolean
  session: SessionRecord
  binding: ThreadBindingRecord | null
  turn: TurnRecord
}

export interface SessionOverview {
  session: SessionRecord | null
  binding: ThreadBindingRecord | null
  latestTurn: TurnRecord | null
  activeTurn: TurnRecord | null
}

export type ResetBindingResult =
  | { outcome: 'no_session' | 'already_new' }
  | { outcome: 'reset'; previousThreadId: string }
  | { outcome: 'blocked'; turn: TurnRecord }

interface SessionRow {
  id: string
  bot_id: string
  chat_id: string
  project_id: string
  state: SessionState
  created_at_ms: number
  updated_at_ms: number
}

interface BindingRow {
  id: string
  session_id: string
  backend: string
  thread_id: string
  state: BindingState
  created_at_ms: number
  updated_at_ms: number
}

interface TurnRow {
  id: string
  session_id: string
  operation_key: string
  backend_turn_id: string | null
  source_update_id: number | null
  state: TurnState
  request_json: string
  final_response_json: string | null
  created_at_ms: number
  started_at_ms: number | null
  finished_at_ms: number | null
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function bindingFromRow(row: BindingRow): ThreadBindingRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    backend: row.backend,
    threadId: row.thread_id,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function turnFromRow(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    operationKey: row.operation_key,
    backendTurnId: row.backend_turn_id,
    sourceUpdateId: row.source_update_id,
    state: row.state,
    request: JSON.parse(row.request_json) as unknown,
    finalResponse: row.final_response_json === null
      ? null
      : JSON.parse(row.final_response_json) as unknown,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
  }
}

export class SessionStateConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionStateConflictError'
  }
}

export class SqliteSessionRepository {
  constructor(private readonly database: Database) {}

  prepareTextOperation(
    operation: TextTurnOperation,
    backend: string,
    nowMs: number,
  ): PreparedTextOperation {
    return this.database.transaction(() => {
      let session = this.findSession(operation.botId, operation.chatId, operation.projectId)
      if (session === null) {
        const id = crypto.randomUUID()
        this.database.run(
          `INSERT INTO sessions
            (id, bot_id, chat_id, project_id, state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          [
            id,
            operation.botId,
            operation.chatId,
            operation.projectId,
            nowMs,
            nowMs,
          ],
        )
        session = this.requireSession(id)
      }
      if (session.state !== 'ACTIVE') {
        throw new SessionStateConflictError(`session ${session.id} is ${session.state}`)
      }

      const existing = this.findTurnByOperationKey(operation.operationKey)
      const binding = this.findBinding(session.id, backend)
      if (existing !== null) {
        if (existing.sessionId !== session.id) {
          throw new SessionStateConflictError(
            `operation ${operation.operationKey} belongs to another session`,
          )
        }
        return { created: false, session, binding, turn: existing }
      }

      const turnId = crypto.randomUUID()
      this.database.run(
        `INSERT INTO turns
          (id, session_id, operation_key, source_update_id, state, request_json, created_at_ms)
         VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`,
        [
          turnId,
          session.id,
          operation.operationKey,
          operation.inboxUpdateId,
          JSON.stringify(operation),
          nowMs,
        ],
      )
      return { created: true, session, binding, turn: this.requireTurn(turnId) }
    }).immediate()
  }

  markDispatching(
    localTurnId: string,
    backend: string,
    threadId: string,
    newThread: boolean,
    nowMs: number,
  ): { turn: TurnRecord; binding: ThreadBindingRecord } {
    return this.database.transaction(() => {
      const turn = this.requireTurn(localTurnId)
      if (turn.state !== 'QUEUED') {
        throw new SessionStateConflictError(`turn ${localTurnId} is ${turn.state}, expected QUEUED`)
      }

      let binding = this.findBinding(turn.sessionId, backend)
      if (binding === null) {
        const bindingId = crypto.randomUUID()
        this.database.run(
          `INSERT INTO thread_bindings
            (id, session_id, backend, thread_id, state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            bindingId,
            turn.sessionId,
            backend,
            threadId,
            newThread ? 'PROVISIONAL' : 'ACTIVE',
            nowMs,
            nowMs,
          ],
        )
        binding = this.requireBinding(bindingId)
      } else if (binding.threadId !== threadId) {
        throw new SessionStateConflictError(
          `session ${turn.sessionId} is bound to ${binding.threadId}, not ${threadId}`,
        )
      }

      const turnChange = this.database.run(
        `UPDATE turns SET state = 'ACTIVE', started_at_ms = ?
         WHERE id = ? AND state = 'QUEUED'`,
        [nowMs, localTurnId],
      ).changes
      if (turnChange !== 1) {
        throw new SessionStateConflictError(`turn ${localTurnId} could not enter ACTIVE`)
      }
      return { turn: this.requireTurn(localTurnId), binding }
    }).immediate()
  }

  markBackendTurnStarted(
    localTurnId: string,
    backendTurnId: string,
    backend: string,
    threadId: string,
    nowMs: number,
  ): TurnRecord {
    return this.database.transaction(() => {
      const turn = this.requireTurn(localTurnId)
      if (turn.state !== 'ACTIVE') {
        throw new SessionStateConflictError(`turn ${localTurnId} is ${turn.state}, expected ACTIVE`)
      }
      const binding = this.findBinding(turn.sessionId, backend)
      if (binding === null || binding.threadId !== threadId) {
        throw new SessionStateConflictError(`thread binding for ${threadId} disappeared`)
      }
      if (binding.state !== 'PROVISIONAL' && binding.state !== 'ACTIVE') {
        throw new SessionStateConflictError(`thread binding ${binding.id} is ${binding.state}`)
      }
      this.database.run(
        `UPDATE turns SET backend_turn_id = ? WHERE id = ? AND state = 'ACTIVE'`,
        [backendTurnId, localTurnId],
      )
      const bindingChange = this.database.run(
        `UPDATE thread_bindings SET state = 'ACTIVE', updated_at_ms = ?
         WHERE id = ? AND state IN ('PROVISIONAL', 'ACTIVE')`,
        [nowMs, binding.id],
      ).changes
      if (bindingChange !== 1) {
        throw new SessionStateConflictError(`thread binding ${binding.id} could not be activated`)
      }
      return this.requireTurn(localTurnId)
    }).immediate()
  }

  completeTurn(localTurnId: string, result: TextTurnResult, nowMs: number): TurnRecord {
    const changed = this.database.run(
      `UPDATE turns
       SET state = 'COMPLETED', backend_turn_id = ?, final_response_json = ?, finished_at_ms = ?
       WHERE id = ? AND state = 'ACTIVE'`,
      [result.turnId, JSON.stringify(result), nowMs, localTurnId],
    ).changes
    if (changed !== 1) {
      throw new SessionStateConflictError(`turn ${localTurnId} cannot transition to COMPLETED`)
    }
    return this.requireTurn(localTurnId)
  }

  markTerminal(
    localTurnId: string,
    state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
    errorName: string,
    nowMs: number,
  ): TurnRecord {
    const finishedAtMs = state === 'UNKNOWN' ? null : nowMs
    const changed = this.database.run(
      `UPDATE turns
       SET state = ?, final_response_json = ?, finished_at_ms = ?
       WHERE id = ? AND state = 'ACTIVE'`,
      [state, JSON.stringify({ error: errorName }), finishedAtMs, localTurnId],
    ).changes
    if (changed !== 1) {
      throw new SessionStateConflictError(`turn ${localTurnId} cannot transition to ${state}`)
    }
    return this.requireTurn(localTurnId)
  }

  getTurn(id: string): TurnRecord | null {
    const row = this.database
      .query<TurnRow, [string]>('SELECT * FROM turns WHERE id = ?')
      .get(id)
    return row === null ? null : turnFromRow(row)
  }

  getTurnByOperationKey(operationKey: string): TurnRecord | null {
    return this.findTurnByOperationKey(operationKey)
  }

  getBinding(sessionId: string, backend = 'codex'): ThreadBindingRecord | null {
    return this.findBinding(sessionId, backend)
  }

  getOverview(
    botId: string,
    chatId: string,
    projectId: string,
    backend = 'codex',
  ): SessionOverview {
    const session = this.findSession(botId, chatId, projectId)
    if (session === null) {
      return { session: null, binding: null, latestTurn: null, activeTurn: null }
    }
    return {
      session,
      binding: this.findBinding(session.id, backend),
      latestTurn: this.findLatestTurn(session.id),
      activeTurn: this.findBlockingTurn(session.id),
    }
  }

  resetBinding(
    botId: string,
    chatId: string,
    projectId: string,
    backend: string,
  ): ResetBindingResult {
    return this.database.transaction((): ResetBindingResult => {
      const session = this.findSession(botId, chatId, projectId)
      if (session === null) return { outcome: 'no_session' }
      const blocking = this.findBlockingTurn(session.id)
      if (blocking !== null) return { outcome: 'blocked', turn: blocking }
      const binding = this.findBinding(session.id, backend)
      if (binding === null) return { outcome: 'already_new' }
      this.database.run('DELETE FROM thread_bindings WHERE id = ?', [binding.id])
      return { outcome: 'reset', previousThreadId: binding.threadId }
    }).immediate()
  }

  private findSession(botId: string, chatId: string, projectId: string): SessionRecord | null {
    const row = this.database
      .query<SessionRow, [string, string, string]>(
        `SELECT * FROM sessions WHERE bot_id = ? AND chat_id = ? AND project_id = ?`,
      )
      .get(botId, chatId, projectId)
    return row === null ? null : sessionFromRow(row)
  }

  private requireSession(id: string): SessionRecord {
    const row = this.database
      .query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?')
      .get(id)
    if (row === null) throw new Error(`session ${id} not found`)
    return sessionFromRow(row)
  }

  private findBinding(sessionId: string, backend: string): ThreadBindingRecord | null {
    const row = this.database
      .query<BindingRow, [string, string]>(
        'SELECT * FROM thread_bindings WHERE session_id = ? AND backend = ?',
      )
      .get(sessionId, backend)
    return row === null ? null : bindingFromRow(row)
  }

  private requireBinding(id: string): ThreadBindingRecord {
    const row = this.database
      .query<BindingRow, [string]>('SELECT * FROM thread_bindings WHERE id = ?')
      .get(id)
    if (row === null) throw new Error(`thread binding ${id} not found`)
    return bindingFromRow(row)
  }

  private findTurnByOperationKey(operationKey: string): TurnRecord | null {
    const row = this.database
      .query<TurnRow, [string]>('SELECT * FROM turns WHERE operation_key = ?')
      .get(operationKey)
    return row === null ? null : turnFromRow(row)
  }

  private findLatestTurn(sessionId: string): TurnRecord | null {
    const row = this.database
      .query<TurnRow, [string]>(
        `SELECT * FROM turns
         WHERE session_id = ?
         ORDER BY source_update_id DESC, created_at_ms DESC, id DESC LIMIT 1`,
      )
      .get(sessionId)
    return row === null ? null : turnFromRow(row)
  }

  private findBlockingTurn(sessionId: string): TurnRecord | null {
    const row = this.database
      .query<TurnRow, [string]>(
        `SELECT * FROM turns
         WHERE session_id = ? AND state IN ('ACTIVE', 'UNKNOWN')
         ORDER BY created_at_ms DESC, id DESC LIMIT 1`,
      )
      .get(sessionId)
    return row === null ? null : turnFromRow(row)
  }

  private requireTurn(id: string): TurnRecord {
    const turn = this.getTurn(id)
    if (turn === null) throw new Error(`turn ${id} not found`)
    return turn
  }
}
