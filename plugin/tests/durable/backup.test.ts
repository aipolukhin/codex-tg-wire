import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

import {
  createDurableBackup,
  DURABLE_BACKUP_FORMAT,
  restoreDurableBackup,
} from '../../src/durable/backup.js'
import {
  LATEST_DURABLE_SCHEMA_VERSION,
  openDurableDatabase,
} from '../../src/durable/database.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dashi-backup-'))
  roots.push(root)
  return root
}

describe('durable SQLite backup and restore', () => {
  test('creates a consistent online snapshot and a private hash manifest', async () => {
    const root = rootFixture()
    const sourcePath = join(root, 'state.sqlite3')
    const backupPath = join(root, 'backups', 'state.sqlite3')
    const live = openDurableDatabase(sourcePath)
    live.run('CREATE TABLE backup_probe (value TEXT NOT NULL)')
    live.run("INSERT INTO backup_probe VALUES ('visible-from-wal')")

    const result = await createDurableBackup(
      sourcePath,
      backupPath,
      new Date('2026-08-29T12:00:00.000Z'),
    )

    expect(result.manifest.format).toBe(DURABLE_BACKUP_FORMAT)
    expect(result.manifest.createdAt).toBe('2026-08-29T12:00:00.000Z')
    expect(result.manifest.schemaVersion).toBe(LATEST_DURABLE_SCHEMA_VERSION)
    expect(result.manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600)
    const snapshot = new Database(backupPath, { readonly: true })
    expect(snapshot.query<{ value: string }, []>('SELECT value FROM backup_probe').get()?.value)
      .toBe('visible-from-wal')
    snapshot.close()
    live.close()
  })

  test('refuses to overwrite a backup destination', async () => {
    const root = rootFixture()
    const sourcePath = join(root, 'state.sqlite3')
    const destinationPath = join(root, 'backup.sqlite3')
    openDurableDatabase(sourcePath).close()
    writeFileSync(destinationPath, 'keep-me')

    await expect(createDurableBackup(sourcePath, destinationPath)).rejects.toThrow(
      'already exists',
    )
    expect(readFileSync(destinationPath, 'utf8')).toBe('keep-me')
  })

  test('verifies the manifest before restoring', async () => {
    const root = rootFixture()
    const sourcePath = join(root, 'source.sqlite3')
    const backupPath = join(root, 'backup.sqlite3')
    const targetPath = join(root, 'restored.sqlite3')
    openDurableDatabase(sourcePath).close()
    const result = await createDurableBackup(sourcePath, backupPath)
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { sha256: string }
    manifest.sha256 = '0'.repeat(64)
    writeFileSync(result.manifestPath, JSON.stringify(manifest))

    await expect(restoreDurableBackup(backupPath, targetPath)).rejects.toThrow(
      'SHA-256 does not match',
    )
    expect(existsSync(targetPath)).toBeFalse()
  })

  test('migrates an older valid backup forward during restore', async () => {
    const root = rootFixture()
    const backupPath = join(root, 'legacy.sqlite3')
    const targetPath = join(root, 'restored.sqlite3')
    const legacy = new Database(backupPath, { create: true, strict: true })
    legacy.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )`)
    legacy.close()

    const result = await restoreDurableBackup(backupPath, targetPath)

    expect(result.manifestVerified).toBeFalse()
    expect(result.schemaVersion).toBe(LATEST_DURABLE_SCHEMA_VERSION)
    const restored = new Database(targetPath, { readonly: true })
    expect(
      restored.query<{ version: number }, []>('SELECT max(version) AS version FROM schema_migrations').get()?.version,
    ).toBe(LATEST_DURABLE_SCHEMA_VERSION)
    restored.close()
  })

  test('retains the previous target when an offline replace is requested', async () => {
    const root = rootFixture()
    const sourcePath = join(root, 'source.sqlite3')
    const backupPath = join(root, 'backup.sqlite3')
    const targetPath = join(root, 'target.sqlite3')
    const source = openDurableDatabase(sourcePath)
    source.run("CREATE TABLE backup_probe (value TEXT NOT NULL DEFAULT 'new')")
    source.close()
    await createDurableBackup(sourcePath, backupPath)
    const target = openDurableDatabase(targetPath)
    target.run("CREATE TABLE old_probe (value TEXT NOT NULL DEFAULT 'old')")
    target.close()

    await expect(restoreDurableBackup(backupPath, targetPath)).rejects.toThrow('--replace')
    const result = await restoreDurableBackup(backupPath, targetPath, {
      replace: true,
      now: new Date('2026-08-29T12:34:56.000Z'),
    })

    expect(result.previousDatabasePath).toBe(`${targetPath}.pre-restore-20260829T123456Z`)
    expect(result.manifestVerified).toBeTrue()
    const restored = new Database(targetPath, { readonly: true })
    expect(restored.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='backup_probe'",
    ).get()?.name).toBe('backup_probe')
    restored.close()
    const previous = new Database(result.previousDatabasePath!, { readonly: true })
    expect(previous.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='old_probe'",
    ).get()?.name).toBe('old_probe')
    previous.close()
  })

  test('refuses replacement while SQLite sidecars are present', async () => {
    const root = rootFixture()
    const sourcePath = join(root, 'source.sqlite3')
    const backupPath = join(root, 'backup.sqlite3')
    const targetPath = join(root, 'target.sqlite3')
    openDurableDatabase(sourcePath).close()
    await createDurableBackup(sourcePath, backupPath)
    openDurableDatabase(targetPath).close()
    writeFileSync(`${targetPath}-wal`, 'active')
    chmodSync(`${targetPath}-wal`, 0o600)

    await expect(
      restoreDurableBackup(backupPath, targetPath, { replace: true }),
    ).rejects.toThrow('stop the service cleanly')
    expect(existsSync(targetPath)).toBeTrue()
  })
})
