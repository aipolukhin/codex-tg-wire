import { describe, expect, test } from 'bun:test'

import { DurableBridgeService, productHomeMenuButton } from '../../src/bridge/durable-service.js'
import type { DurableBridgeSupervisor } from '../../src/bridge/durable-supervisor.js'
import type { DurableTextRuntime } from '../../src/bridge/text-runtime.js'

describe('DurableBridgeService lifecycle', () => {
  test('keeps the persistent Mini App menu button compact', () => {
    expect(productHomeMenuButton('https://product.example/')).toEqual({
      type: 'web_app',
      text: 'PH',
      web_app: { url: 'https://product.example/' },
    })
  })

  test('drains workers before closing backend, client and database exactly once', async () => {
    const events: string[] = []
    const supervisor = {
      start(): void {
        events.push('supervisor:start')
      },
      async stop(): Promise<void> {
        events.push('supervisor:stop')
      },
      async wait(): Promise<void> {},
    } as unknown as DurableBridgeSupervisor
    const runtime = {
      close(): void {
        events.push('runtime:close')
      },
    } as unknown as DurableTextRuntime
    const client = {
      async close(): Promise<void> {
        events.push('client:close')
      },
    }
    const database = {
      close(): void {
        events.push('database:close')
      },
    }
    const service = new DurableBridgeService(
      { botId: '1', botUsername: 'bridge_bot' },
      supervisor,
      runtime,
      client,
      database,
    )

    service.start()
    expect(() => service.start()).toThrow('already started')
    await Promise.all([service.stop(), service.stop()])
    expect(events).toEqual([
      'supervisor:start',
      'supervisor:stop',
      'runtime:close',
      'client:close',
      'database:close',
    ])
    expect(() => service.start()).toThrow('stopped')
  })
})
