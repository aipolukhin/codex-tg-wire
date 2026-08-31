import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type { DeliveryJobInput } from '../durable/contracts.js'
import type {
  CommandButton,
  FinalArtifactDelivery,
  TurnCompletionReporter,
} from './contracts.js'
import type { ProjectDefinition } from './durable-session-coordinator.js'
import { StaticProjectCatalog, type ProjectCatalog } from './durable-project-catalog.js'

const GIT_TIMEOUT_MS = 120_000
const GIT_OUTPUT_LIMIT = 4 * 1_024 * 1_024
const SNAPSHOT_TOKEN = /^[a-f0-9]{12}$/
const PROJECT_INDEX = /^(0|[1-9]\d?)$/

export type GitWorkspaceAction = 'commit' | 'push' | 'commit-push'

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string>
}

export interface GitWorkspaceStatus {
  projectId: string
  projectIndex: number
  root: string
  branch: string
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  snapshotToken: string
}

export interface GitWorkspaceActionResult {
  text: string
  buttons: readonly (readonly CommandButton[])[]
}

export interface GitWorkspaceController extends TurnCompletionReporter {
  handleAction(snapshot: string, actionSpec: string): Promise<GitWorkspaceActionResult>
}

export interface GitTurnDiffProvider {
  getLatestDiff(threadId: string): { turnId: string; diff: string } | null
}

export interface GitWorkspaceControlOptions {
  runner?: GitCommandRunner
  turnDiffProvider?: GitTurnDiffProvider
}

export function sanitizedGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  }
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ] as const) {
    const value = source[key]
    if (value !== undefined) safe[key] = value
  }
  return safe
}

export class ProcessGitCommandRunner implements GitCommandRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = sanitizedGitEnvironment()) {}

  run(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'commit.gpgSign=false',
          ...args,
        ],
        {
          cwd,
          env: this.env,
          encoding: 'utf8',
          maxBuffer: GIT_OUTPUT_LIMIT,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error !== null) {
            reject(new GitWorkspaceOperationError('git command failed'))
            return
          }
          resolve(stdout)
        },
      )
    })
  }
}

export class GitWorkspaceOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitWorkspaceOperationError'
  }
}

interface StatusCounts {
  changedFiles: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
}

function statusCounts(porcelain: string): StatusCounts {
  const rows = porcelain.split('\n').filter((row) => row.length >= 2)
  let stagedFiles = 0
  let unstagedFiles = 0
  let untrackedFiles = 0
  for (const row of rows) {
    if (row.startsWith('??')) {
      untrackedFiles += 1
      continue
    }
    if (row[0] !== ' ') stagedFiles += 1
    if (row[1] !== ' ') unstagedFiles += 1
  }
  return {
    changedFiles: rows.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
  }
}

function snapshotToken(input: {
  projectId: string
  root: string
  branch: string
  head: string | null
  upstream: string | null
  porcelain: string
}): string {
  return createHash('sha256')
    .update([
      input.projectId,
      input.root,
      input.branch,
      input.head ?? '',
      input.upstream ?? '',
      input.porcelain,
    ].join('\0'))
    .digest('hex')
    .slice(0, 12)
}

function parseDivergence(value: string): { ahead: number; behind: number } {
  const match = value.trim().match(/^(\d+)\s+(\d+)$/)
  if (match?.[1] === undefined || match[2] === undefined) return { ahead: 0, behind: 0 }
  return {
    ahead: Number.parseInt(match[1], 10),
    behind: Number.parseInt(match[2], 10),
  }
}

function shortHead(head: string | null): string {
  return head === null ? 'нет коммитов' : head.slice(0, 8)
}

function renderStatus(status: GitWorkspaceStatus, notice?: string): string {
  const upstream = status.upstream === null
    ? 'не настроен'
    : `${status.upstream} · впереди ${status.ahead} · позади ${status.behind}`
  return [
    ...(notice === undefined ? [] : [notice, '']),
    `📦 Git · ${status.projectId}`,
    `От HEAD: ${status.changedFiles} незакоммиченных файлов`,
    `Staged: ${status.stagedFiles} · unstaged: ${status.unstagedFiles} · new: ${status.untrackedFiles}`,
    `HEAD: ${shortHead(status.head)} · ветка ${status.branch}`,
    `Upstream: ${upstream}`,
  ].join('\n')
}

function actionButtons(status: GitWorkspaceStatus): readonly (readonly CommandButton[])[] {
  const prefix = `dx:g:${status.snapshotToken}:${status.projectIndex}`
  return [[
    { text: 'Commit', callbackData: `${prefix}:commit` },
    { text: 'Commit & push', callbackData: `${prefix}:commit-push` },
  ]]
}

function keyboard(buttons: readonly (readonly CommandButton[])[]): unknown {
  return {
    reply_markup: {
      inline_keyboard: buttons.map((row) => row.map((button) => (
        'callbackData' in button
          ? { text: button.text, callback_data: button.callbackData }
          : { text: button.text, url: button.url }
      ))),
    },
  }
}

export class GitWorkspaceControl implements GitWorkspaceController {
  private readonly projects: ProjectCatalog
  private readonly runner: GitCommandRunner
  private readonly turnDiffProvider: GitTurnDiffProvider | undefined

  constructor(
    projects: readonly ProjectDefinition[] | ProjectCatalog,
    options: GitWorkspaceControlOptions = {},
  ) {
    this.projects = 'list' in projects ? projects : new StaticProjectCatalog(projects)
    this.runner = options.runner ?? new ProcessGitCommandRunner()
    this.turnDiffProvider = options.turnDiffProvider
    const initial = this.projects.list()
    if (initial.length === 0 || initial.length > 100) {
      throw new TypeError('git workspace control requires 1 to 100 projects')
    }
    for (const project of initial) {
      if (project.id.trim().length === 0 || !isAbsolute(project.cwd)) {
        throw new TypeError('git workspace projects require an id and absolute cwd')
      }
    }
    if (new Set(initial.map((project) => project.id)).size !== initial.length) {
      throw new TypeError('git workspace project ids must be unique')
    }
  }

  async buildTurnCompletionDeliveries(
    input: FinalArtifactDelivery,
  ): Promise<readonly DeliveryJobInput[]> {
    if ((input.result.presentation ?? 'answer') !== 'answer') return []
    const turnDiff = this.turnDiffProvider?.getLatestDiff(input.result.threadId)
    if (
      turnDiff === undefined ||
      turnDiff === null ||
      turnDiff.turnId !== input.result.turnId ||
      turnDiff.diff.trim().length === 0
    ) return []
    let status: GitWorkspaceStatus | null
    try {
      status = await this.inspectProject(input.message.projectId)
    } catch {
      return [{
        sourceKey: input.sourceKey,
        ...(input.dependsOnSourceKey === undefined
          ? {}
          : { dependsOnSourceKey: input.dependsOnSourceKey }),
        kind: 'send_text',
        payload: {
          chatId: input.message.chatId,
          text: '⚠️ Git-статус проекта временно недоступен.',
        },
        createdAtMs: input.nowMs,
      }]
    }
    if (status === null || status.changedFiles === 0) return []
    const buttons = actionButtons(status)
    return [{
      sourceKey: input.sourceKey,
      ...(input.dependsOnSourceKey === undefined
        ? {}
        : { dependsOnSourceKey: input.dependsOnSourceKey }),
      kind: 'send_text',
      payload: {
        chatId: input.message.chatId,
        text: renderStatus(status),
        options: keyboard(buttons),
      },
      createdAtMs: input.nowMs,
    }]
  }

  async handleAction(
    snapshot: string,
    actionSpec: string,
  ): Promise<GitWorkspaceActionResult> {
    const parsed = actionSpec.match(/^(0|[1-9]\d?):(commit|push|commit-push)$/)
    if (!SNAPSHOT_TOKEN.test(snapshot) || parsed?.[1] === undefined || parsed[2] === undefined) {
      return { text: '⚠️ Некорректное Git-действие.', buttons: [] }
    }
    const projectIndex = Number.parseInt(parsed[1], 10)
    const action = parsed[2] as GitWorkspaceAction
    const project = this.projects.list()[projectIndex]
    if (project === undefined || !PROJECT_INDEX.test(parsed[1])) {
      return { text: '⚠️ Проект для Git-действия не найден.', buttons: [] }
    }
    try {
      return await this.handleValidatedAction(project, projectIndex, snapshot, action)
    } catch {
      return {
        text: '⚠️ Git-действие не выполнено. Статус проекта временно недоступен.',
        buttons: [],
      }
    }
  }

  private async handleValidatedAction(
    project: ProjectDefinition,
    projectIndex: number,
    snapshot: string,
    action: GitWorkspaceAction,
  ): Promise<GitWorkspaceActionResult> {
    const before = await this.inspect(project, projectIndex)
    if (before === null) return { text: '⚠️ Проект больше не является Git-репозиторием.', buttons: [] }
    if (before.snapshotToken !== snapshot) {
      const buttons = actionButtons(before)
      return {
        text: renderStatus(before, '⚠️ Карточка устарела — статус обновлён, действие не выполнялось.'),
        buttons,
      }
    }

    let notice: string
    try {
      notice = await this.execute(before, action)
    } catch {
      notice = '⚠️ Git-действие не выполнено. Проверь авторизацию и настройки репозитория.'
    }
    const after = await this.inspect(project, projectIndex)
    if (after === null) return { text: notice, buttons: [] }
    const buttons = actionButtons(after)
    return { text: renderStatus(after, notice), buttons }
  }

  private async execute(status: GitWorkspaceStatus, action: GitWorkspaceAction): Promise<string> {
    let committed = false
    let pushed = false
    if (action !== 'push' && status.changedFiles > 0) {
      await this.runner.run(status.root, ['add', '--all', '--', '.'])
      await this.runner.run(status.root, [
        'commit', '--no-verify', '-m', 'chore(codex): save agent changes',
      ])
      committed = true
    }
    if (action !== 'commit') {
      const current = await this.inspectProject(status.projectId)
      if (current !== null && current.ahead > 0) {
        await this.push(current)
        pushed = true
      }
    }
    if (committed && pushed) return '✅ Изменения закоммичены и запушены.'
    if (committed) return '✅ Изменения закоммичены.'
    if (pushed) return '✅ Коммиты запушены.'
    return action === 'commit'
      ? 'ℹ️ Нет незакоммиченных изменений.'
      : 'ℹ️ Нет коммитов для push.'
  }

  private async push(status: GitWorkspaceStatus): Promise<void> {
    if (status.upstream !== null) {
      await this.runner.run(status.root, ['push'])
      return
    }
    if (status.branch === 'detached') throw new GitWorkspaceOperationError('detached HEAD')
    const remotes = (await this.runner.run(status.root, ['remote']))
      .split('\n')
      .map((value) => value.trim())
    if (!remotes.includes('origin')) throw new GitWorkspaceOperationError('origin is missing')
    await this.runner.run(status.root, ['push', '--set-upstream', 'origin', 'HEAD'])
  }

  private async inspectProject(projectId: string): Promise<GitWorkspaceStatus | null> {
    const project = this.projects.resolve(projectId)
    if (project === null) return null
    const projectIndex = this.projects.list().findIndex((candidate) => candidate.id === project.id)
    if (projectIndex < 0 || projectIndex > 99) return null
    return this.inspect(project, projectIndex)
  }

  private async inspect(
    project: ProjectDefinition,
    projectIndex: number,
  ): Promise<GitWorkspaceStatus | null> {
    const root = await this.optional(project.cwd, ['rev-parse', '--show-toplevel'])
    if (root === null || !isAbsolute(root.trim())) return null
    const repositoryRoot = root.trim()
    const porcelain = await this.runner.run(repositoryRoot, [
      'status', '--porcelain=v1', '--untracked-files=all',
    ])
    const branchValue = await this.optional(repositoryRoot, [
      'symbolic-ref', '--quiet', '--short', 'HEAD',
    ])
    const branch = branchValue?.trim() || 'detached'
    const headValue = await this.optional(repositoryRoot, ['rev-parse', '--verify', 'HEAD'])
    const head = headValue?.trim() || null
    const upstreamValue = await this.optional(repositoryRoot, [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
    ])
    const upstream = upstreamValue?.trim() || null
    const divergence = head === null || upstream === null
      ? { ahead: 0, behind: 0 }
      : parseDivergence(await this.runner.run(repositoryRoot, [
          'rev-list', '--left-right', '--count', `HEAD...${upstream}`,
        ]))
    return {
      projectId: project.id,
      projectIndex,
      root: repositoryRoot,
      branch,
      head,
      upstream,
      ...divergence,
      ...statusCounts(porcelain),
      snapshotToken: snapshotToken({
        projectId: project.id,
        root: repositoryRoot,
        branch,
        head,
        upstream,
        porcelain,
      }),
    }
  }

  private async optional(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      return await this.runner.run(cwd, args)
    } catch {
      return null
    }
  }
}
