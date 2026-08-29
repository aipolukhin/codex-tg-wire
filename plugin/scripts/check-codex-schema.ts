#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  type Dirent,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KNOWN_CODEX_NOTIFICATION_METHODS } from '../src/codex/known-notifications.js'

interface CompatibilityManifest {
  codexCliVersion: string
  schemaMode: 'stable'
  generatedFileCount: number
  schemaSha256: string
}

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(PLUGIN_ROOT, 'codex-app-server.compatibility.json')

function readManifest(): CompatibilityManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as CompatibilityManifest
}

function collectFiles(root: string, directory = root): string[] {
  const entries: Dirent[] = readdirSync(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)))
}

function hashGeneratedTree(root: string): { files: number; sha256: string } {
  const paths = collectFiles(root)
  const hash = createHash('sha256')
  for (const path of paths) {
    const normalized = relative(root, path).split(sep).join('/')
    hash.update(normalized)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return { files: paths.length, sha256: hash.digest('hex') }
}

function checkKnownNotifications(root: string): void {
  const source = readFileSync(join(root, 'ServerNotification.ts'), 'utf8')
  const generated = new Set(
    [...source.matchAll(/"method": "([^"]+)"/g)]
      .map((match) => match[1])
      .filter((method): method is string => method !== undefined),
  )
  const missing = [...generated].filter((method) => !KNOWN_CODEX_NOTIFICATION_METHODS.has(method))
  const stale = [...KNOWN_CODEX_NOTIFICATION_METHODS].filter((method) => !generated.has(method))
  if (missing.length > 0 || stale.length > 0) {
    throw new Error([
      'Codex notification method catalog is out of sync.',
      `missing: ${missing.join(', ') || '<none>'}`,
      `stale:   ${stale.join(', ') || '<none>'}`,
    ].join('\n'))
  }
}

function runCodex(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `codex ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}

const manifest = readManifest()
const codexBinary = process.env.CODEX_BINARY_PATH ?? 'codex'
const versionOutput = runCodex(codexBinary, ['--version'])
const versionMatch = versionOutput.match(/^codex-cli\s+(.+)$/)
if (versionMatch === null || versionMatch[1] === undefined) {
  throw new Error(`unexpected codex --version output: ${versionOutput}`)
}
if (versionMatch[1] !== manifest.codexCliVersion) {
  throw new Error(
    `Codex CLI mismatch: expected ${manifest.codexCliVersion}, got ${versionMatch[1]}`,
  )
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dashi-codex-schema-'))
const generatedRoot = join(tempRoot, 'generated')
try {
  runCodex(codexBinary, ['app-server', 'generate-ts', '--out', generatedRoot])
  const actual = hashGeneratedTree(generatedRoot)
  checkKnownNotifications(generatedRoot)
  if (
    actual.files !== manifest.generatedFileCount ||
    actual.sha256 !== manifest.schemaSha256
  ) {
    throw new Error(
      [
        'Codex App Server schema drift detected.',
        `expected: ${manifest.generatedFileCount} files, ${manifest.schemaSha256}`,
        `actual:   ${actual.files} files, ${actual.sha256}`,
        'Review the generated diff before updating the compatibility manifest.',
      ].join('\n'),
    )
  }
  process.stdout.write(
    `Codex App Server schema OK (${manifest.codexCliVersion}, ${actual.files} files, ${actual.sha256})\n`,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
