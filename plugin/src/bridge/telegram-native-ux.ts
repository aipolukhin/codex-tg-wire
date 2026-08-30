import type { Database } from 'bun:sqlite'

import type { TelegramTextApi } from '../telegram/durable-text-gateway.js'
import { escapeHtml } from '../format/html.js'
import type {
  AgentBackend,
  AgentRateLimit,
  AgentTurnProgress,
  AgentTurnSettings,
  AgentTurnUxObserver,
  AgentUxStatusProvider,
  AgentUxStatusSnapshot,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'

interface StatusPinRow {
  bot_id: string
  chat_id: string
  project_id: string
  message_id: number | null
  text: string | null
  pinned: number
  created_at_ms: number
  updated_at_ms: number
}

export interface TelegramNativeTurnUxOptions {
  enabled?: boolean
  typingIndicator?: boolean
  pinnedStatus?: boolean
  typingRefreshMs?: number
  quotaRefreshMs?: number
  now?: () => number
}

const DEFAULT_TYPING_REFRESH_MS = 4_000
const DEFAULT_QUOTA_REFRESH_MS = 5 * 60_000

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes % 10_080 === 0) return `${minutes / 10_080} нед`
  if (minutes % 1_440 === 0) return `${minutes / 1_440} д`
  if (minutes % 60 === 0) return `${minutes / 60} ч`
  return `${minutes} мин`
}

function resetLabel(epochSeconds: number | null): string {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  return ` · до ${new Date(epochSeconds * 1_000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function quotaLines(limits: readonly AgentRateLimit[] | null): string[] {
  if (limits === null) return ['Квота: недоступна']
  const lines: string[] = []
  for (const limit of limits) {
    for (const [fallback, window] of [
      ['основная', limit.primary],
      ['доп.', limit.secondary],
    ] as const) {
      if (window === null) continue
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent))
      lines.push(
        `Квота ${durationLabel(window.windowDurationMins, fallback)}: ${remaining.toFixed(0)}% осталось` +
          resetLabel(window.resetsAt),
      )
      if (lines.length === 2) return lines
    }
  }
  return lines.length > 0 ? lines : ['Квота: нет данных']
}

function phaseLine(snapshot: AgentUxStatusSnapshot | null, busy: boolean): string {
  if (busy || snapshot?.phase === 'PREPARING' || snapshot?.phase === 'ACTIVE') {
    return '🟡 <b>Codex работает</b>'
  }
  if (snapshot?.phase === 'FAILED' || snapshot?.phase === 'UNKNOWN') {
    return '🔴 <b>Codex требует внимания</b>'
  }
  if (snapshot?.phase === 'INTERRUPTED') return '⚪️ <b>Codex остановлен</b>'
  return '🟢 <b>Codex готов</b>'
}

function renderStatus(
  projectId: string,
  snapshot: AgentUxStatusSnapshot | null,
  limits: readonly AgentRateLimit[] | null,
  busy: boolean,
): string {
  const lines = [
    phaseLine(snapshot, busy),
    `Проект: <code>${escapeHtml(projectId)}</code>`,
    ...quotaLines(limits),
  ]
  if (snapshot?.inputTokens !== null && snapshot?.inputTokens !== undefined) {
    const input = snapshot.inputTokens
    if (snapshot.contextWindow !== null && snapshot.contextWindow > 0) {
      const percent = Math.min(999, Math.round((input / snapshot.contextWindow) * 100))
      lines.push(
        `Контекст: ${formatTokens(input)} / ${formatTokens(snapshot.contextWindow)} · ${percent}%`,
      )
    } else {
      lines.push(`Контекст: ${formatTokens(input)}`)
    }
    const cached = Math.min(input, snapshot.cachedInputTokens ?? 0)
    lines.push(`Cached: ${formatTokens(cached)} · new ${formatTokens(input - cached)}`)
  } else {
    lines.push('Контекст: —')
  }
  return lines.join('\n')
}

/**
 * Native Telegram presence adapted from Telemax's proven split:
 * typing is ephemeral and best-effort; the single status anchor is persisted.
 */
export class TelegramNativeTurnUx implements AgentTurnUxObserver {
  private readonly typingIndicator: boolean
  private readonly pinnedStatus: boolean
  private readonly typingRefreshMs: number
  private readonly quotaRefreshMs: number
  private readonly now: () => number
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly busyOperations = new Map<string, Pick<TextTurnOperation, 'chatId' | 'projectId'>>()
  private readonly refreshStates = new Map<string, {
    pending: { chatId: string; projectId: string; forceQuota: boolean } | null
    promise: Promise<void>
  }>()
  private quotaCache: { limits: readonly AgentRateLimit[] | null; expiresAtMs: number } | null = null
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly api: TelegramTextApi,
    private readonly backend: Pick<AgentBackend, 'readRateLimits'>,
    private readonly statusProvider: AgentUxStatusProvider,
    private readonly botId: string,
    options: TelegramNativeTurnUxOptions = {},
  ) {
    const enabled = options.enabled ?? true
    this.typingIndicator = enabled && (options.typingIndicator ?? false)
    this.pinnedStatus = enabled && (options.pinnedStatus ?? false)
    this.typingRefreshMs = options.typingRefreshMs ?? DEFAULT_TYPING_REFRESH_MS
    this.quotaRefreshMs = options.quotaRefreshMs ?? DEFAULT_QUOTA_REFRESH_MS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.typingRefreshMs) || this.typingRefreshMs <= 0) {
      throw new TypeError('typingRefreshMs must be positive')
    }
    if (!Number.isSafeInteger(this.quotaRefreshMs) || this.quotaRefreshMs <= 0) {
      throw new TypeError('quotaRefreshMs must be positive')
    }
  }

  onPreparing(operation: TextTurnOperation, _settings: AgentTurnSettings): void {
    this.busyOperations.set(operation.operationKey, operation)
    this.startTyping(operation)
    void this.refreshChat(operation.chatId, operation.projectId)
  }

  onThreadReady(operation: TextTurnOperation, _threadId: string): void {
    void this.refreshChat(operation.chatId, operation.projectId)
  }

  onTurnStarted(operation: TextTurnOperation, _threadId: string, _turnId: string): void {
    void this.refreshChat(operation.chatId, operation.projectId)
  }

  onProgress(operation: TextTurnOperation, _progress: AgentTurnProgress): void {
    void this.refreshChat(operation.chatId, operation.projectId)
  }

  onCompleted(operation: TextTurnOperation, _result: TextTurnResult): void {
    this.finish(operation)
  }

  onTerminal(
    operation: TextTurnOperation,
    _state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
    _errorName: string,
  ): void {
    this.finish(operation)
  }

  /** Create or refresh the one status anchor after startup. */
  refreshChat(chatId: string, projectId: string, forceQuota = false): Promise<void> {
    if (!this.pinnedStatus || this.closed) return Promise.resolve()
    const key = `${this.botId}:${chatId}`
    const active = this.refreshStates.get(key)
    if (active !== undefined) {
      active.pending = {
        chatId,
        projectId,
        forceQuota: forceQuota || active.pending?.forceQuota === true,
      }
      return active.promise
    }
    const state: {
      pending: { chatId: string; projectId: string; forceQuota: boolean } | null
      promise: Promise<void>
    } = {
      pending: { chatId, projectId, forceQuota },
      promise: Promise.resolve(),
    }
    state.promise = (async () => {
      while (state.pending !== null && !this.closed) {
        const request = state.pending
        state.pending = null
        await this.refreshStatus(request.chatId, request.projectId, request.forceQuota)
          .catch(() => undefined)
      }
    })()
    this.refreshStates.set(key, state)
    void state.promise.then(() => {
      if (this.refreshStates.get(key) === state) this.refreshStates.delete(key)
    })
    return state.promise
  }

  close(): void {
    this.closed = true
    for (const timer of this.typingTimers.values()) clearInterval(timer)
    this.typingTimers.clear()
    this.busyOperations.clear()
    for (const state of this.refreshStates.values()) state.pending = null
  }

  private finish(operation: TextTurnOperation): void {
    this.busyOperations.delete(operation.operationKey)
    const timer = this.typingTimers.get(operation.operationKey)
    if (timer !== undefined) clearInterval(timer)
    this.typingTimers.delete(operation.operationKey)
    void this.refreshChat(operation.chatId, operation.projectId, true)
  }

  private startTyping(operation: TextTurnOperation): void {
    if (!this.typingIndicator || this.api.sendChatAction === undefined || this.closed) return
    if (this.typingTimers.has(operation.operationKey)) return
    const pulse = () => {
      if (this.closed) return
      void this.api.sendChatAction?.(operation.chatId, 'typing').catch(() => undefined)
    }
    pulse()
    const timer = setInterval(pulse, this.typingRefreshMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.typingTimers.set(operation.operationKey, timer)
  }

  private async refreshStatus(chatId: string, projectId: string, forceQuota: boolean): Promise<void> {
    if (this.closed) return
    const limits = await this.readQuota(forceQuota)
    const snapshot = this.statusProvider.getStatus(this.botId, chatId, projectId)
    const busy = [...this.busyOperations.values()].some(
      (operation) => operation.chatId === chatId && operation.projectId === projectId,
    )
    const text = renderStatus(projectId, snapshot, limits, busy)
    const row = this.database.query<StatusPinRow, [string, string]>(
      'SELECT * FROM telegram_status_pins WHERE bot_id = ? AND chat_id = ?',
    ).get(this.botId, chatId)

    if (row?.message_id !== null && row?.message_id !== undefined && row.text === text) {
      if (row.pinned !== 1) await this.pinAndPersist(chatId, row.message_id, projectId, text, row.created_at_ms)
      return
    }

    if (row?.message_id !== null && row?.message_id !== undefined && this.api.editMessageText !== undefined) {
      try {
        await this.api.editMessageText(chatId, row.message_id, text, { parse_mode: 'HTML' })
        this.persist(chatId, projectId, row.message_id, text, row.pinned === 1, row.created_at_ms)
        if (row.pinned !== 1) {
          await this.pinAndPersist(chatId, row.message_id, projectId, text, row.created_at_ms)
        }
        return
      } catch {
        // Telegram may reject an old/deleted anchor. Recreate it below, as Telemax does.
      }
    }

    let messageId: number
    try {
      const sent = await this.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_notification: true,
      })
      messageId = sent.message_id
    } catch {
      return
    }
    const createdAtMs = this.now()
    const pinned = await this.tryPin(chatId, messageId)
    this.persist(chatId, projectId, messageId, text, pinned, createdAtMs)
    if (pinned && row?.message_id !== null && row?.message_id !== undefined) {
      await this.api.deleteMessage?.(chatId, row.message_id).catch(() => undefined)
    }
  }

  private async pinAndPersist(
    chatId: string,
    messageId: number,
    projectId: string,
    text: string,
    createdAtMs: number,
  ): Promise<void> {
    const pinned = await this.tryPin(chatId, messageId)
    if (pinned) this.persist(chatId, projectId, messageId, text, true, createdAtMs)
  }

  private async tryPin(chatId: string, messageId: number): Promise<boolean> {
    if (this.api.pinChatMessage === undefined) return false
    try {
      await this.api.pinChatMessage(chatId, messageId)
      return true
    } catch {
      return false
    }
  }

  private persist(
    chatId: string,
    projectId: string,
    messageId: number,
    text: string,
    pinned: boolean,
    createdAtMs: number,
  ): void {
    const nowMs = this.now()
    this.database.run(
      `INSERT INTO telegram_status_pins
        (bot_id, chat_id, project_id, message_id, text, pinned, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, chat_id) DO UPDATE SET
         project_id = excluded.project_id,
         message_id = excluded.message_id,
         text = excluded.text,
         pinned = excluded.pinned,
         updated_at_ms = excluded.updated_at_ms`,
      [this.botId, chatId, projectId, messageId, text, pinned ? 1 : 0, createdAtMs, nowMs],
    )
  }

  private async readQuota(force: boolean): Promise<readonly AgentRateLimit[] | null> {
    const nowMs = this.now()
    if (!force && this.quotaCache !== null && this.quotaCache.expiresAtMs > nowMs) {
      return this.quotaCache.limits
    }
    if (this.backend.readRateLimits === undefined) return this.quotaCache?.limits ?? null
    try {
      const limits = await this.backend.readRateLimits()
      this.quotaCache = { limits, expiresAtMs: nowMs + this.quotaRefreshMs }
      return limits
    } catch {
      return this.quotaCache?.limits ?? null
    }
  }
}
