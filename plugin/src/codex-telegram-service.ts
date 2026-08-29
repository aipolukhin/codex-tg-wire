#!/usr/bin/env bun

import { bootstrapDurableBridgeService, type DurableBridgeService } from './bridge/durable-service.js'
import { loadBridgeServiceConfig } from './bridge/service-config.js'
import { createLogger } from './log.js'
import { redactSecrets } from './safety/redact.js'

let service: DurableBridgeService | undefined
let receivedSignal: NodeJS.Signals | undefined
const startupAbort = new AbortController()

function requestShutdown(signal: NodeJS.Signals): void {
  receivedSignal ??= signal
  startupAbort.abort()
  void service?.stop().catch(() => undefined)
}

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))

let config: ReturnType<typeof loadBridgeServiceConfig> | undefined
try {
  config = loadBridgeServiceConfig()
  const log = createLogger('codex-telegram', { secrets: [config.telegramToken] })
  service = await bootstrapDurableBridgeService(config, {
    logger: log,
    signal: startupAbort.signal,
  })
  if (receivedSignal !== undefined) {
    log.info('shutdown requested during startup', { signal: receivedSignal })
    await service.stop()
  } else {
    await service.wait()
    await service.stop()
  }
} catch (error) {
  const secrets = config === undefined ? [] : [config.telegramToken]
  const log = createLogger('codex-telegram', { secrets })
  if (receivedSignal !== undefined) {
    log.info('bridge shutdown completed', { signal: receivedSignal })
    await service?.stop().catch(() => undefined)
  } else {
    log.error('bridge stopped with an error', {
      error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
    })
    process.exitCode = 1
    await service?.stop().catch(() => undefined)
  }
}
