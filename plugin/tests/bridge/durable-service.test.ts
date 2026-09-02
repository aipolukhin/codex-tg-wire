import { describe, expect, test } from 'bun:test'

import {
  CodexAppServerUnavailableError,
  DurableBridgeService,
  productHomeMenuButton,
} from '../../src/bridge/durable-service.js'
import type { TransportClose } from '../../src/codex/transport.js'
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
      onClose(): () => void {
        return () => undefined
      },
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

  test('fails the service when its required App Server subprocess closes', async () => {
    let closeListener: ((close: TransportClose) => void) | undefined
    const supervisor = {
      start(): void {},
      async stop(): Promise<void> {},
      async wait(): Promise<void> { await new Promise(() => undefined) },
    } as unknown as DurableBridgeSupervisor
    const runtime = { close(): void {} } as unknown as DurableTextRuntime
    const client = {
      onClose(listener: (close: TransportClose) => void): () => void {
        closeListener = listener
        return () => { closeListener = undefined }
      },
      async close(): Promise<void> {},
    }
    const service = new DurableBridgeService(
      { botId: '1', botUsername: 'bridge_bot' },
      supervisor,
      runtime,
      client,
      { close(): void {} },
    )
    service.start()

    closeListener?.({ code: 137, signal: null })
    await expect(service.wait()).rejects.toBeInstanceOf(CodexAppServerUnavailableError)
    await service.stop()
  })
})
