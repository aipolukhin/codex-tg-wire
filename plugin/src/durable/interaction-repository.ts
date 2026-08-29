import type { Database } from 'bun:sqlite'

import type { RequestId } from '../codex/protocol.js'

export type CodexInteractionKind =
  | 'COMMAND_APPROVAL'
  | 'FILE_APPROVAL'
  | 'USER_INPUT'

export type CodexInteractionState =
  | 'PENDING'
  | 'RESOLVING'
  | 'RESOLVED'
  | 'EXTERNALLY_RESOLVED'
  | 'STALE'
  | 'EXPIRED'
  | 'FAILED'

export interface CodexInteractionRecord {
  id: string
  token: string
  connectionId: string
  serverRequestId: RequestId
  sessionId: string
  threadId: string
  turnId: string
  itemId: string
  kind: CodexInteractionKind
  request: unknown
  answers: Record<string, string[]>
  response: unknown | null
  state: CodexInteractionState
  createdAtMs: number
  updatedAtMs: number
  expiresAtMs: number
  resolvedAtMs: number | null
  recoveryHandledAtMs: number | null
  lastError: string | null
}

export interface CreateCodexInteractionInput {
  connectionId: string
  serverRequestId: RequestId
  sessionId: string
  threadId: string
  turnId: string
  itemId: string
  kind: CodexInteractionKind
  request: unknown
  createdAtMs: number
  expiresAtMs: number
}

export type BeginInteractionResolution =
  | { outcome: 'started'; interaction: CodexInteractionRecord }
  | { outcome: 'closed'; interaction: CodexInteractionRecord }

export interface RecordInteractionAnswerResult {
  applied: boolean
  interaction: CodexInteractionRecord
}

interface InteractionRow {
  id: string
  token: string
  connection_id: string
  server_request_id_json: string
  session_id: string
  thread_id: string
  turn_id: string
  item_id: string
  kind: CodexInteractionKind
  request_json: string
  answers_json: string
  response_json: string | null
  state: CodexInteractionState
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number
  resolved_at_ms: number | null
  recovery_handled_at_ms: number | null
  last_error: string | null
}

function encodeJson(value: unknown, name: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError(`${name} must be JSON-serializable`)
  return encoded
}

function requestIdJson(requestId: RequestId): string {
  return encodeJson(requestId, 'serverRequestId')
}

function interactionFromRow(row: InteractionRow): CodexInteractionRecord {
  return {
    id: row.id,
    token: row.token,
    connectionId: row.connection_id,
    serverRequestId: JSON.parse(row.server_request_id_json) as RequestId,
    sessionId: row.session_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    kind: row.kind,
    request: JSON.parse(row.request_json) as unknown,
    answers: JSON.parse(row.answers_json) as Record<string, string[]>,
    response: row.response_json === null ? null : JSON.parse(row.response_json) as unknown,
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms,
    resolvedAtMs: row.resolved_at_ms,
    recoveryHandledAtMs: row.recovery_handled_at_ms,
    lastError: row.last_error,
  }
}

function interactionToken(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12)
}

export class SqliteCodexInteractionRepository {
  constructor(private readonly database: Database) {}

  create(input: CreateCodexInteractionInput): { created: boolean; interaction: CodexInteractionRecord } {
    if (input.expiresAtMs <= input.createdAtMs) {
      throw new TypeError('interaction expiry must be after creation')
    }
    const existing = this.getByServerRequest(input.connectionId, input.serverRequestId)
    if (existing !== null) return { created: false, interaction: existing }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = crypto.randomUUID()
      const token = interactionToken()
      try {
        this.database.run(
          `INSERT INTO codex_interactions
            (id, token, connection_id, server_request_id_json, session_id, thread_id,
             turn_id, item_id, kind, request_json, created_at_ms, updated_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            token,
            input.connectionId,
            requestIdJson(input.serverRequestId),
            input.sessionId,
            input.threadId,
            input.turnId,
            input.itemId,
            input.kind,
            encodeJson(input.request, 'request'),
            input.createdAtMs,
            input.createdAtMs,
            input.expiresAtMs,
          ],
        )
        return { created: true, interaction: this.require(id) }
      } catch (error) {
        const raced = this.getByServerRequest(input.connectionId, input.serverRequestId)
        if (raced !== null) return { created: false, interaction: raced }
        if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed')) throw error
      }
    }
    throw new Error('could not allocate a unique interaction token')
  }

  get(id: string): CodexInteractionRecord | null {
    const row = this.database
      .query<InteractionRow, [string]>('SELECT * FROM codex_interactions WHERE id = ?')
      .get(id)
    return row === null ? null : interactionFromRow(row)
  }

  getByToken(token: string): CodexInteractionRecord | null {
    const row = this.database
      .query<InteractionRow, [string]>('SELECT * FROM codex_interactions WHERE token = ?')
      .get(token)
    return row === null ? null : interactionFromRow(row)
  }

  getByServerRequest(connectionId: string, requestId: RequestId): CodexInteractionRecord | null {
    const row = this.database
      .query<InteractionRow, [string, string]>(
        `SELECT * FROM codex_interactions
         WHERE connection_id = ? AND server_request_id_json = ?`,
      )
      .get(connectionId, requestIdJson(requestId))
    return row === null ? null : interactionFromRow(row)
  }

  recordAnswer(
    token: string,
    chatSessionId: string,
    questionId: string,
    answers: readonly string[],
    nowMs: number,
  ): RecordInteractionAnswerResult {
    if (questionId.trim().length === 0 || answers.length === 0) {
      throw new TypeError('questionId and at least one answer are required')
    }
    return this.database.transaction(() => {
      const interaction = this.requireByToken(token)
      if (interaction.sessionId !== chatSessionId) throw new Error('interaction belongs to another session')
      if (interaction.state !== 'PENDING' || interaction.answers[questionId] !== undefined) {
        return { applied: false, interaction }
      }
      const nextAnswers = { ...interaction.answers, [questionId]: [...answers] }
      this.database.run(
        `UPDATE codex_interactions SET answers_json = ?, updated_at_ms = ?
         WHERE id = ? AND state = 'PENDING'`,
        [encodeJson(nextAnswers, 'answers'), nowMs, interaction.id],
      )
      return { applied: true, interaction: this.require(interaction.id) }
    }).immediate()
  }

  beginResolution(
    token: string,
    chatSessionId: string,
    response: unknown,
    nowMs: number,
  ): BeginInteractionResolution {
    return this.database.transaction((): BeginInteractionResolution => {
      const interaction = this.requireByToken(token)
      if (interaction.sessionId !== chatSessionId) throw new Error('interaction belongs to another session')
      if (interaction.state !== 'PENDING') return { outcome: 'closed', interaction }
      this.database.run(
        `UPDATE codex_interactions
         SET state = 'RESOLVING', response_json = ?, updated_at_ms = ?, last_error = NULL
         WHERE id = ? AND state = 'PENDING'`,
        [encodeJson(response, 'response'), nowMs, interaction.id],
      )
      return { outcome: 'started', interaction: this.require(interaction.id) }
    }).immediate()
  }

  beginTimeoutResolution(id: string, response: unknown, nowMs: number): BeginInteractionResolution {
    return this.database.transaction((): BeginInteractionResolution => {
      const interaction = this.require(id)
      if (interaction.state !== 'PENDING') return { outcome: 'closed', interaction }
      this.database.run(
        `UPDATE codex_interactions
         SET state = 'RESOLVING', response_json = ?, updated_at_ms = ?,
             last_error = 'interaction expired before owner response'
         WHERE id = ? AND state = 'PENDING'`,
        [encodeJson(response, 'response'), nowMs, interaction.id],
      )
      return { outcome: 'started', interaction: this.require(interaction.id) }
    }).immediate()
  }

  markResolved(id: string, nowMs: number): CodexInteractionRecord {
    const changed = this.database.run(
      `UPDATE codex_interactions
       SET state = 'RESOLVED', updated_at_ms = ?, resolved_at_ms = ?, last_error = NULL
       WHERE id = ? AND state = 'RESOLVING'`,
      [nowMs, nowMs, id],
    ).changes
    if (changed !== 1) throw new Error(`interaction ${id} cannot transition to RESOLVED`)
    return this.require(id)
  }

  markExpired(id: string, nowMs: number): CodexInteractionRecord {
    const changed = this.database.run(
      `UPDATE codex_interactions
       SET state = 'EXPIRED', updated_at_ms = ?, resolved_at_ms = ?,
           last_error = 'interaction expired before owner response'
       WHERE id = ? AND state = 'RESOLVING'`,
      [nowMs, nowMs, id],
    ).changes
    if (changed !== 1) throw new Error(`interaction ${id} cannot transition to EXPIRED`)
    return this.require(id)
  }

  markFailed(id: string, error: string, nowMs: number): CodexInteractionRecord {
    this.database.run(
      `UPDATE codex_interactions
       SET state = 'FAILED', updated_at_ms = ?, resolved_at_ms = ?, last_error = ?
       WHERE id = ? AND state = 'PENDING'`,
      [nowMs, nowMs, error, id],
    )
    return this.require(id)
  }

  markExternallyResolved(
    connectionId: string,
    requestId: RequestId,
    threadId: string,
    nowMs: number,
  ): CodexInteractionRecord | null {
    const interaction = this.getByServerRequest(connectionId, requestId)
    if (interaction === null || interaction.threadId !== threadId) return interaction
    this.database.run(
      `UPDATE codex_interactions
       SET state = 'EXTERNALLY_RESOLVED', updated_at_ms = ?, resolved_at_ms = ?
       WHERE id = ? AND state IN ('PENDING', 'RESOLVING')`,
      [nowMs, nowMs, interaction.id],
    )
    return this.require(interaction.id)
  }

  markConnectionStale(connectionId: string, nowMs: number): number {
    return this.database.run(
      `UPDATE codex_interactions
       SET state = 'STALE', updated_at_ms = ?, resolved_at_ms = ?,
           recovery_handled_at_ms = NULL,
           last_error = 'App Server connection closed before resolution'
       WHERE connection_id = ? AND state IN ('PENDING', 'RESOLVING')`,
      [nowMs, nowMs, connectionId],
    ).changes
  }

  markAbandonedConnectionsStale(activeConnectionId: string, nowMs: number): number {
    return this.database.run(
      `UPDATE codex_interactions
       SET state = 'STALE', updated_at_ms = ?, resolved_at_ms = ?,
           recovery_handled_at_ms = NULL,
           last_error = 'interaction belongs to a previous App Server connection'
       WHERE connection_id != ? AND state IN ('PENDING', 'RESOLVING')`,
      [nowMs, nowMs, activeConnectionId],
    ).changes
  }

  listStaleForRecovery(): CodexInteractionRecord[] {
    return this.database
      .query<InteractionRow, []>(
        `SELECT * FROM codex_interactions
         WHERE state = 'STALE' AND recovery_handled_at_ms IS NULL
         ORDER BY created_at_ms, id`,
      )
      .all()
      .map(interactionFromRow)
  }

  markRecoveryHandled(id: string, nowMs: number): CodexInteractionRecord {
    this.database.run(
      `UPDATE codex_interactions
       SET recovery_handled_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND state = 'STALE' AND recovery_handled_at_ms IS NULL`,
      [nowMs, nowMs, id],
    )
    return this.require(id)
  }

  private require(id: string): CodexInteractionRecord {
    const interaction = this.get(id)
    if (interaction === null) throw new Error(`interaction ${id} not found`)
    return interaction
  }

  private requireByToken(token: string): CodexInteractionRecord {
    const interaction = this.getByToken(token)
    if (interaction === null) throw new Error(`interaction ${token} not found`)
    return interaction
  }
}
