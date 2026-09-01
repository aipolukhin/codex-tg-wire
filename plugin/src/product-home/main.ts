#!/usr/bin/env bun

import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { ProductHomeServer } from './server.js'

const ConfigSchema = z.object({
  host: z.string().trim().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(8_788),
  publicUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  staticDirectory: z.string().trim().min(1).refine(isAbsolute),
  repositoryPath: z.string().trim().min(1).refine(isAbsolute),
  telegramTokenFile: z.string().trim().min(1).refine(isAbsolute),
  allowedUserIds: z.array(
    z.union([z.string(), z.number().int().safe()])
      .transform(String)
      .pipe(z.string().regex(/^[1-9]\d*$/)),
  ).min(1),
  initDataMaxAgeSeconds: z.number().int().min(60).max(86_400).default(3_600),
}).strict()

function readRegularFile(path: string, label: string, maxBytes: number): string {
  const file = lstatSync(path)
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > maxBytes) {
    throw new Error(`${label} is not a safe regular file`)
  }
  const value = readFileSync(path, 'utf8').trim()
  if (value.length === 0 || value.includes('\0')) throw new Error(`${label} is empty or invalid`)
  return value
}

const configPath = process.env.PRODUCT_HOME_CONFIG?.trim()
if (configPath === undefined || !isAbsolute(configPath)) {
  throw new Error('PRODUCT_HOME_CONFIG must point to an absolute JSON config path')
}
const config = ConfigSchema.parse(JSON.parse(readRegularFile(
  configPath,
  'Product Home config',
  64 * 1024,
)))
const telegramToken = readRegularFile(config.telegramTokenFile, 'Telegram bot token', 4_096)
const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ level: 'info', message, ...context })}\n`)
  },
  warn(message: string, context?: Record<string, unknown>): void {
    process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...context })}\n`)
  },
}
const server = new ProductHomeServer({
  host: config.host,
  port: config.port,
  publicUrl: config.publicUrl,
  staticDirectory: config.staticDirectory,
  repositoryPath: config.repositoryPath,
  telegramToken,
  allowedUserIds: config.allowedUserIds,
  initDataMaxAgeSeconds: config.initDataMaxAgeSeconds,
  logger,
})

server.start()
let stopped = false
function stop(signal: string): void {
  if (stopped) return
  stopped = true
  logger.info('Product Home server stopping', { signal })
  server.stop()
  process.exit(0)
}
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
