#!/usr/bin/env bun

import { resolve } from 'node:path'

import { loadBridgeRuntimeConfig } from '../src/bridge/service-config.js'
import { createDurableBackup } from '../src/durable/backup.js'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: bun run backup:codex -- <destination.sqlite3>\n')
  process.exit(0)
}
if (args.length !== 1 || args[0]?.startsWith('-')) {
  process.stderr.write('Usage: bun run backup:codex -- <destination.sqlite3>\n')
  process.exit(2)
}

const config = loadBridgeRuntimeConfig()
const result = await createDurableBackup(config.stateDatabase, resolve(args[0]!))
process.stdout.write(
  `Backup created: ${result.backupPath}\nManifest: ${result.manifestPath}\nSchema: v${result.manifest.schemaVersion}\nSHA-256: ${result.manifest.sha256}\n`,
)
