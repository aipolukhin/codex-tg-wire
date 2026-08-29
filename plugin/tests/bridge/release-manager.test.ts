import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  installReleaseArtifact,
  releaseStatus,
  rollbackRelease,
  validateArchiveEntries,
  verifyReleaseChecksum,
  type ReleaseMetadata,
} from '../../src/bridge/release-manager.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function command(args: readonly string[]): void {
  const result = Bun.spawnSync(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function artifact(version: string, commitCharacter: string): {
  artifactPath: string
  checksumsPath: string
  metadata: ReleaseMetadata
} {
  const root = mkdtempSync(join(tmpdir(), 'dashi-release-manager-test-'))
  roots.push(root)
  const name = `dashi-codex-bridge-${version}`
  const packageRoot = join(root, name)
  mkdirSync(packageRoot)
  const metadata: ReleaseMetadata = {
    format: 'dashi-codex-release-v2',
    bridgeVersion: version,
    packageVersion: '1.3.0',
    commit: commitCharacter.repeat(40),
    sourceDateEpoch: 1_800_000_000,
    bunVersion: '1.4.0',
    codexCliVersion: '0.149.1',
    codexSchemaSha256: 'a'.repeat(64),
  }
  writeFileSync(join(packageRoot, 'RELEASE-METADATA.json'), JSON.stringify(metadata))
  writeFileSync(join(packageRoot, 'package.json'), '{}')
  writeFileSync(join(packageRoot, 'bun.lock'), '{"lockfileVersion":2}')
  const artifactPath = join(root, `${name}.tar.gz`)
  command(['-C', root, '-czf', artifactPath, name])
  const checksum = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
  const checksumsPath = join(root, `${name}.sha256`)
  writeFileSync(checksumsPath, `${checksum}  ${name}.tar.gz\n`)
  return { artifactPath, checksumsPath, metadata }
}

describe('release manager', () => {
  test('validates checksums and rejects unsafe archive paths', () => {
    const release = artifact('1.0.0', '1')
    expect(verifyReleaseChecksum(release.artifactPath, release.checksumsPath)).toHaveLength(64)
    writeFileSync(release.checksumsPath, `${'0'.repeat(64)}  ${release.artifactPath.split('/').at(-1)}\n`)
    expect(() => verifyReleaseChecksum(release.artifactPath, release.checksumsPath)).toThrow(
      'checksum mismatch',
    )
    expect(() => validateArchiveEntries(['../escape'])).toThrow('unsafe path')
    expect(() => validateArchiveEntries(['/absolute'])).toThrow('unsafe path')
    expect(() => validateArchiveEntries(['one/file', 'two/file'])).toThrow('one root')
  })

  test('installs immutable releases, activates and swaps rollback slots', () => {
    const installationRoot = mkdtempSync(join(tmpdir(), 'dashi-release-prefix-'))
    roots.push(installationRoot)
    const prefix = join(installationRoot, 'opt', 'dashi-codex-bridge')
    const first = artifact('1.0.0', '1')
    const second = artifact('1.0.1', '2')
    const installedDependencies: string[] = []
    const installDependencies = (directory: string) => installedDependencies.push(directory)

    const installedFirst = installReleaseArtifact({
      ...first,
      prefix,
      installDependencies,
    })
    expect(installedFirst.activated).toBeTrue()
    expect(releaseStatus(prefix).current?.metadata).toEqual(first.metadata)
    expect(releaseStatus(prefix).previous).toBeNull()

    installReleaseArtifact({ ...second, prefix, installDependencies })
    expect(releaseStatus(prefix).current?.metadata).toEqual(second.metadata)
    expect(releaseStatus(prefix).previous?.metadata).toEqual(first.metadata)
    expect(installedDependencies).toHaveLength(2)
    expect(() => installReleaseArtifact({
      ...second,
      prefix,
      installDependencies,
    })).toThrow('already installed')

    const rolledBack = rollbackRelease(prefix)
    expect(rolledBack.current?.metadata).toEqual(first.metadata)
    expect(rolledBack.previous?.metadata).toEqual(second.metadata)
  })

  test('can stage a release without changing the active slot', () => {
    const installationRoot = mkdtempSync(join(tmpdir(), 'dashi-release-stage-'))
    roots.push(installationRoot)
    const prefix = join(installationRoot, 'bridge')
    const release = artifact('1.0.0', '3')
    const installed = installReleaseArtifact({
      ...release,
      prefix,
      activate: false,
      installDependencies: () => undefined,
    })
    expect(installed.activated).toBeFalse()
    expect(releaseStatus(prefix)).toEqual({ current: null, previous: null })
  })
})
