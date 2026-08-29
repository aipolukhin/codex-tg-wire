#!/usr/bin/env bun

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDurableDatabase } from '../src/durable/database.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../src/durable/sqlite-repositories.js'

interface SoakOptions {
  durationSeconds: number
  ratePerSecond: number
  databasePath: string | null
}

function parsePositive(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseArgs(args: readonly string[]): SoakOptions {
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: bun run scripts/codex-bridge-soak.ts --duration-seconds <n> [--rate <n>] [--database <path>]\n',
    )
    process.exit(0)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('soak arguments must be --key value pairs')
    }
    values.set(key, value)
  }
  const allowed = new Set(['--duration-seconds', '--rate', '--database'])
  const unknown = [...values.keys()].filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`unknown soak option: ${unknown.join(', ')}`)
  return {
    durationSeconds: parsePositive(values.get('--duration-seconds'), '--duration-seconds'),
    ratePerSecond: parsePositive(values.get('--rate') ?? '20', '--rate'),
    databasePath: values.has('--database') ? resolve(values.get('--database')!) : null,
  }
}

function verify(database: Database, expected: number): void {
  const updateCounts = database.query<{
    total: number
    processed: number
    leased: number
  }, []>(`SELECT count(*) AS total,
      sum(CASE WHEN state = 'PROCESSED' THEN 1 ELSE 0 END) AS processed,
      sum(CASE WHEN state = 'LEASED' THEN 1 ELSE 0 END) AS leased
    FROM telegram_updates`).get()
  const deliveryCounts = database.query<{
    total: number
    delivered: number
    unfinished: number
  }, []>(`SELECT count(*) AS total,
      sum(CASE WHEN state = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
      sum(CASE WHEN state != 'DELIVERED' THEN 1 ELSE 0 END) AS unfinished
    FROM delivery_jobs`).get()
  if (
    updateCounts?.total !== expected ||
    updateCounts.processed !== expected ||
    updateCounts.leased !== 0 ||
    deliveryCounts?.total !== expected ||
    deliveryCounts.delivered !== expected ||
    deliveryCounts.unfinished !== 0
  ) {
    throw new Error('soak invariant failed: acknowledged durable rows are incomplete')
  }
  const integrity = database.query<Record<string, string>, []>('PRAGMA quick_check').get()
  if (integrity === null || Object.values(integrity)[0] !== 'ok') {
    throw new Error('soak invariant failed: SQLite quick_check')
  }
}

const options = parseArgs(process.argv.slice(2))
const temporaryRoot = options.databasePath === null
  ? mkdtempSync(join(tmpdir(), 'dashi-soak-'))
  : null
const databasePath = options.databasePath ?? join(temporaryRoot!, 'soak.sqlite3')
if (options.databasePath !== null && existsSync(databasePath)) {
  throw new Error(`soak database already exists: ${databasePath}`)
}

let database = openDurableDatabase(databasePath)
let inbox = new SqliteInboxRepository(database)
let outbox = new SqliteOutboxRepository(database)
const startedAt = Date.now()
const deadline = startedAt + options.durationSeconds * 1_000
const intervalMs = Math.max(1, Math.floor(1_000 / options.ratePerSecond))
let iterations = 0
try {
  while (Date.now() < deadline) {
    const nowMs = Date.now()
    const updateId = iterations + 1
    const accepted = inbox.ingest({
      botId: 'soak',
      updateId,
      chatId: '1',
      routingClass: 'MESSAGE',
      payload: { update_id: updateId, message: { text: 'synthetic-soak-payload' } },
      receivedAtMs: nowMs,
    })
    if (!accepted.created) throw new Error('fresh soak update was deduplicated')
    const lease = inbox.claimNext({ workerId: 'soak-inbox', nowMs, leaseDurationMs: 10_000 })
    if (lease?.id !== accepted.update.id) throw new Error('soak inbox FIFO invariant failed')
    inbox.markProcessed(lease.id, 'soak-inbox', nowMs)

    const queued = outbox.enqueue({
      id: `delivery-${updateId}`,
      sourceKey: `soak:${updateId}`,
      kind: 'send_text',
      payload: { chatId: '1', text: 'synthetic-soak-response' },
      createdAtMs: nowMs,
    })
    const delivery = outbox.claimNext({ workerId: 'soak-outbox', nowMs, leaseDurationMs: 10_000 })
    if (delivery?.id !== queued.job.id) throw new Error('soak outbox FIFO invariant failed')
    outbox.markSendStarted(delivery.id, 'soak-outbox', nowMs)
    outbox.markDelivered(delivery.id, 'soak-outbox', `proof-${updateId}`, nowMs)
    iterations += 1

    if (iterations % 10 === 0) {
      const replay = inbox.ingest({
        botId: 'soak',
        updateId,
        chatId: '1',
        payload: { update_id: updateId, callback_query: { id: 'replayed' } },
        receivedAtMs: nowMs,
      })
      if (replay.created) throw new Error('soak replay protection failed')
    }
    if (iterations % 100 === 0) {
      verify(database, iterations)
      database.close()
      database = openDurableDatabase(databasePath)
      inbox = new SqliteInboxRepository(database)
      outbox = new SqliteOutboxRepository(database)
    }
    await Bun.sleep(intervalMs)
  }
  verify(database, iterations)
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      durationSeconds: Math.floor((Date.now() - startedAt) / 1_000),
      iterations,
      processRestarts: Math.floor(iterations / 100),
      acknowledgedUpdatesLost: 0,
      unfinishedDeliveries: 0,
    })}\n`,
  )
} finally {
  database.close()
  if (temporaryRoot !== null) rmSync(temporaryRoot, { recursive: true, force: true })
}
