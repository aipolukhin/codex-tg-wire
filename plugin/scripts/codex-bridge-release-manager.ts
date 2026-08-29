#!/usr/bin/env bun

import {
  activateRelease,
  installReleaseArtifact,
  releaseStatus,
  rollbackRelease,
  type ReleaseStatus,
} from '../src/bridge/release-manager.js'

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  bun run manage:codex -- install --artifact <tar.gz> --checksums <sha256> --prefix <dir> [--owner <user>] [--no-activate]',
    '  bun run manage:codex -- rollback --prefix <dir>',
    '  bun run manage:codex -- activate --prefix <dir> --release <release-dir>',
    '  bun run manage:codex -- status --prefix <dir>',
    '',
  ].join('\n'))
  process.exit(2)
}

function parseOptions(args: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>()
  for (let index = 0; index < args.length;) {
    const name = args[index]
    if (name === undefined || !name.startsWith('--') || values.has(name)) usage()
    if (name === '--no-activate') {
      values.set(name, true)
      index += 1
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) usage()
    values.set(name, value)
    index += 2
  }
  return values
}

function required(values: Map<string, string | true>, name: string): string {
  const value = values.get(name)
  return typeof value === 'string' ? value : usage()
}

function printStatus(status: ReleaseStatus): void {
  for (const name of ['current', 'previous'] as const) {
    const slot = status[name]
    process.stdout.write(
      slot === null
        ? `${name}: none\n`
        : `${name}: ${slot.metadata.bridgeVersion} ${slot.metadata.commit.slice(0, 12)}\n`,
    )
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === undefined || command === '--help') usage()

try {
  const values = parseOptions(args)
  if (command === 'install') {
    const allowed = new Set(['--artifact', '--checksums', '--prefix', '--owner', '--no-activate'])
    if ([...values.keys()].some((name) => !allowed.has(name))) usage()
    const installed = installReleaseArtifact({
      artifactPath: required(values, '--artifact'),
      checksumsPath: required(values, '--checksums'),
      prefix: required(values, '--prefix'),
      ...(values.has('--owner') ? { owner: required(values, '--owner') } : {}),
      activate: !values.has('--no-activate'),
    })
    process.stdout.write(
      [
        `installed: ${installed.metadata.bridgeVersion} ${installed.metadata.commit.slice(0, 12)}${installed.activated ? ' (active)' : ''}`,
        `release: ${installed.releaseDirectory}`,
        '',
      ].join('\n'),
    )
  } else if (command === 'activate') {
    const allowed = new Set(['--prefix', '--release'])
    if ([...values.keys()].some((name) => !allowed.has(name))) usage()
    printStatus(activateRelease(required(values, '--prefix'), required(values, '--release')))
  } else if (command === 'rollback' || command === 'status') {
    if ([...values.keys()].some((name) => name !== '--prefix')) usage()
    const prefix = required(values, '--prefix')
    printStatus(command === 'rollback' ? rollbackRelease(prefix) : releaseStatus(prefix))
  } else {
    usage()
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'release operation failed'}\n`)
  process.exitCode = 1
}
