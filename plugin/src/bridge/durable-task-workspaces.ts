import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { Database } from 'bun:sqlite'

import type { TextTurnOperation } from './contracts.js'
import type { ProjectDefinition } from './durable-session-coordinator.js'
import { sanitizedGitEnvironment } from './git-workspace-control.js'

const GIT_TIMEOUT_MS = 120_000
const GIT_OUTPUT_LIMIT = 8 * 1_024 * 1_024

type WorkspaceMode = 'ISOLATED' | 'PLAIN'
type WorkspacePhase =
  | 'PREPARING'
  | 'ACTIVE'
  | 'INTEGRATING'
  | 'INTEGRATED'
  | 'DISCARDING'
  | 'DISCARDED'
  | 'BYPASSED'
  | 'BLOCKED'

interface TaskWorkspaceRow {
  operation_key: string
  project_id: string
  mode: WorkspaceMode
  phase: WorkspacePhase
  canonical_root: string
  canonical_cwd: string
  worktree_path: string | null
  base_head: string | null
  patch_path: string | null
  baseline_tree: string | null
  changed: number | null
  cancel_requested: number
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
}

export interface TaskWorkspaceLease {
  cwd: string
  writableRoot: string
  isolated: boolean
  mode: WorkspaceMode
}

export interface TaskWorkspaceCompletion {
  cancelled: boolean
  integrated: boolean
  changed: boolean
}

export type TaskWorkspaceCancellationResult = 'requested' | 'too_late' | 'not_found'
export type TaskWorkspaceCancellationOutcome =
  | 'discarded'
  | 'unisolated_changes_preserved'
  | 'not_requested'
  | 'pending'

export interface TaskWorkspaceController {
  prepare(operation: TextTurnOperation, project: ProjectDefinition): Promise<TaskWorkspaceLease>
  complete(operationKey: string): Promise<TaskWorkspaceCompletion>
  abort(operationKey: string, state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN'): Promise<void>
  requestCancellation(operationKey: string): TaskWorkspaceCancellationResult
  isCancellationRequested(operationKey: string): boolean
  cancellationOutcome(operationKey: string): TaskWorkspaceCancellationOutcome
  hasIntegratedChanges(operationKey: string): boolean | null
  recoverStartup(): Promise<number>
}

export interface TaskWorkspaceCommandRunner {
  run(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string>
}

export class ProcessTaskWorkspaceCommandRunner implements TaskWorkspaceCommandRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = sanitizedGitEnvironment()) {}

  run(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
        {
          cwd,
          env: { ...this.env, ...env },
          encoding: 'utf8',
          maxBuffer: GIT_OUTPUT_LIMIT,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error !== null) {
            reject(new TaskWorkspaceError('git workspace operation failed'))
            return
          }
          resolvePromise(stdout)
        },
      )
    })
  }
}

export class TaskWorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskWorkspaceError'
  }
}

function safeError(error: unknown): string {
  return error instanceof Error && error.name.trim().length > 0 ? error.name : 'UnknownError'
}

function taskToken(operationKey: string): string {
  return createHash('sha256').update(operationKey).digest('hex').slice(0, 20)
}

function inside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`)
}

/**
 * Owns an ephemeral Git worktree for one durable Telegram turn. Successful
 * changes are applied to the registered worktree only after the backend turn
 * completes. Cancelled/failed turns discard the capsule without touching the
 * registered worktree.
 */
export class DurableTaskWorkspaces implements TaskWorkspaceController {
  private readonly directory: string
  private readonly runner: TaskWorkspaceCommandRunner
  private readonly now: () => number

  constructor(
    private readonly database: Database,
    options: {
      directory: string
      runner?: TaskWorkspaceCommandRunner
      now?: () => number
    },
  ) {
    if (!isAbsolute(options.directory)) {
      throw new TypeError('task workspace directory must be absolute')
    }
    this.directory = resolve(options.directory)
    this.runner = options.runner ?? new ProcessTaskWorkspaceCommandRunner()
    this.now = options.now ?? Date.now
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  async prepare(
    operation: TextTurnOperation,
    project: ProjectDefinition,
  ): Promise<TaskWorkspaceLease> {
    const existing = this.get(operation.operationKey)
    if (existing !== null) {
      if (existing.phase !== 'DISCARDED' || existing.cancel_requested === 1) {
        return this.lease(existing)
      }
      this.database.run(
        'DELETE FROM turn_task_workspaces WHERE operation_key = ? AND phase = \'DISCARDED\'',
        [operation.operationKey],
      )
    }

    const canonicalCwd = realpathSync(project.cwd)
    let canonicalRoot: string
    try {
      canonicalRoot = realpathSync((await this.runner.run(
        canonicalCwd,
        ['rev-parse', '--show-toplevel'],
      )).trim())
    } catch {
      this.insertBypass(operation, canonicalCwd, canonicalCwd, 'PLAIN')
      return { cwd: canonicalCwd, writableRoot: canonicalCwd, isolated: false, mode: 'PLAIN' }
    }
    if (!inside(canonicalRoot, canonicalCwd)) {
      throw new TaskWorkspaceError('project cwd is outside its Git worktree')
    }
    let baseHead: string
    try {
      baseHead = (await this.runner.run(canonicalRoot, ['rev-parse', '--verify', 'HEAD'])).trim()
    } catch {
      this.insertBypass(operation, canonicalRoot, canonicalCwd, 'PLAIN')
      return { cwd: canonicalCwd, writableRoot: canonicalRoot, isolated: false, mode: 'PLAIN' }
    }

    const value = taskToken(operation.operationKey)
    const worktreePath = join(this.directory, value)
    const patchPath = join(this.directory, `${value}.patch`)
    if (!inside(this.directory, worktreePath) || !inside(this.directory, patchPath)) {
      throw new TaskWorkspaceError('generated task workspace path escaped its owner directory')
    }
    const baselineTree = await this.captureCanonicalTree(
      canonicalRoot,
      `${value}.baseline`,
    )
    const nowMs = this.now()
    this.database.run(
      `INSERT INTO turn_task_workspaces
        (operation_key, project_id, mode, phase, canonical_root, canonical_cwd,
         worktree_path, base_head, patch_path, baseline_tree, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'ISOLATED', 'PREPARING', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.operationKey,
        operation.projectId,
        canonicalRoot,
        canonicalCwd,
        worktreePath,
        baseHead,
        patchPath,
        baselineTree,
        nowMs,
        nowMs,
      ],
    )
    try {
      await this.runner.run(canonicalRoot, ['worktree', 'add', '--detach', worktreePath, baseHead])
      await this.runner.run(worktreePath, ['read-tree', '--reset', '-u', baselineTree])
      this.database.run(
        `UPDATE turn_task_workspaces SET phase = 'ACTIVE', updated_at_ms = ?
         WHERE operation_key = ? AND phase = 'PREPARING'`,
        [this.now(), operation.operationKey],
      )
    } catch (error) {
      try {
        await this.cleanupFiles(this.require(operation.operationKey))
        this.database.run(
          "DELETE FROM turn_task_workspaces WHERE operation_key = ? AND phase = 'PREPARING'",
          [operation.operationKey],
        )
      } catch (cleanupError) {
        this.database.run(
          `UPDATE turn_task_workspaces
           SET phase = 'BLOCKED', last_error = ?, updated_at_ms = ? WHERE operation_key = ?`,
          [safeError(cleanupError), this.now(), operation.operationKey],
        )
      }
      throw error
    }
    return this.lease(this.require(operation.operationKey))
  }

  async complete(operationKey: string): Promise<TaskWorkspaceCompletion> {
    let row = this.require(operationKey)
    if (row.mode !== 'ISOLATED') {
      return { cancelled: row.cancel_requested === 1, integrated: false, changed: false }
    }
    if (row.cancel_requested === 1) {
      await this.discard(row)
      return { cancelled: true, integrated: false, changed: false }
    }
    if (row.phase === 'INTEGRATED') {
      return { cancelled: false, integrated: true, changed: row.changed === 1 }
    }
    if (row.phase !== 'ACTIVE' && row.phase !== 'INTEGRATING') {
      throw new TaskWorkspaceError(`task workspace is ${row.phase}, expected ACTIVE`)
    }
    if (row.phase === 'ACTIVE') {
      this.database.run(
        `UPDATE turn_task_workspaces SET phase = 'INTEGRATING', updated_at_ms = ?
         WHERE operation_key = ? AND phase = 'ACTIVE' AND cancel_requested = 0`,
        [this.now(), operationKey],
      )
      row = this.require(operationKey)
      if (row.phase !== 'INTEGRATING') {
        if (row.cancel_requested === 1) {
          await this.discard(row)
          return { cancelled: true, integrated: false, changed: false }
        }
        throw new TaskWorkspaceError('task workspace could not enter integration')
      }
    }
    if (
      row.worktree_path === null ||
      row.base_head === null ||
      row.patch_path === null ||
      row.baseline_tree === null
    ) {
      throw new TaskWorkspaceError('isolated task workspace metadata is incomplete')
    }
    try {
      await this.runner.run(row.worktree_path, ['add', '--all', '--', '.'])
      const patch = await this.runner.run(
        row.worktree_path,
        ['diff', '--cached', '--binary', '--full-index', row.baseline_tree],
      )
      const finalTree = (await this.runner.run(row.worktree_path, ['write-tree'])).trim()
      writeFileSync(row.patch_path, patch, { encoding: 'utf8', mode: 0o600 })
      const canonicalHead = (await this.runner.run(
        row.canonical_root,
        ['rev-parse', '--verify', 'HEAD'],
      )).trim()
      if (canonicalHead !== row.base_head) {
        throw new TaskWorkspaceError('registered worktree changed while the task was running')
      }
      const canonicalTree = await this.captureCanonicalTree(
        row.canonical_root,
        `${taskToken(operationKey)}.integrating`,
      )
      if (canonicalTree === finalTree) {
        this.markIntegrated(operationKey, patch.length > 0)
        await this.cleanupFiles(this.require(operationKey))
        return { cancelled: false, integrated: true, changed: patch.length > 0 }
      }
      if (canonicalTree !== row.baseline_tree) {
        throw new TaskWorkspaceError('registered worktree changed while the task was running')
      }
      if (patch.length === 0) {
        this.markIntegrated(operationKey, false)
        await this.cleanupFiles(this.require(operationKey))
        return { cancelled: false, integrated: true, changed: false }
      }
      await this.runner.run(row.canonical_root, ['apply', '--check', '--binary', row.patch_path])
      await this.runner.run(row.canonical_root, ['apply', '--binary', row.patch_path])
      this.markIntegrated(operationKey, true)
      await this.cleanupFiles(this.require(operationKey))
      return { cancelled: false, integrated: true, changed: true }
    } catch (error) {
      this.database.run(
        `UPDATE turn_task_workspaces SET phase = 'BLOCKED', last_error = ?, updated_at_ms = ?
         WHERE operation_key = ?`,
        [safeError(error), this.now(), operationKey],
      )
      throw error
    }
  }

  async abort(
    operationKey: string,
    state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
  ): Promise<void> {
    const row = this.get(operationKey)
    if (row === null || row.mode !== 'ISOLATED' || state === 'UNKNOWN') return
    if (row.phase === 'INTEGRATED' || row.phase === 'DISCARDED') return
    await this.discard(row)
  }

  requestCancellation(operationKey: string): TaskWorkspaceCancellationResult {
    const row = this.get(operationKey)
    if (row === null) return 'not_found'
    if (row.phase === 'INTEGRATING' || row.phase === 'INTEGRATED') return 'too_late'
    this.database.run(
      `UPDATE turn_task_workspaces SET cancel_requested = 1, updated_at_ms = ?
       WHERE operation_key = ?`,
      [this.now(), operationKey],
    )
    return 'requested'
  }

  isCancellationRequested(operationKey: string): boolean {
    return this.get(operationKey)?.cancel_requested === 1
  }

  cancellationOutcome(operationKey: string): TaskWorkspaceCancellationOutcome {
    const row = this.get(operationKey)
    if (row === null) return 'not_requested'
    if (row.mode === 'ISOLATED' && row.phase === 'DISCARDED') return 'discarded'
    if (row.cancel_requested !== 1) return 'not_requested'
    if (row.mode !== 'ISOLATED') return 'unisolated_changes_preserved'
    return 'pending'
  }

  hasIntegratedChanges(operationKey: string): boolean | null {
    const row = this.get(operationKey)
    if (row === null || row.mode !== 'ISOLATED' || row.phase !== 'INTEGRATED') return null
    return row.changed === 1
  }

  async recoverStartup(): Promise<number> {
    const rows = this.database.query<TaskWorkspaceRow, []>(
      `SELECT * FROM turn_task_workspaces
       WHERE phase IN ('PREPARING', 'ACTIVE', 'INTEGRATING', 'DISCARDING')
       ORDER BY created_at_ms, operation_key`,
    ).all()
    let recovered = 0
    for (const row of rows) {
      if (row.cancel_requested === 1 || row.phase === 'PREPARING' || row.phase === 'DISCARDING') {
        await this.discard(row)
        recovered += 1
        continue
      }
      // ACTIVE and INTEGRATING capsules are intentionally kept. Startup turn
      // reconciliation either resumes the backend or finishes integration
      // from the durable patch/worktree state.
    }
    return recovered
  }

  private lease(row: TaskWorkspaceRow): TaskWorkspaceLease {
    if (row.mode !== 'ISOLATED') {
      return {
        cwd: row.canonical_cwd,
        writableRoot: row.canonical_root,
        isolated: false,
        mode: row.mode,
      }
    }
    if (row.phase !== 'ACTIVE' || row.worktree_path === null) {
      throw new TaskWorkspaceError(`task workspace is not resumable (${row.phase})`)
    }
    const relativeCwd = relative(row.canonical_root, row.canonical_cwd)
    const cwd = resolve(row.worktree_path, relativeCwd)
    if (!inside(row.worktree_path, cwd) || !existsSync(cwd)) {
      throw new TaskWorkspaceError('task workspace cwd is unavailable')
    }
    return { cwd, writableRoot: row.worktree_path, isolated: true, mode: 'ISOLATED' }
  }

  private insertBypass(
    operation: TextTurnOperation,
    canonicalRoot: string,
    canonicalCwd: string,
    mode: 'PLAIN',
  ): void {
    const nowMs = this.now()
    this.database.run(
      `INSERT INTO turn_task_workspaces
        (operation_key, project_id, mode, phase, canonical_root, canonical_cwd,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'BYPASSED', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [operation.operationKey, operation.projectId, mode, canonicalRoot, canonicalCwd, nowMs, nowMs],
    )
  }

  private async discard(row: TaskWorkspaceRow): Promise<void> {
    if (row.mode !== 'ISOLATED') return
    if (row.phase === 'INTEGRATED' || row.phase === 'DISCARDED') return
    this.database.run(
      `UPDATE turn_task_workspaces SET phase = 'DISCARDING', updated_at_ms = ?
       WHERE operation_key = ?`,
      [this.now(), row.operation_key],
    )
    await this.cleanupFiles(this.require(row.operation_key))
    this.database.run(
      `UPDATE turn_task_workspaces
       SET phase = 'DISCARDED', last_error = NULL, updated_at_ms = ? WHERE operation_key = ?`,
      [this.now(), row.operation_key],
    )
  }

  private markIntegrated(operationKey: string, changed: boolean): void {
    this.database.run(
      `UPDATE turn_task_workspaces
       SET phase = 'INTEGRATED', changed = ?, last_error = NULL, updated_at_ms = ?
       WHERE operation_key = ?`,
      [changed ? 1 : 0, this.now(), operationKey],
    )
  }

  private async cleanupFiles(row: TaskWorkspaceRow): Promise<void> {
    if (row.worktree_path !== null) {
      if (!inside(this.directory, row.worktree_path)) {
        throw new TaskWorkspaceError('refusing to clean a task workspace outside its owner directory')
      }
      try {
        await this.runner.run(row.canonical_root, [
          'worktree', 'remove', '--force', row.worktree_path,
        ])
      } catch {
        rmSync(row.worktree_path, { recursive: true, force: true })
        await this.runner.run(row.canonical_root, ['worktree', 'prune']).catch(() => undefined)
      }
    }
    if (row.patch_path !== null) {
      if (!inside(this.directory, row.patch_path)) {
        throw new TaskWorkspaceError('refusing to clean a task patch outside its owner directory')
      }
      rmSync(row.patch_path, { force: true })
    }
  }

  private async captureCanonicalTree(canonicalRoot: string, name: string): Promise<string> {
    const indexPath = join(this.directory, `${name}.index`)
    if (!inside(this.directory, indexPath)) {
      throw new TaskWorkspaceError('generated task index escaped its owner directory')
    }
    rmSync(indexPath, { force: true })
    const env = { GIT_INDEX_FILE: indexPath }
    try {
      await this.runner.run(canonicalRoot, ['read-tree', 'HEAD'], env)
      const addArgs = ['add', '--all', '--', '.']
      if (inside(canonicalRoot, this.directory)) {
        const excluded = relative(canonicalRoot, this.directory)
        if (excluded.length === 0) {
          throw new TaskWorkspaceError('task workspace directory cannot be the Git worktree root')
        }
        addArgs.push(`:(exclude)${excluded}`, `:(exclude)${excluded}/**`)
      }
      await this.runner.run(canonicalRoot, addArgs, env)
      return (await this.runner.run(canonicalRoot, ['write-tree'], env)).trim()
    } finally {
      rmSync(indexPath, { force: true })
    }
  }

  private get(operationKey: string): TaskWorkspaceRow | null {
    return this.database.query<TaskWorkspaceRow, [string]>(
      'SELECT * FROM turn_task_workspaces WHERE operation_key = ?',
    ).get(operationKey)
  }

  private require(operationKey: string): TaskWorkspaceRow {
    const row = this.get(operationKey)
    if (row === null) throw new TaskWorkspaceError(`task workspace ${operationKey} not found`)
    return row
  }
}
