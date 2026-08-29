import { describe, expect, test } from 'bun:test'

import { DurableTelegramRateLimiter } from '../../src/telegram/durable-rate-limiter.js'

class AutoClock {
  nowMs = 0
  readonly sleeps: number[] = []

  now = (): number => this.nowMs

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms)
    this.nowMs += ms
  }
}

function error429(retryAfter: number, nested = false): Error {
  const error = new Error('sensitive Telegram response') as Error & {
    error_code?: number
    parameters?: { retry_after: number }
    error?: { error_code: number; parameters: { retry_after: number } }
  }
  if (nested) error.error = { error_code: 429, parameters: { retry_after: retryAfter } }
  else {
    error.error_code = 429
    error.parameters = { retry_after: retryAfter }
  }
  return error
}

describe('DurableTelegramRateLimiter', () => {
  test('paces a per-chat FIFO without reordering concurrent sends', async () => {
    const clock = new AutoClock()
    const limiter = new DurableTelegramRateLimiter({
      perChatRefillPerSecond: 1,
      perChatBurst: 1,
      globalRefillPerSecond: 100,
      globalBurst: 100,
      jitterMaxMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    })
    const calls: Array<{ text: string; at: number }> = []
    const send = (text: string): Promise<string> => limiter.runSend('chat-1', 'sendMessage', async () => {
      calls.push({ text, at: clock.nowMs })
      return text
    })

    expect(await Promise.all([send('one'), send('two'), send('three')]))
      .toEqual(['one', 'two', 'three'])
    expect(calls).toEqual([
      { text: 'one', at: 0 },
      { text: 'two', at: 1_000 },
      { text: 'three', at: 2_000 },
    ])
  })

  test('applies the global bucket across independent chats', async () => {
    const clock = new AutoClock()
    const limiter = new DurableTelegramRateLimiter({
      perChatRefillPerSecond: 100,
      perChatBurst: 10,
      globalRefillPerSecond: 1,
      globalBurst: 1,
      jitterMaxMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    })
    const calls: number[] = []

    await Promise.all([
      limiter.runSend('chat-1', 'sendMessage', async () => calls.push(clock.nowMs)),
      limiter.runSend('chat-2', 'sendMessage', async () => calls.push(clock.nowMs)),
    ])
    expect(calls).toHaveLength(2)
    expect(clock.sleeps).toEqual([1_000])
  })

  test('honors bounded nested grammY retry_after without logging payloads', async () => {
    const clock = new AutoClock()
    const backoffs: unknown[] = []
    const limiter = new DurableTelegramRateLimiter({
      perChatBurst: 10,
      globalBurst: 10,
      maxAttempts: 3,
      maxRetryAfterSeconds: 5,
      jitterMaxMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      onBackoff: (event) => backoffs.push(event),
    })
    let attempts = 0
    const result = await limiter.runSend('chat-1', 'sendMessage', async () => {
      attempts += 1
      if (attempts === 1) throw error429(300, true)
      return 'delivered'
    })

    expect(result).toBe('delivered')
    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([5_000])
    expect(backoffs).toEqual([{
      method: 'sendMessage',
      attempt: 1,
      retryAfterSeconds: 5,
      waitMs: 5_000,
    }])
    expect(JSON.stringify(backoffs)).not.toContain('sensitive Telegram response')
  })

  test('stops after the configured attempt budget and preserves the original error', async () => {
    const clock = new AutoClock()
    const limiter = new DurableTelegramRateLimiter({
      maxAttempts: 2,
      jitterMaxMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    })
    const error = error429(1)
    let attempts = 0

    await expect(limiter.run('getUpdates', async () => {
      attempts += 1
      throw error
    })).rejects.toBe(error)
    expect(attempts).toBe(2)
    expect(clock.sleeps).toEqual([1_000])
  })
})
