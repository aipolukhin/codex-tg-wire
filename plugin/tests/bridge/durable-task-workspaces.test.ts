import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type { TextTurnOperation } from '../../src/bridge/contracts.js'
import {
  DurableTaskWorkspaces,
  TaskWorkspaceError,
} from '../../src/bridge/durable-task-workspaces.js'
import { openDurableDatabase } from '../../src/durable/database.js'

const NOW = 1_800_000_000_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function operation(key = 'telegram:primary:1:turn'): TextTurnOperation {
  return {
    operationKey: key,
    inboxUpdateId: 1,
    botId: 'primary',
    updateId: 1,
    chatId: '7001',
    projectId: 'workspace',
    text: 'implement the task',
  }
}

let root: string
let repository: string
let workspacesDirectory: string
let database: Database
let manager: DurableTaskWorkspaces

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-task-workspaces-'))
  repository = join(root, 'repository')
  workspacesDirectory = join(root, 'turn-workspaces')
  execFileSync('git', ['init', '--initial-branch=main', repository])
  git(repository, 'config', 'user.name', 'Codex Test')
  git(repository, 'config', 'user.email', 'codex@example.test')
  writeFileSync(join(repository, 'README.md'), 'initial\n')
  git(repository, 'add', 'README.md')
  git(repository, 'commit', '-m', 'initial')
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  manager = new DurableTaskWorkspaces(database, {
    directory: workspacesDirectory,
    now: () => NOW,
  })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('DurableTaskWorkspaces', () => {
  test('applies a successful task diff to the registered checkout only at completion', async () => {
    const lease = await manager.prepare(operation(), { id: 'workspace', cwd: repository })
    expect(lease.isolated).toBeTrue()
    expect(lease.cwd).not.toBe(repository)
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')

    writeFileSync(join(lease.cwd, 'README.md'), 'completed\n')
    writeFileSync(join(lease.cwd, 'new.txt'), 'new file\n')
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(existsSync(join(repository, 'new.txt'))).toBeFalse()

    expect(await manager.complete(operation().operationKey)).toEqual({
      cancelled: false,
      integrated: true,
      changed: true,
    })
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('completed\n')
    expect(readFileSync(join(repository, 'new.txt'), 'utf8')).toBe('new file\n')
    expect(git(repository, 'status', '--porcelain')).toContain('README.md')
    expect(existsSync(lease.writableRoot)).toBeFalse()
    expect(manager.hasIntegratedChanges(operation().operationKey)).toBeTrue()
  })

  test('records an answer-only capsule as no repository mutation', async () => {
    const op = operation()
    await manager.prepare(op, { id: 'workspace', cwd: repository })
    expect(await manager.complete(op.operationKey)).toEqual({
      cancelled: false,
      integrated: true,
      changed: false,
    })
    expect(manager.hasIntegratedChanges(op.operationKey)).toBeFalse()
  })

  test('supports a configured workspace spool inside an ignored-style project state directory', async () => {
    const nestedDirectory = join(repository, 'state', 'task-workspaces')
    const nested = new DurableTaskWorkspaces(database, {
      directory: nestedDirectory,
      now: () => NOW,
    })
    const op = operation('telegram:primary:2:turn')
    const lease = await nested.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'nested spool result\n')

    await nested.complete(op.operationKey)
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('nested spool result\n')
    expect(existsSync(lease.writableRoot)).toBeFalse()
  })

  test('confirmed cancellation discards task changes and leaves the registered checkout byte-identical', async () => {
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'unfinished\n')
    writeFileSync(join(lease.cwd, 'partial.txt'), 'partial\n')

    expect(manager.requestCancellation(op.operationKey)).toBe('requested')
    await manager.abort(op.operationKey, 'INTERRUPTED')

    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(existsSync(join(repository, 'partial.txt'))).toBeFalse()
    expect(git(repository, 'status', '--porcelain')).toBe('')
    expect(existsSync(lease.writableRoot)).toBeFalse()
    expect(manager.cancellationOutcome(op.operationKey)).toBe('discarded')
  })

  test('cancellation wins a race with a successful backend result before integration', async () => {
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'finished but cancelled\n')
    expect(manager.requestCancellation(op.operationKey)).toBe('requested')

    expect(await manager.complete(op.operationKey)).toEqual({
      cancelled: true,
      integrated: false,
      changed: false,
    })
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(git(repository, 'status', '--porcelain')).toBe('')
  })

  test('isolates and never rewrites changes that existed before the turn', async () => {
    writeFileSync(join(repository, 'README.md'), 'owner draft\n')
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })

    expect(lease).toMatchObject({ isolated: true, mode: 'ISOLATED' })
    expect(readFileSync(join(lease.cwd, 'README.md'), 'utf8')).toBe('owner draft\n')
    writeFileSync(join(lease.cwd, 'README.md'), 'unfinished task edit\n')
    writeFileSync(join(lease.cwd, 'task-only.txt'), 'discard me\n')
    expect(manager.requestCancellation(op.operationKey)).toBe('requested')
    await manager.abort(op.operationKey, 'INTERRUPTED')
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('owner draft\n')
    expect(existsSync(join(repository, 'task-only.txt'))).toBeFalse()
    expect(manager.cancellationOutcome(op.operationKey)).toBe('discarded')
  })

  test('applies only the task delta on top of a dirty registered checkout', async () => {
    writeFileSync(join(repository, 'README.md'), 'owner draft\n')
    writeFileSync(join(repository, 'owner-untracked.txt'), 'owner file\n')
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })

    expect(readFileSync(join(lease.cwd, 'README.md'), 'utf8')).toBe('owner draft\n')
    expect(readFileSync(join(lease.cwd, 'owner-untracked.txt'), 'utf8')).toBe('owner file\n')
    writeFileSync(join(lease.cwd, 'README.md'), 'task result based on owner draft\n')
    writeFileSync(join(lease.cwd, 'task-only.txt'), 'task file\n')
    await manager.complete(op.operationKey)

    expect(readFileSync(join(repository, 'README.md'), 'utf8'))
      .toBe('task result based on owner draft\n')
    expect(readFileSync(join(repository, 'owner-untracked.txt'), 'utf8')).toBe('owner file\n')
    expect(readFileSync(join(repository, 'task-only.txt'), 'utf8')).toBe('task file\n')
  })

  test('continues durable cleanup after a bridge restart', async () => {
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'unfinished\n')
    manager.requestCancellation(op.operationKey)

    const restarted = new DurableTaskWorkspaces(database, {
      directory: workspacesDirectory,
      now: () => NOW + 1,
    })
    expect(await restarted.recoverStartup()).toBe(1)
    expect(existsSync(lease.writableRoot)).toBeFalse()
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(restarted.cancellationOutcome(op.operationKey)).toBe('discarded')
  })

  test('creates a fresh capsule when a failed attempt is auto-resumed', async () => {
    const op = operation()
    const first = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(first.cwd, 'README.md'), 'failed attempt\n')
    await manager.abort(op.operationKey, 'FAILED')

    const resumed = await manager.prepare(op, { id: 'workspace', cwd: repository })
    expect(resumed.isolated).toBeTrue()
    expect(readFileSync(join(resumed.cwd, 'README.md'), 'utf8')).toBe('initial\n')
    writeFileSync(join(resumed.cwd, 'README.md'), 'resumed success\n')
    await manager.complete(op.operationKey)

    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('resumed success\n')
  })

  test('removes a failed pre-dispatch capsule so the same operation can retry', async () => {
    const op = operation()
    const token = createHash('sha256').update(op.operationKey).digest('hex').slice(0, 20)
    const blockedPath = join(workspacesDirectory, token)
    mkdirSync(blockedPath, { recursive: true })
    writeFileSync(join(blockedPath, 'collision'), 'force worktree add failure\n')

    await expect(manager.prepare(op, { id: 'workspace', cwd: repository }))
      .rejects.toBeInstanceOf(TaskWorkspaceError)
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM turn_task_workspaces',
    ).get()?.count).toBe(0)

    const retried = await manager.prepare(op, { id: 'workspace', cwd: repository })
    expect(retried.isolated).toBeTrue()
  })

  test('finishes an integration that applied its patch immediately before a restart', async () => {
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'survived integration crash\n')
    git(lease.cwd, 'add', '--all')
    const row = database.query<{
      base_head: string
      patch_path: string
    }, [string]>(
      'SELECT base_head, patch_path FROM turn_task_workspaces WHERE operation_key = ?',
    ).get(op.operationKey)!
    const patch = execFileSync(
      'git',
      ['diff', '--cached', '--binary', '--full-index', row.base_head],
      { cwd: lease.cwd, encoding: 'utf8' },
    )
    writeFileSync(row.patch_path, patch)
    git(repository, 'apply', '--binary', row.patch_path)
    database.run(
      "UPDATE turn_task_workspaces SET phase = 'INTEGRATING' WHERE operation_key = ?",
      [op.operationKey],
    )

    const restarted = new DurableTaskWorkspaces(database, {
      directory: workspacesDirectory,
      now: () => NOW + 1,
    })
    expect(await restarted.complete(op.operationKey)).toEqual({
      cancelled: false,
      integrated: true,
      changed: true,
    })
    expect(readFileSync(join(repository, 'README.md'), 'utf8'))
      .toBe('survived integration crash\n')
    expect(existsSync(lease.writableRoot)).toBeFalse()
  })

  test('refuses integration when the registered checkout changed concurrently', async () => {
    const op = operation()
    const lease = await manager.prepare(op, { id: 'workspace', cwd: repository })
    writeFileSync(join(lease.cwd, 'README.md'), 'task change\n')
    writeFileSync(join(repository, 'outside.txt'), 'owner change\n')

    await expect(manager.complete(op.operationKey)).rejects.toBeInstanceOf(TaskWorkspaceError)
    expect(readFileSync(join(repository, 'README.md'), 'utf8')).toBe('initial\n')
    expect(readFileSync(join(repository, 'outside.txt'), 'utf8')).toBe('owner change\n')
    expect(existsSync(lease.writableRoot)).toBeTrue()
  })
})
