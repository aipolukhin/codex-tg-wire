#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'

import { Bot } from 'grammy'

import { initializeBridgeBootstrap } from '../src/bridge/bootstrap-installation.js'

function usage(): never {
  process.stderr.write([
    'Usage: bun scripts/codex-bridge-bootstrap-init.ts',
    '  --config-dir <absolute-path>',
    '  --state-dir <absolute-path>',
    '  --default-project <absolute-path>',
    '  --deployment <host|docker>',
    '  [--profile <auto|yolo|safe>]',
    '  [--groq-credential-path <absolute-path>]',
    '',
    'Reads the Telegram bot token from stdin and prints only the one-time onboarding URL.',
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
  if (name === undefined || value === undefined || !name.startsWith('--') || values.has(name)) usage()
  values.set(name, value)
}
const allowed = new Set([
  '--config-dir',
  '--state-dir',
  '--default-project',
  '--deployment',
  '--profile',
  '--groq-credential-path',
])
if ([...values.keys()].some((name) => !allowed.has(name))) usage()
function required(name: string): string {
  return values.get(name) ?? usage()
}

const deployment = required('--deployment')
if (deployment !== 'host' && deployment !== 'docker') usage()
const profile = values.get('--profile') ?? 'auto'
if (profile !== 'auto' && profile !== 'yolo' && profile !== 'safe') usage()
const token = (await Bun.stdin.text()).trim()
if (token.length === 0) {
  process.stderr.write('Telegram bot token must not be empty\n')
  process.exit(1)
}

let bot: Bot
try {
  bot = new Bot(token)
  await bot.init()
} catch {
  process.stderr.write('Telegram rejected the bot token or is temporarily unavailable\n')
  process.exit(1)
}

try {
  const configDirectory = required('--config-dir')
  const result = initializeBridgeBootstrap({
    bootstrapPath: `${configDirectory}/bootstrap-state.json`,
    configDirectory,
    stateDirectory: required('--state-dir'),
    defaultProjectPath: required('--default-project'),
    deployment,
    botId: String(bot.botInfo.id),
    botUsername: bot.botInfo.username,
    nonce: randomBytes(24).toString('base64url'),
    telegramToken: token,
    ...(profile === 'auto' ? {} : { presetProfile: profile }),
    ...(values.has('--groq-credential-path')
      ? { groqCredentialPath: required('--groq-credential-path') }
      : {}),
  })
  process.stdout.write(`${result.onboardingUrl}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'bootstrap initialization failed'}\n`)
  process.exitCode = 1
}
