import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import { Database } from 'bun:sqlite'

import { LATEST_DURABLE_SCHEMA_VERSION, openDurableDatabase } from './database.js'

export const DURABLE_BACKUP_FORMAT = 'dashi-durable-backup-v1' as const

export interface DurableBackupManifest {
  format: typeof DURABLE_BACKUP_FORMAT
  createdAt: string
  sqliteBytes: number
  sha256: string
  schemaVersion: number
}

export interface DurableBackupResult {
  backupPath: string
  manifestPath: string
  manifest: DurableBackupManifest
}

export interface DurableRestoreOptions {
  replace?: boolean
  now?: Date
}

export interface DurableRestoreResult {
  targetPath: string
  schemaVersion: number
  previousDatabasePath: string | null
  manifestVerified: boolean
}

interface DatabaseInspection {
  schemaVersion: number
}

function manifestPathFor(backupPath: string): string {
  return `${backupPath}.manifest.json`
}

function temporaryPath(target: string): string {
  return `${target}.tmp-${process.pid}-${randomUUID()}`
}

function ensureDifferentPaths(first: string, second: string, message: string): void {
  if (resolve(first) === resolve(second)) throw new Error(message)
}

function ensureRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`${label} is not a regular file: ${path}`)
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}

function removeSqliteSidecars(path: string): void {
  unlinkIfExists(`${path}-wal`)
  unlinkIfExists(`${path}-shm`)
}

function inspectDatabase(path: string): DatabaseInspection {
  let database: Database | undefined
  try {
    database = new Database(path, { readonly: true, strict: true })
    const quickCheck = database.query<Record<string, string>, []>('PRAGMA quick_check').get()
    if (quickCheck === null || Object.values(quickCheck)[0] !== 'ok') {
      throw new Error('SQLite quick_check failed')
    }
    const table = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get()
    if (table === null) throw new Error('schema_migrations table is missing')
    const row = database
      .query<{ version: number | null }, []>('SELECT max(version) AS version FROM schema_migrations')
      .get()
    const schemaVersion = row?.version ?? 0
    if (schemaVersion > LATEST_DURABLE_SCHEMA_VERSION) {
      throw new Error(
        `database schema v${schemaVersion} is newer than supported v${LATEST_DURABLE_SCHEMA_VERSION}`,
      )
    }
    return { schemaVersion }
  } finally {
    database?.close()
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseManifest(path: string): DurableBackupManifest {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `cannot parse backup manifest: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    )
  }
  if (typeof value !== 'object' || value === null) throw new Error('backup manifest must be an object')
  const manifest = value as Partial<DurableBackupManifest>
  if (
    manifest.format !== DURABLE_BACKUP_FORMAT ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.sqliteBytes !== 'number' ||
    !Number.isSafeInteger(manifest.sqliteBytes) ||
    manifest.sqliteBytes <= 0 ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    typeof manifest.schemaVersion !== 'number' ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 0
  ) {
    throw new Error('backup manifest has an invalid shape')
  }
  return manifest as DurableBackupManifest
}

async function verifyManifest(
  backupPath: string,
  inspection: DatabaseInspection,
): Promise<boolean> {
  const path = manifestPathFor(backupPath)
  if (!existsSync(path)) return false
  ensureRegularFile(path, 'backup manifest')
  const manifest = parseManifest(path)
  const stats = statSync(backupPath)
  if (manifest.sqliteBytes !== stats.size) throw new Error('backup size does not match its manifest')
  if (manifest.schemaVersion !== inspection.schemaVersion) {
    throw new Error('backup schema version does not match its manifest')
  }
  if (manifest.sha256 !== await sha256File(backupPath)) {
    throw new Error('backup SHA-256 does not match its manifest')
  }
  return true
}

/** Creates a consistent online SQLite snapshot with a hash manifest. */
export async function createDurableBackup(
  sourcePath: string,
  destinationPath: string,
  now = new Date(),
): Promise<DurableBackupResult> {
  if (sourcePath === ':memory:') throw new Error('cannot back up an in-memory database')
  ensureRegularFile(sourcePath, 'source database')
  ensureDifferentPaths(sourcePath, destinationPath, 'backup destination must differ from source database')
  const manifestPath = manifestPathFor(destinationPath)
  if (existsSync(destinationPath)) throw new Error(`backup destination already exists: ${destinationPath}`)
  if (existsSync(manifestPath)) throw new Error(`backup manifest already exists: ${manifestPath}`)

  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
  const snapshotTemp = temporaryPath(destinationPath)
  const manifestTemp = temporaryPath(manifestPath)
  let source: Database | undefined
  let backupPublished = false
  try {
    source = new Database(sourcePath, { readonly: true, strict: true })
    source.run('PRAGMA busy_timeout = 5000')
    source.run('VACUUM INTO ?', [snapshotTemp])
    source.close()
    source = undefined

    chmodSync(snapshotTemp, 0o600)
    const inspection = inspectDatabase(snapshotTemp)
    const manifest: DurableBackupManifest = {
      format: DURABLE_BACKUP_FORMAT,
      createdAt: now.toISOString(),
      sqliteBytes: statSync(snapshotTemp).size,
      sha256: await sha256File(snapshotTemp),
      schemaVersion: inspection.schemaVersion,
    }
    writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(snapshotTemp, destinationPath)
    backupPublished = true
    renameSync(manifestTemp, manifestPath)
    return { backupPath: destinationPath, manifestPath, manifest }
  } catch (error) {
    if (backupPublished) unlinkIfExists(destinationPath)
    throw error
  } finally {
    source?.close()
    unlinkIfExists(snapshotTemp)
    unlinkIfExists(manifestTemp)
  }
}

function recoverySuffix(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Restores offline, migrates forward, and keeps the replaced DB as a recovery copy. */
export async function restoreDurableBackup(
  backupPath: string,
  targetPath: string,
  options: DurableRestoreOptions = {},
): Promise<DurableRestoreResult> {
  ensureRegularFile(backupPath, 'backup database')
  ensureDifferentPaths(backupPath, targetPath, 'restore target must differ from backup database')
  const backupInspection = inspectDatabase(backupPath)
  const manifestVerified = await verifyManifest(backupPath, backupInspection)

  const targetExists = existsSync(targetPath)
  if (targetExists && !options.replace) {
    throw new Error(`restore target already exists: ${targetPath}; rerun with --replace while the service is stopped`)
  }
  if (existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) {
    throw new Error('restore target has SQLite WAL/SHM sidecars; stop the service cleanly before restoring')
  }
  if (targetExists) ensureRegularFile(targetPath, 'restore target')

  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 })
  const targetTemp = temporaryPath(targetPath)
  let previousDatabasePath: string | null = null
  let targetPublished = false
  try {
    copyFileSync(backupPath, targetTemp)
    chmodSync(targetTemp, 0o600)
    const migrated = openDurableDatabase(targetTemp)
    try {
      migrated.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      migrated.close()
    }
    removeSqliteSidecars(targetTemp)
    const restoredInspection = inspectDatabase(targetTemp)
    if (restoredInspection.schemaVersion !== LATEST_DURABLE_SCHEMA_VERSION) {
      throw new Error(
        `restored database stopped at schema v${restoredInspection.schemaVersion}, expected v${LATEST_DURABLE_SCHEMA_VERSION}`,
      )
    }

    if (targetExists) {
      previousDatabasePath = `${targetPath}.pre-restore-${recoverySuffix(options.now ?? new Date())}`
      if (existsSync(previousDatabasePath)) {
        throw new Error(`recovery database already exists: ${previousDatabasePath}`)
      }
      renameSync(targetPath, previousDatabasePath)
    }
    try {
      renameSync(targetTemp, targetPath)
      targetPublished = true
    } catch (error) {
      if (previousDatabasePath !== null && !existsSync(targetPath)) {
        renameSync(previousDatabasePath, targetPath)
        previousDatabasePath = null
      }
      throw error
    }
    return {
      targetPath,
      schemaVersion: restoredInspection.schemaVersion,
      previousDatabasePath,
      manifestVerified,
    }
  } finally {
    if (!targetPublished) unlinkIfExists(targetTemp)
    removeSqliteSidecars(targetTemp)
  }
}
