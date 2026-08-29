#!/usr/bin/env bun

import { initializeBridgeInstallation } from '../src/bridge/installation.js'

function usage(): never {
  process.stderr.write([
    'Usage: bun run init:codex --',
    '  --config-dir <absolute-path>',
    '  --state-dir <absolute-path>',
    '  --project <absolute-path>',
    '  --telegram-user <id>',
    '  --telegram-chat <id>',
    '  [--project-id <id>]',
    '',
  ].join(' '))
  process.exit(2)
}

const values = new Map<string, string>()
const args = process.argv.slice(2)
if (args.includes('--help')) usage()
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]
  const value = args[index + 1]
  if (name === undefined || value === undefined || !name.startsWith('--')) usage()
  if (values.has(name)) usage()
  values.set(name, value)
}
const allowed = new Set([
  '--config-dir',
  '--state-dir',
  '--project',
  '--telegram-user',
  '--telegram-chat',
  '--project-id',
])
if ([...values.keys()].some((name) => !allowed.has(name))) usage()

function required(name: string): string {
  return values.get(name) ?? usage()
}

try {
  const result = initializeBridgeInstallation({
    configDirectory: required('--config-dir'),
    stateDirectory: required('--state-dir'),
    projectPath: required('--project'),
    telegramUserId: required('--telegram-user'),
    telegramChatId: required('--telegram-chat'),
    ...(values.has('--project-id') ? { projectId: required('--project-id') } : {}),
  })
  process.stdout.write([
    'Dashi Codex bridge configuration initialized.',
    `Config: ${result.configPath}`,
    `Environment: ${result.environmentPath}`,
    `Telegram credential: ${result.telegramCredentialPath} (empty; fill privately)`,
    `State: ${result.stateDirectory}`,
    'Next: fill telegram-token, run doctor:codex, then start the service.',
    '',
  ].join('\n'))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'initialization failed'}\n`)
  process.exitCode = 1
}
