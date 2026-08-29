import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

export interface ReleaseMetadata {
  format: 'dashi-codex-release-v2'
  bridgeVersion: string
  packageVersion: string
  commit: string
  sourceDateEpoch: number
  bunVersion: string
  codexCliVersion: string
  codexSchemaSha256: string
}

export interface InstallReleaseOptions {
  artifactPath: string
  checksumsPath: string
  prefix: string
  owner?: string
  activate?: boolean
  installDependencies?: (releaseDirectory: string) => void
}

export interface InstalledRelease {
  releaseDirectory: string
  metadata: ReleaseMetadata
  activated: boolean
}

export interface ReleaseSlot {
  releaseDirectory: string
  metadata: ReleaseMetadata
}

export interface ReleaseStatus {
  current: ReleaseSlot | null
  previous: ReleaseSlot | null
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const OWNER = /^[A-Za-z_][A-Za-z0-9_-]*$/

function command(commandName: string, args: readonly string[], cwd?: string): string {
  const result = spawnSync(commandName, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${commandName} failed (${String(result.status)}): ${result.stderr.trim() || 'no detail'}`,
    )
  }
  return result.stdout
}

function safePrefix(path: string): string {
  if (!isAbsolute(path)) throw new Error('release prefix must be an absolute path')
  const normalized = resolve(path)
  if (normalized === parse(normalized).root) throw new Error('release prefix must not be a filesystem root')
  return normalized
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function verifyReleaseChecksum(artifactPath: string, checksumsPath: string): string {
  const expectedName = basename(artifactPath)
  const entries = readFileSync(checksumsPath, 'utf8').split(/\r?\n/).filter(Boolean)
  const expected = entries.flatMap((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/)
    return match?.[2] === expectedName && match[1] !== undefined ? [match[1]] : []
  })
  if (expected.length !== 1 || expected[0] === undefined) {
    throw new Error('checksums file must contain exactly one entry for the release artifact')
  }
  const actual = hashFile(artifactPath)
  if (actual !== expected[0]) throw new Error('release artifact checksum mismatch')
  return actual
}

export function validateArchiveEntries(entries: readonly string[]): string {
  if (entries.length === 0) throw new Error('release archive is empty')
  let root: string | null = null
  for (const entry of entries) {
    if (!entry || entry.includes('\0') || entry.includes('\\') || isAbsolute(entry)) {
      throw new Error('release archive contains an unsafe path')
    }
    const parts = entry.split('/').filter(Boolean)
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      throw new Error('release archive contains an unsafe path')
    }
    root ??= parts[0] ?? null
    if (root === null || parts[0] !== root) {
      throw new Error('release archive must contain exactly one root directory')
    }
  }
  if (!/^dashi-codex-bridge-\d+\.\d+\.\d+$/.test(root ?? '')) {
    throw new Error('release archive root has an invalid name')
  }
  return root as string
}

function assertRegularTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error('release archive contains a link or special file')
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) assertRegularTree(join(path, entry))
}

function parseReleaseMetadata(path: string): ReleaseMetadata {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error('release metadata is missing or invalid')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('release metadata is invalid')
  }
  const metadata = value as Partial<ReleaseMetadata>
  if (
    metadata.format !== 'dashi-codex-release-v2' ||
    typeof metadata.bridgeVersion !== 'string' || !SEMVER.test(metadata.bridgeVersion) ||
    typeof metadata.packageVersion !== 'string' || !SEMVER.test(metadata.packageVersion) ||
    typeof metadata.commit !== 'string' || !COMMIT.test(metadata.commit) ||
    !Number.isSafeInteger(metadata.sourceDateEpoch) || (metadata.sourceDateEpoch ?? 0) <= 0 ||
    typeof metadata.bunVersion !== 'string' || !SEMVER.test(metadata.bunVersion) ||
    typeof metadata.codexCliVersion !== 'string' || metadata.codexCliVersion.length === 0 ||
    typeof metadata.codexSchemaSha256 !== 'string' || !SHA256.test(metadata.codexSchemaSha256)
  ) {
    throw new Error('release metadata fields are invalid')
  }
  return metadata as ReleaseMetadata
}

function resolveOwner(owner: string): { uid: number; gid: number } {
  if (!OWNER.test(owner)) throw new Error('release owner has an invalid format')
  const uid = Number(command('id', ['-u', '--', owner]).trim())
  const gid = Number(command('id', ['-g', '--', owner]).trim())
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error('cannot resolve release owner')
  }
  return { uid, gid }
}

function chownTree(path: string, owner: { uid: number; gid: number }): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('refusing to chown a release symlink')
  chownSync(path, owner.uid, owner.gid)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path)) chownTree(join(path, entry), owner)
}

function releaseSlot(prefix: string, name: 'current' | 'previous'): ReleaseSlot | null {
  const slot = join(prefix, name)
  if (!existsSync(slot)) return null
  const stat = lstatSync(slot)
  if (!stat.isSymbolicLink()) throw new Error(`${name} release slot is not a symlink`)
  const target = resolve(dirname(slot), readlinkSync(slot))
  const releases = join(prefix, 'releases')
  const rel = relative(releases, target)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`${name} release slot points outside the releases directory`)
  }
  const realTarget = realpathSync(target)
  const realReleases = realpathSync(releases)
  const realRel = relative(realReleases, realTarget)
  if (!realRel || realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) {
    throw new Error(`${name} release slot resolves outside the releases directory`)
  }
  return {
    releaseDirectory: realTarget,
    metadata: parseReleaseMetadata(join(realTarget, 'RELEASE-METADATA.json')),
  }
}

function atomicReleaseLink(prefix: string, name: 'current' | 'previous', target: string): void {
  const slot = join(prefix, name)
  if (existsSync(slot) && !lstatSync(slot).isSymbolicLink()) {
    throw new Error(`${name} release slot is not a symlink`)
  }
  const temporary = join(prefix, `.${name}-${randomUUID()}`)
  try {
    symlinkSync(relative(prefix, target), temporary, 'dir')
    renameSync(temporary, slot)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function activateRelease(prefixPath: string, releaseDirectory: string): ReleaseStatus {
  const prefix = safePrefix(prefixPath)
  const releases = join(prefix, 'releases')
  const target = realpathSync(releaseDirectory)
  const targetRelative = relative(realpathSync(releases), target)
  if (!targetRelative || targetRelative.startsWith(`..${sep}`) || targetRelative === '..') {
    throw new Error('release target is outside the releases directory')
  }
  parseReleaseMetadata(join(target, 'RELEASE-METADATA.json'))
  const current = releaseSlot(prefix, 'current')
  if (current?.releaseDirectory === target) return releaseStatus(prefix)
  if (current !== null) atomicReleaseLink(prefix, 'previous', current.releaseDirectory)
  atomicReleaseLink(prefix, 'current', target)
  return releaseStatus(prefix)
}

export function installReleaseArtifact(options: InstallReleaseOptions): InstalledRelease {
  const artifactPath = realpathSync(options.artifactPath)
  const checksumsPath = realpathSync(options.checksumsPath)
  const prefix = safePrefix(options.prefix)
  verifyReleaseChecksum(artifactPath, checksumsPath)

  const entries = command('tar', ['-tzf', artifactPath]).split(/\r?\n/).filter(Boolean)
  const rootName = validateArchiveEntries(entries)
  const verbose = command('tar', ['-tvzf', artifactPath]).split(/\r?\n/).filter(Boolean)
  if (verbose.length !== entries.length || verbose.some((line) => !['-', 'd'].includes(line[0] ?? ''))) {
    throw new Error('release archive contains links or special files')
  }

  mkdirSync(prefix, { recursive: true, mode: 0o755 })
  const releases = join(prefix, 'releases')
  mkdirSync(releases, { recursive: true, mode: 0o755 })
  const temporary = mkdtempSync(join(tmpdir(), 'dashi-install-release-'))
  let target = ''
  try {
    command(
      'tar',
      ['--extract', '--gzip', '--no-same-owner', '--no-same-permissions', '--file', artifactPath, '--directory', temporary],
    )
    const packageRoot = join(temporary, rootName)
    assertRegularTree(packageRoot)
    const metadata = parseReleaseMetadata(join(packageRoot, 'RELEASE-METADATA.json'))
    if (rootName !== `dashi-codex-bridge-${metadata.bridgeVersion}`) {
      throw new Error('release archive root does not match metadata version')
    }
    target = join(releases, `${metadata.bridgeVersion}-${metadata.commit.slice(0, 12)}`)
    if (existsSync(target)) throw new Error('release is already installed; refusing overwrite')
    cpSync(packageRoot, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
    try {
      const installDependencies = options.installDependencies ?? ((directory: string) => {
        command('bun', ['install', '--frozen-lockfile', '--production'], directory)
      })
      installDependencies(target)
      if (options.owner !== undefined) chownTree(target, resolveOwner(options.owner))
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
    const activated = options.activate ?? true
    if (activated) activateRelease(prefix, target)
    return { releaseDirectory: target, metadata, activated }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function rollbackRelease(prefixPath: string): ReleaseStatus {
  const prefix = safePrefix(prefixPath)
  const previous = releaseSlot(prefix, 'previous')
  if (previous === null) throw new Error('no previous release is available for rollback')
  return activateRelease(prefix, previous.releaseDirectory)
}

export function releaseStatus(prefixPath: string): ReleaseStatus {
  const prefix = safePrefix(prefixPath)
  return {
    current: releaseSlot(prefix, 'current'),
    previous: releaseSlot(prefix, 'previous'),
  }
}
