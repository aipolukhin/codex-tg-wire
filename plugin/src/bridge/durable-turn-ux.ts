import type { Database } from 'bun:sqlite'

import type {
  AgentActivity,
  AgentTurnProgress,
  AgentTurnSettings,
  AgentTurnUxObserver,
  AgentUxStatusProvider,
  AgentUxStatusSnapshot,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import type { OutboxRepository } from '../durable/contracts.js'
import type { SqliteSessionRepository, TurnState } from '../durable/session-repository.js'
import { escapeHtml } from '../format/html.js'

type UxPhase = AgentUxStatusSnapshot['phase']

interface UxRow {
  operation_key: string
  bot_id: string
  chat_id: string
  project_id: string
  thread_id: string | null
  turn_id: string | null
  root_source_key: string
  tail_source_key: string
  revision: number
  phase: UxPhase
  activity: AgentActivity
  model: string | null
  effort: string | null
  sandbox: string | null
  approval_policy: string | null
  plan_completed: number
  plan_total: number
  total_tokens: number | null
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  thread_total_tokens: number | null
  context_window: number | null
  last_activity_at_ms: number
  last_heartbeat_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

export interface DurableTurnUxOptions {
  enabled?: boolean
  /** Emit the diagnostic lifecycle card into the Telegram chat. Off by default. */
  chatStatusMessages?: boolean
  heartbeatAfterMs?: number
  heartbeatIntervalMs?: number
  now?: () => number
}

const PHASE_LABELS: Readonly<Record<UxPhase, string>> = {
  PREPARING: 'подготовка',
  ACTIVE: 'в работе',
  COMPLETED: 'готово',
  FAILED: 'ошибка',
  INTERRUPTED: 'остановлено',
  UNKNOWN: 'нужна проверка',
}

const ACTIVITY_LABELS: Readonly<Record<AgentActivity, string>> = {
  starting: 'запуск turn',
  reasoning: 'рассуждает',
  planning: 'обновляет план',
  command: 'выполняет команду',
  file_change: 'изменяет файлы',
  mcp: 'работает с инструментом',
  web_search: 'ищет в сети',
  image: 'работает с изображением',
  compacting: 'сжимает контекст',
  working: 'формирует ответ',
}

const DEFAULT_HEARTBEAT_AFTER_MS = 2 * 60_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000

function shortId(value: string | null): string {
  if (value === null) return '—'
  return value.length <= 16 ? value : `${value.slice(0, 12)}…`
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function usageLines(row: UxRow): string[] {
  const lines: string[] = []
  if (row.total_tokens !== null) lines.push(`Последний вызов: ${formatTokens(row.total_tokens)} tokens`)
  if (row.input_tokens !== null) {
    const cached = Math.min(row.input_tokens, row.cached_input_tokens ?? 0)
    const uncached = row.input_tokens - cached
    lines.push(`Вход: ${formatTokens(row.input_tokens)} · cached ${formatTokens(cached)} · new ${formatTokens(uncached)}`)
    if (row.context_window !== null && row.context_window > 0) {
      const percent = Math.min(999, Math.round((row.input_tokens / row.context_window) * 100))
      lines.push(`Окно модели: ${formatTokens(row.input_tokens)} / ${formatTokens(row.context_window)} · ${percent}%`)
    }
  }
  if (row.thread_total_tokens !== null) {
    lines.push(`Thread cumulative: ${formatTokens(row.thread_total_tokens)}`)
  }
  return lines
}

function render(row: UxRow, nowMs: number): string {
  const lines = [
    `<b>Codex · ${PHASE_LABELS[row.phase]}</b>`,
    `Проект: <code>${escapeHtml(row.project_id)}</code>`,
    `Thread: <code>${escapeHtml(shortId(row.thread_id))}</code> · Turn: <code>${escapeHtml(shortId(row.turn_id))}</code>`,
    `Активность: ${ACTIVITY_LABELS[row.activity]}`,
  ]
  if (row.plan_total > 0) lines.push(`План: ${row.plan_completed}/${row.plan_total}`)
  lines.push(...usageLines(row))
  const model = row.model ?? 'default'
  const effort = row.effort ?? 'default'
  lines.push(`Model: <code>${escapeHtml(model)}</code> · effort: <code>${escapeHtml(effort)}</code>`)
  lines.push(`Sandbox: <code>${escapeHtml(row.sandbox ?? 'default')}</code> · approval: <code>${escapeHtml(row.approval_policy ?? 'default')}</code>`)
  if (
    row.phase === 'ACTIVE' &&
    row.last_heartbeat_at_ms !== null &&
    row.last_heartbeat_at_ms >= row.last_activity_at_ms
  ) {
    const silentMinutes = Math.max(1, Math.floor((nowMs - row.last_activity_at_ms) / 60_000))
    lines.push(`Heartbeat: backend без новых событий ${silentMinutes} мин, bridge работает.`)
  }
  return lines.join('\n')
}

function snapshot(row: UxRow): AgentUxStatusSnapshot {
  return {
    phase: row.phase,
    activity: row.activity,
    planCompleted: row.plan_completed,
    planTotal: row.plan_total,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    threadTotalTokens: row.thread_total_tokens,
    contextWindow: row.context_window,
    updatedAtMs: row.updated_at_ms,
  }
}

function terminalPhase(state: Exclude<TurnState, 'QUEUED' | 'ACTIVE'>): UxPhase {
  switch (state) {
    case 'COMPLETED': return 'COMPLETED'
    case 'FAILED': return 'FAILED'
    case 'INTERRUPTED': return 'INTERRUPTED'
    case 'UNKNOWN': return 'UNKNOWN'
  }
}

/** Durable, payload-free Codex lifecycle store with an opt-in Telegram diagnostic projection. */
export class DurableTurnUxProjector implements AgentTurnUxObserver, AgentUxStatusProvider {
  private readonly enabled: boolean
  private readonly chatStatusMessages: boolean
  private readonly heartbeatAfterMs: number
  private readonly heartbeatIntervalMs: number
  private readonly now: () => number

  constructor(
    private readonly database: Database,
    private readonly outbox: OutboxRepository,
    private readonly sessions: SqliteSessionRepository,
    options: DurableTurnUxOptions = {},
  ) {
    this.enabled = options.enabled ?? true
    this.chatStatusMessages = options.chatStatusMessages ?? false
    this.heartbeatAfterMs = options.heartbeatAfterMs ?? DEFAULT_HEARTBEAT_AFTER_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.now = options.now ?? Date.now
    for (const [name, value] of [
      ['heartbeatAfterMs', this.heartbeatAfterMs],
      ['heartbeatIntervalMs', this.heartbeatIntervalMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`)
    }
  }

  onPreparing(operation: TextTurnOperation, settings: AgentTurnSettings): void {
    if (!this.enabled) return
    const nowMs = this.now()
    const rootSourceKey = `${operation.operationKey}:status`
    const existing = this.get(operation.operationKey)
    if (existing !== null) {
      this.advance(operation.operationKey, (row) => {
        if (row.phase === 'PREPARING' || row.phase === 'ACTIVE') return false
        row.phase = 'PREPARING'
        row.activity = 'starting'
        return true
      }, nowMs)
      return
    }
    this.database.transaction(() => {
      const inserted = this.database.run(
        `INSERT INTO codex_turn_ux
          (operation_key, bot_id, chat_id, project_id, root_source_key, tail_source_key,
           phase, activity, model, effort, sandbox, approval_policy,
           last_activity_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'PREPARING', 'starting', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (operation_key) DO NOTHING`,
        [
          operation.operationKey,
          operation.botId,
          operation.chatId,
          operation.projectId,
          rootSourceKey,
          rootSourceKey,
          settings.model ?? null,
          settings.effort ?? null,
          settings.sandbox ?? null,
          settings.approvalPolicy ?? null,
          nowMs,
          nowMs,
          nowMs,
        ],
      ).changes
      if (inserted !== 1) return
      if (this.chatStatusMessages) {
        const row = this.require(operation.operationKey)
        this.outbox.enqueue({
          sourceKey: rootSourceKey,
          kind: 'send_text',
          payload: {
            chatId: operation.chatId,
            text: render(row, nowMs),
            options: { parse_mode: 'HTML' },
          },
          createdAtMs: nowMs,
        })
      }
    }).immediate()
  }

  onThreadReady(operation: TextTurnOperation, threadId: string): void {
    this.advance(operation.operationKey, (row) => {
      row.thread_id = threadId
      row.phase = 'ACTIVE'
      row.activity = 'starting'
      return true
    })
  }

  onTurnStarted(operation: TextTurnOperation, threadId: string, turnId: string): void {
    this.advance(operation.operationKey, (row) => {
      row.thread_id = threadId
      row.turn_id = turnId
      row.phase = 'ACTIVE'
      row.activity = 'working'
      return true
    })
  }

  onProgress(operation: TextTurnOperation, progress: AgentTurnProgress): void {
    this.advance(operation.operationKey, (row) => {
      if (row.phase !== 'ACTIVE') return false
      if (row.turn_id !== null && row.turn_id !== progress.turnId) return false
      row.thread_id = progress.threadId
      row.turn_id = progress.turnId
      if (progress.kind === 'activity') {
        const changed = row.activity !== progress.activity
        row.activity = progress.activity
        return changed
      }
      if (progress.kind === 'plan') {
        const changed = row.plan_completed !== progress.completed || row.plan_total !== progress.total
        row.plan_completed = progress.completed
        row.plan_total = progress.total
        row.activity = 'planning'
        return changed
      }
      const previousBucket = this.usageBucket(row.input_tokens, row.context_window)
      row.total_tokens = progress.totalTokens
      row.input_tokens = progress.inputTokens
      row.cached_input_tokens = progress.cachedInputTokens
      row.output_tokens = progress.outputTokens
      row.thread_total_tokens = progress.threadTotalTokens
      row.context_window = progress.contextWindow
      const nextBucket = this.usageBucket(row.input_tokens, row.context_window)
      return previousBucket === null || previousBucket !== nextBucket
    })
  }

  onCompleted(operation: TextTurnOperation, result: TextTurnResult): void {
    this.advance(operation.operationKey, (row) => {
      row.thread_id = result.threadId
      row.turn_id = result.turnId
      row.phase = 'COMPLETED'
      row.activity = 'working'
      return true
    })
  }

  onTerminal(
    operation: TextTurnOperation,
    state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
    _errorName: string,
  ): void {
    this.advance(operation.operationKey, (row) => {
      row.phase = state
      return true
    })
  }

  getStatus(botId: string, chatId: string, projectId: string): AgentUxStatusSnapshot | null {
    const latest = this.database.query<UxRow, [string, string, string]>(
      `SELECT * FROM codex_turn_ux
       WHERE bot_id = ? AND chat_id = ? AND project_id = ?
       ORDER BY updated_at_ms DESC, operation_key DESC LIMIT 1`,
    ).get(botId, chatId, projectId)
    if (latest === null) return null

    const overview = this.sessions.getOverview(
      botId,
      chatId,
      projectId,
    )
    const selectedThreadId = overview.binding?.threadId ?? null
    const live = latest.phase === 'PREPARING' || latest.phase === 'ACTIVE'
    const row = live
      ? latest
      : selectedThreadId === null
        ? overview.session === null ? latest : null
        : this.latestForThread(botId, chatId, projectId, selectedThreadId)
    if (row === null) return null
    if (row.input_tokens !== null && row.context_window !== null && row.context_window > 0) {
      return snapshot(row)
    }

    const threadId = row.thread_id ?? selectedThreadId
    if (threadId === null) return snapshot(row)
    const previousUsage = this.latestUsageForThread(
      botId,
      chatId,
      projectId,
      threadId,
      row.operation_key,
    )
    if (previousUsage === null) return snapshot(row)
    return snapshot({
      ...row,
      total_tokens: previousUsage.total_tokens,
      input_tokens: previousUsage.input_tokens,
      cached_input_tokens: previousUsage.cached_input_tokens,
      output_tokens: previousUsage.output_tokens,
      thread_total_tokens: previousUsage.thread_total_tokens,
      context_window: previousUsage.context_window,
    })
  }

  runHeartbeat(nowMs = this.now()): number {
    if (!this.enabled) return 0
    const rows = this.database.query<UxRow, [number, number]>(
      `SELECT * FROM codex_turn_ux
       WHERE phase = 'ACTIVE' AND last_activity_at_ms <= ?
         AND (last_heartbeat_at_ms IS NULL OR last_heartbeat_at_ms <= ?)
       ORDER BY last_activity_at_ms, operation_key`,
    ).all(nowMs - this.heartbeatAfterMs, nowMs - this.heartbeatIntervalMs)
    for (const row of rows) {
      this.advance(row.operation_key, (current) => {
        current.last_heartbeat_at_ms = nowMs
        return true
      }, nowMs, false)
    }
    return rows.length
  }

  recoverStartup(): number {
    if (!this.enabled) return 0
    const rows = this.database.query<UxRow, []>(
      `SELECT * FROM codex_turn_ux WHERE phase IN ('PREPARING', 'ACTIVE')
       ORDER BY created_at_ms, operation_key`,
    ).all()
    let recovered = 0
    for (const row of rows) {
      const turn = this.sessions.getTurnByOperationKey(row.operation_key)
      if (turn === null) continue
      const state = turn.state
      if (state === 'QUEUED' || state === 'ACTIVE') continue
      this.advance(row.operation_key, (current) => {
        current.phase = terminalPhase(state)
        current.turn_id ??= turn.backendTurnId
        return true
      })
      recovered += 1
    }
    return recovered
  }

  private usageBucket(total: number | null, window: number | null): number | null {
    if (total === null) return null
    if (window === null || window <= 0) return Math.floor(total / 1_000)
    return Math.floor((total / window) * 20)
  }

  private advance(
    operationKey: string,
    mutate: (row: UxRow) => boolean,
    nowMs = this.now(),
    markActivity = true,
  ): void {
    if (!this.enabled) return
    this.database.transaction(() => {
      const row = this.get(operationKey)
      if (row === null) return
      const emit = mutate(row)
      if (markActivity) {
        row.last_activity_at_ms = Math.max(row.last_activity_at_ms, nowMs)
        row.last_heartbeat_at_ms = null
      }
      row.updated_at_ms = nowMs
      if (!emit || !this.chatStatusMessages) {
        this.persist(row)
        return
      }
      row.revision += 1
      const sourceKey = `${row.root_source_key}:edit:${row.revision}`
      this.outbox.enqueue({
        sourceKey,
        dependsOnSourceKey: row.tail_source_key,
        kind: 'edit',
        payload: {
          chatId: row.chat_id,
          targetSourceKey: row.root_source_key,
          text: render(row, nowMs),
          options: { parse_mode: 'HTML' },
        },
        createdAtMs: nowMs,
      })
      row.tail_source_key = sourceKey
      this.persist(row)
    }).immediate()
  }

  private persist(row: UxRow): void {
    this.database.run(
      `UPDATE codex_turn_ux SET
         thread_id = ?, turn_id = ?, tail_source_key = ?, revision = ?, phase = ?,
         activity = ?, plan_completed = ?, plan_total = ?, total_tokens = ?,
         input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
         thread_total_tokens = ?, context_window = ?,
         last_activity_at_ms = ?, last_heartbeat_at_ms = ?, updated_at_ms = ?
       WHERE operation_key = ?`,
      [
        row.thread_id,
        row.turn_id,
        row.tail_source_key,
        row.revision,
        row.phase,
        row.activity,
        row.plan_completed,
        row.plan_total,
        row.total_tokens,
        row.input_tokens,
        row.cached_input_tokens,
        row.output_tokens,
        row.thread_total_tokens,
        row.context_window,
        row.last_activity_at_ms,
        row.last_heartbeat_at_ms,
        row.updated_at_ms,
        row.operation_key,
      ],
    )
  }

  private get(operationKey: string): UxRow | null {
    return this.database.query<UxRow, [string]>(
      'SELECT * FROM codex_turn_ux WHERE operation_key = ?',
    ).get(operationKey)
  }

  private latestForThread(
    botId: string,
    chatId: string,
    projectId: string,
    threadId: string,
  ): UxRow | null {
    return this.database.query<UxRow, [string, string, string, string]>(
      `SELECT * FROM codex_turn_ux
       WHERE bot_id = ? AND chat_id = ? AND project_id = ? AND thread_id = ?
       ORDER BY updated_at_ms DESC, operation_key DESC LIMIT 1`,
    ).get(botId, chatId, projectId, threadId)
  }

  private latestUsageForThread(
    botId: string,
    chatId: string,
    projectId: string,
    threadId: string,
    excludeOperationKey: string,
  ): UxRow | null {
    return this.database.query<UxRow, [string, string, string, string, string]>(
      `SELECT * FROM codex_turn_ux
       WHERE bot_id = ? AND chat_id = ? AND project_id = ? AND thread_id = ?
         AND operation_key != ? AND input_tokens IS NOT NULL
         AND context_window IS NOT NULL AND context_window > 0
       ORDER BY updated_at_ms DESC, operation_key DESC LIMIT 1`,
    ).get(botId, chatId, projectId, threadId, excludeOperationKey)
  }

  private require(operationKey: string): UxRow {
    const row = this.get(operationKey)
    if (row === null) throw new Error(`Codex UX state ${operationKey} not found`)
    return row
  }
}
