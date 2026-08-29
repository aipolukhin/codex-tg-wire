#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import pkg from '../package.json'
import compatibility from '../codex-app-server.compatibility.json'
import { createCycloneDxBom } from './supply-chain.js'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function command(commandName: string, args: readonly string[], cwd: string): Buffer {
  const result = spawnSync(commandName, [...args], { cwd, encoding: 'buffer' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${commandName} failed (${String(result.status)}): ${result.stderr.toString('utf8').trim()}`,
    )
  }
  return result.stdout
}

function writePrivate(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { mode: 0o600, flag: 'wx' })
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sourceDateEpoch(repoRoot: string): number {
  const configured = process.env.SOURCE_DATE_EPOCH?.trim()
  const raw = configured || command('git', ['show', '-s', '--format=%ct', 'HEAD'], repoRoot)
    .toString('utf8')
    .trim()
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('SOURCE_DATE_EPOCH is invalid')
  return value
}

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: bun run release:codex [--output <directory>]\n')
  process.exit(0)
}
let outputDirectory = resolve(PLUGIN_ROOT, 'dist')
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== '--output' || args[1] === undefined) {
    throw new Error('Usage: bun run release:codex [--output <directory>]')
  }
  outputDirectory = resolve(args[1])
}

const repoRoot = command('git', ['rev-parse', '--show-toplevel'], PLUGIN_ROOT)
  .toString('utf8')
  .trim()
const dirty = command('git', ['status', '--porcelain', '--untracked-files=all'], repoRoot)
  .toString('utf8')
  .trim()
if (dirty.length > 0) throw new Error('release artifacts require a clean Git worktree')

const commit = command('git', ['rev-parse', 'HEAD'], repoRoot).toString('utf8').trim()
const epoch = sourceDateEpoch(repoRoot)
const rootName = `dashi-codex-bridge-${pkg.version}`
const artifactPath = join(outputDirectory, `${rootName}.tar.gz`)
const sbomPath = join(outputDirectory, `${rootName}.cdx.json`)
const checksumsPath = join(outputDirectory, `${rootName}.sha256`)
for (const path of [artifactPath, sbomPath, checksumsPath]) {
  if (existsSync(path)) throw new Error(`release artifact already exists: ${path}`)
}

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dashi-release-'))
const packageRoot = join(temporaryRoot, rootName)
try {
  const tracked = command('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'plugin'], repoRoot)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const trackedPath of tracked) {
    const local = relative('plugin', trackedPath)
    if (local.startsWith(`..${sep}`) || local === '..') throw new Error('unsafe release path')
    writePrivate(join(packageRoot, local), command('git', ['show', `HEAD:${trackedPath}`], repoRoot))
  }
  writePrivate(join(packageRoot, 'LICENSE'), command('git', ['show', 'HEAD:LICENSE'], repoRoot))
  const sbom = `${JSON.stringify(createCycloneDxBom(PLUGIN_ROOT), null, 2)}\n`
  writePrivate(join(packageRoot, 'sbom.cdx.json'), sbom)
  writePrivate(
    join(packageRoot, 'RELEASE-METADATA.json'),
    `${JSON.stringify({
      format: 'dashi-codex-release-v1',
      version: pkg.version,
      commit,
      sourceDateEpoch: epoch,
      codexCliVersion: compatibility.codexCliVersion,
      codexSchemaSha256: compatibility.schemaSha256,
    }, null, 2)}\n`,
  )

  const tar = command(
    'tar',
    [
      '--sort=name',
      `--mtime=@${epoch}`,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-C',
      temporaryRoot,
      '-cf',
      '-',
      rootName,
    ],
    repoRoot,
  )
  writePrivate(artifactPath, gzipSync(tar, { level: 9 }))
  writePrivate(sbomPath, sbom)
  writePrivate(
    checksumsPath,
    `${digest(artifactPath)}  ${basename(artifactPath)}\n${digest(sbomPath)}  ${basename(sbomPath)}\n`,
  )
  chmodSync(artifactPath, 0o600)
  chmodSync(sbomPath, 0o600)
  chmodSync(checksumsPath, 0o600)
  process.stdout.write(
    `Release artifacts created:\n- ${artifactPath}\n- ${sbomPath}\n- ${checksumsPath}\n`,
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
