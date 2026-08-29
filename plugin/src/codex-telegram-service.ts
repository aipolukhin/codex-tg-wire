#!/usr/bin/env bun

import { bootstrapDurableBridgeService, type DurableBridgeService } from './bridge/durable-service.js'
import { BotFirstBootstrapService } from './bridge/bootstrap-onboarding.js'
import { loadBridgeBootstrapState } from './bridge/bootstrap-installation.js'
import {
  loadBridgeServiceConfig,
  resolveBridgeCredential,
  TELEGRAM_CREDENTIAL_OPTIONS,
} from './bridge/service-config.js'
import { createLogger } from './log.js'
import { redactSecrets } from './safety/redact.js'

let service: DurableBridgeService | BotFirstBootstrapService | undefined
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
let bootstrapToken: string | undefined
try {
  const bootstrapPath = process.env.CODEX_TG_WIRE_BOOTSTRAP_FILE?.trim()
  const bootstrapState = bootstrapPath === undefined || bootstrapPath.length === 0
    ? null
    : loadBridgeBootstrapState(bootstrapPath)
  if (bootstrapState !== null && bootstrapState.status !== 'complete') {
    const credential = resolveBridgeCredential(process.env, TELEGRAM_CREDENTIAL_OPTIONS)
    if (credential === null) throw new Error('Telegram bot token is required for bot-first bootstrap')
    bootstrapToken = credential.value
    const log = createLogger('codex-telegram-bootstrap', { secrets: [bootstrapToken] })
    service = await BotFirstBootstrapService.start({
      token: bootstrapToken,
      bootstrapPath: bootstrapPath as string,
      signal: startupAbort.signal,
      logger: log,
    })
    await service.wait()
    await service.stop()
    if (service.isComplete()) {
      log.info('bot-first bootstrap handed off to the production bridge')
      process.exitCode = 75
    }
  } else {
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
  }
} catch (error) {
  const secrets = config === undefined
    ? bootstrapToken === undefined ? [] : [bootstrapToken]
    : [config.telegramToken]
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
