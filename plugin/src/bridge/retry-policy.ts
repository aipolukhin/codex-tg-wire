export interface AttemptRecord {
  attemptCount: number
}

export interface RetryPolicy {
  nextRetryAt(record: AttemptRecord, nowMs: number): number | null
}

export interface ExponentialRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export function exponentialRetryPolicy(options: ExponentialRetryOptions = {}): RetryPolicy {
  const maxAttempts = options.maxAttempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 1_000
  const maxDelayMs = options.maxDelayMs ?? 60_000
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive safe integer')
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) {
    throw new TypeError('baseDelayMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new TypeError('maxDelayMs must be a safe integer greater than or equal to baseDelayMs')
  }

  return {
    nextRetryAt(record, nowMs) {
      if (record.attemptCount >= maxAttempts) return null
      const exponent = Math.max(0, record.attemptCount - 1)
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
      return nowMs + delayMs
    },
  }
}

export function safeErrorSummary(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) return error.name
  return 'UnknownError'
}
