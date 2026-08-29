#!/usr/bin/env bun

import { runV1AcceptanceGate } from '../src/bridge/v1-acceptance.js'

try {
  const report = await runV1AcceptanceGate()
  process.stdout.write(`Dashi Codex v1 acceptance passed\n${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'v1 acceptance failed'}\n`)
  process.exitCode = 1
}
