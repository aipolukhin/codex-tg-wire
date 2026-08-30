import type { Database } from 'bun:sqlite'

import type { TelegramTextApi } from '../telegram/durable-text-gateway.js'
import type {
  AgentBackend,
  AgentRateLimit,
  AgentRuntimeDefaults,
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
  projectCwd?: (projectId: string) => string | undefined
  settingsForChat?: (
    chatId: string,
    projectId: string,
  ) => Pick<AgentTurnSettings, 'model' | 'effort'> | null
}

const DEFAULT_TYPING_REFRESH_MS = 4_000
const DEFAULT_QUOTA_REFRESH_MS = 5 * 60_000

function compactField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const compact = value.trim().replace(/\s+/g, '')
  return compact.length === 0 ? null : compact.slice(0, 48)
}

function rateLimitWindow(
  limits: readonly AgentRateLimit[] | null,
  durationMins: number,
): AgentRateLimit['primary'] {
  if (limits === null) return null
  for (const limit of limits) {
    for (const window of [limit.primary, limit.secondary]) {
      if (window?.windowDurationMins === durationMins) return window
    }
  }
  return null
}

function remaining(window: AgentRateLimit['primary']): number | null {
  if (window === null) return null
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
}

function renderStatus(
  settings: Pick<AgentTurnSettings, 'model' | 'effort'> | null,
  defaults: AgentRuntimeDefaults | null,
  snapshot: AgentUxStatusSnapshot | null,
  limits: readonly AgentRateLimit[] | null,
): string {
  const model = compactField(settings?.model) ?? compactField(defaults?.model) ?? 'default'
  const effort = compactField(settings?.effort) ?? compactField(defaults?.effort) ?? 'default'
  const parts = [model, effort]
  const fiveHour = remaining(rateLimitWindow(limits, 5 * 60))
  const weekly = remaining(rateLimitWindow(limits, 7 * 24 * 60))
  if (fiveHour !== null) parts.push(`5h:${fiveHour}%`)
  if (weekly !== null) parts.push(`w:${weekly}%`)
  const context = snapshot?.inputTokens !== null && snapshot?.inputTokens !== undefined &&
    snapshot.contextWindow !== null && snapshot.contextWindow > 0
    ? `${Math.min(999, Math.round((snapshot.inputTokens / snapshot.contextWindow) * 100))}%`
    : '—'
  parts.push(`ctx:${context}`)
  return parts.join(' ')
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
  private readonly refreshStates = new Map<string, {
    pending: { chatId: string; projectId: string; forceQuota: boolean } | null
    promise: Promise<void>
  }>()
  private quotaCache: { limits: readonly AgentRateLimit[] | null; expiresAtMs: number } | null = null
  private readonly runtimeDefaults = new Map<
    string,
    { value: AgentRuntimeDefaults | null; expiresAtMs: number }
  >()
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly api: TelegramTextApi,
    private readonly backend: Pick<AgentBackend, 'readRateLimits' | 'readRuntimeDefaults'>,
    private readonly statusProvider: AgentUxStatusProvider,
    private readonly botId: string,
    private readonly options: TelegramNativeTurnUxOptions = {},
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
    for (const state of this.refreshStates.values()) state.pending = null
  }

  private finish(operation: TextTurnOperation): void {
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
    const [limits, defaults] = await Promise.all([
      this.readQuota(forceQuota),
      this.readDefaults(projectId, forceQuota),
    ])
    const snapshot = this.statusProvider.getStatus(this.botId, chatId, projectId)
    const settings = this.settingsForChat(chatId, projectId)
    const text = renderStatus(settings, defaults, snapshot, limits)
    const row = this.database.query<StatusPinRow, [string, string]>(
      'SELECT * FROM telegram_status_pins WHERE bot_id = ? AND chat_id = ?',
    ).get(this.botId, chatId)

    if (row?.message_id !== null && row?.message_id !== undefined && row.text === text) {
      if (row.pinned !== 1) await this.pinAndPersist(chatId, row.message_id, projectId, text, row.created_at_ms)
      return
    }

    if (row?.message_id !== null && row?.message_id !== undefined && this.api.editMessageText !== undefined) {
      try {
        await this.api.editMessageText(chatId, row.message_id, text, {})
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

  private settingsForChat(
    chatId: string,
    projectId: string,
  ): Pick<AgentTurnSettings, 'model' | 'effort'> | null {
    try {
      return this.options.settingsForChat?.(chatId, projectId) ?? null
    } catch {
      return null
    }
  }

  private async readDefaults(projectId: string, force: boolean): Promise<AgentRuntimeDefaults | null> {
    const nowMs = this.now()
    const cached = this.runtimeDefaults.get(projectId)
    if (!force && cached !== undefined && cached.expiresAtMs > nowMs) return cached.value
    if (this.backend.readRuntimeDefaults === undefined) return cached?.value ?? null
    try {
      const value = await this.backend.readRuntimeDefaults(this.options.projectCwd?.(projectId))
      this.runtimeDefaults.set(projectId, { value, expiresAtMs: nowMs + this.quotaRefreshMs })
      return value
    } catch {
      return cached?.value ?? null
    }
  }
}
