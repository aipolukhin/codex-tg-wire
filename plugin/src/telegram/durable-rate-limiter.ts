interface TokenBucket {
  tokens: number
  capacity: number
  refillPerMs: number
  lastRefillAtMs: number
}

interface ChatState {
  bucket: TokenBucket
  tail: Promise<void>
}

export interface DurableTelegramRateLimitOptions {
  perChatRefillPerSecond?: number
  perChatBurst?: number
  globalRefillPerSecond?: number
  globalBurst?: number
  maxAttempts?: number
  maxRetryAfterSeconds?: number
  jitterMaxMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  onBackoff?: (event: {
    method: string
    attempt: number
    retryAfterSeconds: number
    waitMs: number
  }) => void
}

interface TelegramRateLimitError {
  error_code?: unknown
  parameters?: { retry_after?: unknown }
  error?: TelegramRateLimitError
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function bucket(capacity: number, refillPerSecond: number, nowMs: number): TokenBucket {
  return {
    tokens: capacity,
    capacity,
    refillPerMs: refillPerSecond / 1_000,
    lastRefillAtMs: nowMs,
  }
}

function waitForToken(state: TokenBucket, nowMs: number): number {
  const elapsed = nowMs - state.lastRefillAtMs
  if (elapsed > 0) {
    state.tokens = Math.min(state.capacity, state.tokens + elapsed * state.refillPerMs)
    state.lastRefillAtMs = nowMs
  }
  return state.tokens >= 1 ? 0 : Math.ceil((1 - state.tokens) / state.refillPerMs)
}

function telegram429(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const candidate = error as TelegramRateLimitError
  if (candidate.error !== undefined) return telegram429(candidate.error)
  if (candidate.error_code !== 429) return null
  const retryAfter = candidate.parameters?.retry_after
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter)
    : 1
}

/** Per-chat FIFO + global token bucket + bounded Telegram 429 backoff. */
export class DurableTelegramRateLimiter {
  private readonly perChatRefillPerSecond: number
  private readonly perChatBurst: number
  private readonly maxAttempts: number
  private readonly maxRetryAfterSeconds: number
  private readonly jitterMaxMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly onBackoff: DurableTelegramRateLimitOptions['onBackoff']
  private readonly globalBucket: TokenBucket
  private readonly chats = new Map<string, ChatState>()

  constructor(options: DurableTelegramRateLimitOptions = {}) {
    this.perChatRefillPerSecond = positive(
      options.perChatRefillPerSecond ?? 1,
      'perChatRefillPerSecond',
    )
    this.perChatBurst = positiveInteger(options.perChatBurst ?? 3, 'perChatBurst')
    const globalRefill = positive(
      options.globalRefillPerSecond ?? 25,
      'globalRefillPerSecond',
    )
    const globalBurst = positiveInteger(options.globalBurst ?? 25, 'globalBurst')
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, 'maxAttempts')
    this.maxRetryAfterSeconds = positiveInteger(
      options.maxRetryAfterSeconds ?? 60,
      'maxRetryAfterSeconds',
    )
    this.jitterMaxMs = options.jitterMaxMs ?? 150
    if (!Number.isSafeInteger(this.jitterMaxMs) || this.jitterMaxMs < 0) {
      throw new TypeError('jitterMaxMs must be a non-negative safe integer')
    }
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.onBackoff = options.onBackoff
    this.globalBucket = bucket(globalBurst, globalRefill, this.now())
  }

  run<T>(method: string, operation: () => Promise<T>): Promise<T> {
    return this.withRetry(method, operation)
  }

  async runSend<T>(chatId: string, method: string, operation: () => Promise<T>): Promise<T> {
    const state = this.chat(chatId)
    const previous = state.tail
    let release: () => void = () => undefined
    state.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous.catch(() => undefined)
      return await this.withRetry(method, async () => {
        await this.waitForCapacity(state.bucket)
        return operation()
      })
    } finally {
      release()
    }
  }

  private chat(chatId: string): ChatState {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const state = {
      bucket: bucket(this.perChatBurst, this.perChatRefillPerSecond, this.now()),
      tail: Promise.resolve(),
    }
    this.chats.set(chatId, state)
    return state
  }

  private async waitForCapacity(chat: TokenBucket): Promise<void> {
    while (true) {
      const nowMs = this.now()
      const waitMs = Math.max(
        waitForToken(chat, nowMs),
        waitForToken(this.globalBucket, nowMs),
      )
      if (waitMs === 0) {
        chat.tokens -= 1
        this.globalBucket.tokens -= 1
        return
      }
      await this.sleep(waitMs)
    }
  }

  private async withRetry<T>(method: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        const retryAfter = telegram429(error)
        if (retryAfter === null || attempt === this.maxAttempts) throw error
        const retryAfterSeconds = Math.min(retryAfter, this.maxRetryAfterSeconds)
        const jitter = this.jitterMaxMs === 0
          ? 0
          : Math.floor(this.random() * (this.jitterMaxMs + 1))
        const waitMs = retryAfterSeconds * 1_000 + jitter
        try {
          this.onBackoff?.({ method, attempt, retryAfterSeconds, waitMs })
        } catch {
          // Diagnostics must not affect Telegram delivery.
        }
        await this.sleep(waitMs)
      }
    }
    throw new Error('unreachable Telegram retry state')
  }
}
