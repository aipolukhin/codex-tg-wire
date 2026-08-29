#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import compatibility from '../codex-app-server.compatibility.json'
import { installReleaseArtifact } from '../src/bridge/release-manager.js'

function usage(): never {
  process.stderr.write(
    'Usage: bun run acceptance:codex:artifact -- --artifact <tar.gz> --checksums <sha256>\n',
  )
  process.exit(2)
}

const args = process.argv.slice(2)
const artifactIndex = args.indexOf('--artifact')
const checksumsIndex = args.indexOf('--checksums')
const artifactPath = artifactIndex < 0 ? undefined : args[artifactIndex + 1]
const checksumsPath = checksumsIndex < 0 ? undefined : args[checksumsIndex + 1]
if (
  artifactPath === undefined || checksumsPath === undefined ||
  args.length !== 4 || artifactPath.startsWith('--') || checksumsPath.startsWith('--')
) usage()

const root = mkdtempSync(join(tmpdir(), 'dashi-v1-artifact-gate-'))
try {
  const installed = installReleaseArtifact({
    artifactPath,
    checksumsPath,
    prefix: join(root, 'installation'),
  })
  if (installed.metadata.bridgeVersion !== compatibility.bridgeVersion) {
    throw new Error('artifact bridge version does not match the current acceptance gate')
  }
  const result = spawnSync('bun', ['run', 'acceptance:codex'], {
    cwd: installed.releaseDirectory,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`installed artifact acceptance failed: ${result.stderr.trim() || 'no detail'}`)
  }
  process.stdout.write(result.stdout)
  process.stdout.write(
    `Release artifact acceptance passed (${installed.metadata.bridgeVersion}, ${installed.metadata.commit.slice(0, 12)})\n`,
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'artifact acceptance failed'}\n`)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
