export interface LeaseHeartbeatOptions {
  intervalMs: number
  renew: () => void
}

/**
 * Signals that ownership was lost while an external operation was still in
 * flight. Workers must not convert this into a normal retry because they no
 * longer own the durable record they would mutate.
 */
export class LeaseHeartbeatError extends Error {
  constructor() {
    super('durable lease heartbeat failed')
    this.name = 'LeaseHeartbeatError'
  }
}

export async function withLeaseHeartbeat<T>(
  options: LeaseHeartbeatOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new TypeError('lease heartbeat interval must be a positive safe integer')
  }

  let heartbeatFailed = false
  const timer = setInterval(() => {
    if (heartbeatFailed) return
    try {
      options.renew()
    } catch {
      heartbeatFailed = true
    }
  }, options.intervalMs)

  let completed = false
  let result: T | undefined
  let operationError: unknown
  try {
    result = await operation()
    completed = true
  } catch (error) {
    operationError = error
  } finally {
    clearInterval(timer)
  }

  if (heartbeatFailed) throw new LeaseHeartbeatError()
  if (!completed) throw operationError
  return result as T
}
