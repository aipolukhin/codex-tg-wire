#!/usr/bin/env bun

import { formatBridgeDoctorReport, runBridgeDoctor } from '../src/bridge/doctor.js'

const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  process.stdout.write('Usage: bun run doctor:codex [--online]\n')
  process.exit(0)
}
const unknown = [...args].filter((argument) => argument !== '--online')
if (unknown.length > 0) {
  process.stderr.write(`Unknown option: ${unknown.join(', ')}\n`)
  process.exit(2)
}

const report = await runBridgeDoctor({ online: args.has('--online') })
const secrets = [
  process.env.DASHI_TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.GROQ_API_KEY,
].filter((value): value is string => value !== undefined && value.length > 0)
process.stdout.write(formatBridgeDoctorReport(report, secrets))
if (!report.ok) process.exitCode = 1
