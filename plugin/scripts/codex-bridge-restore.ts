#!/usr/bin/env bun

import { resolve } from 'node:path'

import { loadBridgeRuntimeConfig } from '../src/bridge/service-config.js'
import { restoreDurableBackup } from '../src/durable/backup.js'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: bun run restore:codex -- <backup.sqlite3> [--replace]\n')
  process.exit(0)
}
const replace = args.includes('--replace')
const positional = args.filter((argument) => argument !== '--replace')
const unknown = positional.filter((argument) => argument.startsWith('-'))
if (positional.length !== 1 || unknown.length > 0) {
  process.stderr.write('Usage: bun run restore:codex -- <backup.sqlite3> [--replace]\n')
  process.exit(2)
}

const config = loadBridgeRuntimeConfig()
const result = await restoreDurableBackup(resolve(positional[0]!), config.stateDatabase, { replace })
process.stdout.write(
  [
    `Database restored: ${result.targetPath}`,
    `Schema: v${result.schemaVersion}`,
    `Manifest: ${result.manifestVerified ? 'verified' : 'not present (SQLite integrity verified)'}`,
    ...(result.previousDatabasePath === null
      ? []
      : [`Previous database retained: ${result.previousDatabasePath}`]),
  ].join('\n') + '\n',
)
