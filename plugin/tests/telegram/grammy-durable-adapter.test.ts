import { describe, expect, test } from 'bun:test'
import type { Api } from 'grammy'

import { GrammyDurableAdapter } from '../../src/telegram/grammy-durable-adapter.js'

describe('GrammyDurableAdapter', () => {
  test('forwards polling cursor, allowlist and abort signal to grammY', async () => {
    const calls: unknown[][] = []
    const api = {
      async getUpdates(...args: unknown[]): Promise<unknown[]> {
        calls.push(args)
        return [{ update_id: 10 }]
      },
      async sendMessage(...args: unknown[]): Promise<{ message_id: number }> {
        calls.push(args)
        return { message_id: 99 }
      },
    } as unknown as Api
    const adapter = new GrammyDurableAdapter(api)
    const signal = new AbortController().signal

    expect(
      await adapter.getUpdates(
        { offset: 10, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        signal,
      ),
    ).toEqual([{ update_id: 10 }])
    expect(await adapter.sendMessage('7001', 'hello', {})).toEqual({ message_id: 99 })
    expect(calls).toEqual([
      [
        { offset: 10, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        signal,
      ],
      ['7001', 'hello', {}],
    ])
  })
})
