import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  AgentBackend,
  AgentApprovalPolicy,
  AgentModel,
  AgentReviewTarget,
  AgentSandboxMode,
  AgentUxStatusProvider,
  CommandHandler,
  CommandOperation,
  CommandResult,
} from './contracts.js'
import type {
  DeliveryJob,
  DeliveryProblemAction,
  DeliveryProblemActionResult,
  DeliveryProblemState,
  OutboxRepository,
} from '../durable/contracts.js'
import { SqliteAgentSettingsRepository } from '../durable/settings-repository.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'
import type { DurableOutboundMediaStore } from '../telegram/durable-outbound-media.js'

export interface PersonalAlphaCommandsOptions {
  backendName?: string
  now?: () => number
  projects: readonly { id: string; cwd: string }[]
  defaultProjectId: string
  defaultApprovalPolicy?: AgentApprovalPolicy
  defaultSandbox?: AgentSandboxMode
  allowedSandboxModes?: readonly AgentSandboxMode[]
  uxStatus?: AgentUxStatusProvider
  bridgeVersion?: string
  codexVersion?: string
  outboundMediaStore?: DurableOutboundMediaStore
}

const PROBLEM_LIST_LIMIT = 10
const THREAD_LIST_LIMIT = 20
const TELEGRAM_SAFE_TEXT = 3_700

class SafeProjectFileError extends Error {}

function problemLine(job: DeliveryJob): string {
  return `${job.id} · ${job.kind} · попыток ${job.attemptCount} · ${new Date(job.updatedAtMs).toISOString()}`
}

function clipText(value: string, max = TELEGRAM_SAFE_TEXT): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max - 24)}\n…[обрезано bridge]`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function inside(root: string, child: string): boolean {
  const value = relative(root, child)
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`))
}

function fileMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.txt': return 'text/plain'
    case '.md': return 'text/markdown'
    case '.csv': return 'text/csv'
    case '.json': return 'application/json'
    case '.xml': return 'application/xml'
    case '.pdf': return 'application/pdf'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

function diffForPath(diff: string, requested: string): string {
  const normalized = requested.replace(/^\.\//, '')
  const sections = diff.split(/(?=^diff --git )/m)
  const matching = sections.filter((section) => {
    const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m)
    return header?.[1] === normalized || header?.[2] === normalized
  })
  return matching.join('')
}

export class PersonalAlphaCommands implements CommandHandler {
  private readonly backendName: string
  private readonly now: () => number
  private readonly projects: ReadonlyMap<string, { id: string; cwd: string }>
  private readonly defaultProjectId: string
  private readonly defaultApprovalPolicy: AgentApprovalPolicy
  private readonly defaultSandbox: AgentSandboxMode
  private readonly allowedSandboxModes: ReadonlySet<AgentSandboxMode>
  private readonly uxStatus: AgentUxStatusProvider | undefined
  private readonly bridgeVersion: string
  private readonly codexVersion: string
  private readonly outboundMediaStore: DurableOutboundMediaStore | undefined

  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly backend: AgentBackend,
    private readonly outbox: OutboxRepository,
    private readonly settings: SqliteAgentSettingsRepository,
    options: PersonalAlphaCommandsOptions,
  ) {
    this.backendName = options.backendName ?? 'codex'
    this.now = options.now ?? Date.now
    this.projects = new Map(options.projects.map((project) => [project.id, project]))
    this.defaultProjectId = options.defaultProjectId
    this.defaultApprovalPolicy = options.defaultApprovalPolicy ?? 'on-request'
    this.defaultSandbox = options.defaultSandbox ?? 'workspace-write'
    this.allowedSandboxModes = new Set(
      options.allowedSandboxModes ?? ['read-only', 'workspace-write'],
    )
    this.uxStatus = options.uxStatus
    this.bridgeVersion = options.bridgeVersion ?? 'dev'
    this.codexVersion = options.codexVersion ?? 'unknown'
    this.outboundMediaStore = options.outboundMediaStore
    if (!this.projects.has(this.defaultProjectId)) {
      throw new TypeError(`default project is not configured: ${this.defaultProjectId}`)
    }
    if (!this.allowedSandboxModes.has(this.defaultSandbox)) {
      throw new TypeError('default sandbox must be included in allowedSandboxModes')
    }
  }

  async handleCommand(operation: CommandOperation): Promise<CommandResult> {
    switch (operation.command.name) {
      case 'start':
        return {
          text: [
            'codex-tg-wire готов.',
            'Отправь текст, чтобы запустить turn.',
            '/new — новый thread · /status — состояние · /stop — остановить turn',
            '/steer <текст> — уточнить задачу внутри активного turn',
            '/threads — сохранённые Codex threads',
            '/settings — единая панель настроек',
            '/sessions · /attach · /handback — локальные Codex-сессии',
            '/auth · /login · /usage · /limits — аккаунт Codex',
            '/diff · /file · /review — inspection и review',
            '/failed · /ambiguous — problem center доставки',
          ].join('\n'),
        }
      case 'status':
        return { text: this.status(operation) }
      case 'new':
        return { text: this.reset(operation) }
      case 'stop':
        return { text: await this.stop(operation) }
      case 'steer':
        return { text: await this.steer(operation) }
      case 'failed':
        return { text: this.listFailed() }
      case 'ambiguous':
        return { text: this.listProblems('AMBIGUOUS') }
      case 'retry':
        return { text: this.problemAction(operation, 'RETRY') }
      case 'resolved':
        return { text: this.problemAction(operation, 'RESOLVE') }
      case 'archive':
        return { text: await this.archive(operation) }
      case 'threads':
        return { text: this.threads(operation) }
      case 'switch':
        return { text: this.selectThread(operation, false) }
      case 'resume':
        return { text: this.selectThread(operation, true) }
      case 'model':
        return { text: await this.model(operation) }
      case 'effort':
        return { text: await this.effort(operation) }
      case 'sandbox':
        return { text: this.sandbox(operation) }
      case 'approval':
        return { text: this.approval(operation) }
      case 'cwd':
        return { text: this.cwd(operation) }
      case 'settings':
        return this.settingsPanel(operation)
      case 'auth':
        return { text: await this.auth() }
      case 'login':
        return this.login()
      case 'limits':
        return { text: await this.limits() }
      case 'usage':
        return { text: await this.usage(operation) }
      case 'version':
        return { text: `codex-tg-wire ${this.bridgeVersion}\nCodex CLI ${this.codexVersion}` }
      case 'sessions':
        return { text: await this.nativeSessions(operation) }
      case 'attach':
        return { text: await this.attach(operation) }
      case 'handback':
        return { text: this.handback(operation) }
      case 'rename':
        return { text: await this.rename(operation) }
      case 'unarchive':
        return { text: await this.unarchive(operation) }
      case 'fork':
        return { text: await this.fork(operation) }
      case 'compact':
        return { text: await this.compact(operation) }
      case 'diff':
        return { text: this.diff(operation) }
      case 'file':
        return { text: await this.file(operation) }
      case 'review':
        return { text: await this.review(operation) }
      case 'plan':
        return { text: this.planMode(operation) }
    }
  }

  private status(operation: CommandOperation): string {
    const command = operation.command
    const settings = this.settings.getProjectSettings(
      operation.botId,
      command.chatId,
      command.projectId,
    )
    const overview = this.sessions.getOverview(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    const ux = this.uxStatus?.getStatus(
      operation.botId,
      command.chatId,
      command.projectId,
    ) ?? null
    const uxLines = ux === null
      ? []
      : [
          `UX: ${ux.phase} · ${ux.activity}`,
          ...(ux.planTotal > 0 ? [`План: ${ux.planCompleted}/${ux.planTotal}`] : []),
          ...(ux.totalTokens === null
            ? []
            : [`Контекст: ${ux.totalTokens}${ux.contextWindow === null ? '' : ` / ${ux.contextWindow}`}`]),
        ]
    if (overview.session === null) {
      return [
        `Проект: ${command.projectId}`,
        'Thread ещё не создан.',
        `Model: ${settings?.model ?? 'Codex default'}`,
        `Effort: ${settings?.effort ?? 'model default'}`,
        `Sandbox: ${settings?.sandbox ?? this.defaultSandbox}`,
        `Approval: ${settings?.approvalPolicy ?? this.defaultApprovalPolicy}`,
        ...uxLines,
      ].join('\n')
    }
    const thread = overview.binding === null
      ? 'не создан'
      : `${overview.binding.threadId} (${overview.binding.state})`
    const turn = overview.latestTurn === null
      ? 'нет'
      : `${overview.latestTurn.backendTurnId ?? overview.latestTurn.id} (${overview.latestTurn.state})`
    return [
      `Проект: ${command.projectId}`,
      `Thread: ${thread}`,
      `Последний turn: ${turn}`,
      `Model: ${settings?.model ?? 'Codex default'}`,
      `Effort: ${settings?.effort ?? 'model default'}`,
      `Sandbox: ${settings?.sandbox ?? this.defaultSandbox}`,
      `Approval: ${settings?.approvalPolicy ?? this.defaultApprovalPolicy}`,
      ...uxLines,
    ].join('\n')
  }

  private reset(operation: CommandOperation): string {
    const command = operation.command
    const force = command.args.trim().toLowerCase() === 'force'
    const reset = this.sessions.resetBinding(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
      force,
      this.now(),
    )
    switch (reset.outcome) {
      case 'no_session':
      case 'already_new':
        return 'Новый thread будет создан следующим сообщением.'
      case 'reset':
        return reset.abandonedUnknownTurns > 0
          ? `UNKNOWN turn закрыт вручную, thread ${reset.previousThreadId} отвязан. Следующее сообщение создаст новый.`
          : `Thread ${reset.previousThreadId} отвязан. Следующее сообщение создаст новый.`
      case 'blocked':
        return reset.turn.state === 'UNKNOWN'
          ? `Нельзя автоматически отбросить UNKNOWN turn ${reset.turn.backendTurnId ?? reset.turn.id}. Если принимаешь риск незавершённой работы, используй /new force.`
          : `Нельзя создать новый thread: turn ${reset.turn.backendTurnId ?? reset.turn.id} имеет состояние ${reset.turn.state}.`
    }
  }

  private async stop(operation: CommandOperation): Promise<string> {
    const command = operation.command
    const overview = this.sessions.getOverview(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    const turn = overview.activeTurn
    if (turn === null || turn.state !== 'ACTIVE') return 'Активного turn нет.'
    const binding = overview.binding
    if (binding === null || turn.backendTurnId === null) {
      return `Turn ${turn.id} ещё не получил backend id; безопасная остановка пока невозможна.`
    }
    await this.backend.interruptTurn(binding.threadId, turn.backendTurnId)
    return `Остановка turn ${turn.backendTurnId} запрошена.`
  }

  private async steer(operation: CommandOperation): Promise<string> {
    const command = operation.command
    if (command.args.trim().length === 0) return 'Использование: /steer <уточнение>'
    const overview = this.sessions.getOverview(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    const turn = overview.activeTurn
    if (turn === null || turn.state !== 'ACTIVE') return 'Активного turn для steer нет.'
    const binding = overview.binding
    if (binding === null || turn.backendTurnId === null) {
      return `Turn ${turn.id} ещё не получил backend id; steer пока невозможен.`
    }
    await this.backend.steerTurn({
      operationKey: operation.operationKey,
      threadId: binding.threadId,
      turnId: turn.backendTurnId,
      text: command.args,
    })
    return `Уточнение отправлено в turn ${turn.backendTurnId}.`
  }

  private listFailed(): string {
    const jobs = [
      ...this.outbox.listProblems('FAILED', PROBLEM_LIST_LIMIT),
      ...this.outbox.listProblems('EXPIRED', PROBLEM_LIST_LIMIT),
    ]
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id))
      .slice(0, PROBLEM_LIST_LIMIT)
    if (jobs.length === 0) return 'FAILED/EXPIRED delivery jobs нет.'
    return [
      `FAILED/EXPIRED delivery jobs (${jobs.length}):`,
      ...jobs.map(problemLine),
      'Действия: /retry <job-id> или /archive <job-id>',
    ].join('\n')
  }

  private listProblems(state: DeliveryProblemState): string {
    const jobs = this.outbox.listProblems(state, PROBLEM_LIST_LIMIT)
    if (jobs.length === 0) return `${state} delivery jobs нет.`
    return [
      `${state} delivery jobs (${jobs.length}):`,
      ...jobs.map(problemLine),
      'Проверь Telegram вручную: /resolved <job-id> <message-id> или /archive <job-id>.',
      'Прямой retry для AMBIGUOUS запрещён: исходная отправка могла дойти.',
    ].join('\n')
  }

  private problemAction(operation: CommandOperation, action: DeliveryProblemAction): string {
    const parts = operation.command.args.trim().split(/\s+/).filter(Boolean)
    if (action === 'RESOLVE') {
      if (parts.length !== 2 || !/^[1-9]\d*$/.test(parts[1] ?? '')) {
        return 'Использование: /resolved <job-id> <telegram-message-id>'
      }
    } else if (parts.length !== 1) {
      const command = action === 'RETRY' ? 'retry' : 'archive'
      return `Использование: /${command} <job-id>`
    }
    const jobId = parts[0] as string
    const result = this.outbox.actOnProblem({
      operationKey: operation.operationKey,
      jobId,
      action,
      actorBotId: operation.botId,
      actorChatId: operation.command.chatId,
      ...(action === 'RESOLVE' ? { remoteId: `telegram:${parts[1] as string}` } : {}),
      nowMs: this.now(),
    })
    return this.formatProblemAction(action, jobId, result)
  }

  private threads(operation: CommandOperation): string {
    const command = operation.command
    const threads = this.sessions.listThreads(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    if (threads.length === 0) return `Проект: ${command.projectId}\nСохранённых threads нет.`
    const visible = threads.slice(0, THREAD_LIST_LIMIT)
    const lines = visible.map((thread) => {
      const marker = thread.selected
        ? '●'
        : thread.state === 'ARCHIVED'
          ? '◌'
          : thread.state === 'BROKEN'
            ? '⚠'
            : '○'
      const state = thread.selected ? thread.bindingState : thread.state
      return `${marker} ${thread.threadId} · ${state}`
    })
    if (threads.length > visible.length) lines.push(`…ещё ${threads.length - visible.length}`)
    lines.push('/switch <thread-id> · /resume <archived-thread-id>')
    return [`Проект: ${command.projectId}`, ...lines].join('\n')
  }

  private selectThread(operation: CommandOperation, resumeArchived: boolean): string {
    const commandName = resumeArchived ? 'resume' : 'switch'
    const parts = operation.command.args.trim().split(/\s+/).filter(Boolean)
    if (parts.length !== 1) return `Использование: /${commandName} <thread-id>`
    const threadId = parts[0] as string
    const result = this.sessions.selectThread(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
      threadId,
      resumeArchived,
      this.now(),
    )
    switch (result.outcome) {
      case 'no_session':
      case 'not_found':
        return `Thread ${threadId} не найден в этом проекте.`
      case 'archived':
        return `Thread ${threadId} архивирован. Используй /resume ${threadId}.`
      case 'unavailable':
        return `Thread ${threadId} помечен BROKEN и недоступен для resume.`
      case 'already_selected':
        return `Thread ${threadId} уже выбран.`
      case 'blocked':
        return `Нельзя переключить thread: turn ${result.turn.backendTurnId ?? result.turn.id} имеет состояние ${result.turn.state}.`
      case 'selected':
        return result.previousThreadId === null
          ? `Thread ${threadId} выбран. Следующее сообщение продолжит его.`
          : `Thread ${result.previousThreadId} заменён на ${threadId}. Следующее сообщение продолжит выбранный thread.`
    }
  }

  private async archive(operation: CommandOperation): Promise<string> {
    const parts = operation.command.args.trim().split(/\s+/).filter(Boolean)
    if (parts.length !== 1) return 'Использование: /archive <job-id|thread-id>'
    const targetId = parts[0] as string
    if (this.outbox.get(targetId) !== null) return this.problemAction(operation, 'ARCHIVE')

    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    if (overview.activeTurn !== null && overview.binding?.threadId === targetId) {
      return `Нельзя архивировать активный thread: turn ${overview.activeTurn.backendTurnId ?? overview.activeTurn.id} имеет состояние ${overview.activeTurn.state}.`
    }
    if (this.backend.listNativeThreads !== undefined) {
      const native = await this.findNativeThread(operation, targetId)
      if (native === null) return `Job или thread ${targetId} не найден.`
      if (!native.archived && this.backend.archiveNativeThread !== undefined) {
        await this.backend.archiveNativeThread(targetId)
      }
    }
    const result = this.sessions.archiveThread(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
      targetId,
      this.now(),
    )
    switch (result.outcome) {
      case 'no_session':
      case 'not_found':
        return `Native thread ${targetId} архивирован.`
      case 'already_archived':
        return `Thread ${targetId} уже архивирован.`
      case 'blocked':
        return `Нельзя архивировать активный thread: turn ${result.turn.backendTurnId ?? result.turn.id} имеет состояние ${result.turn.state}.`
      case 'archived':
        return result.wasSelected
          ? `Thread ${targetId} архивирован и отвязан. Следующее сообщение создаст новый.`
          : `Thread ${targetId} архивирован.`
    }
  }

  private async model(operation: CommandOperation): Promise<string> {
    const requested = operation.command.args.trim()
    if (requested.toLowerCase() === 'default') {
      this.settings.updateProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
        { model: null, effort: null },
        this.now(),
      )
      return 'Model и effort сброшены к значениям Codex по умолчанию.'
    }
    const models = await this.backend.listModels()
    const current = this.settings.getProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
    )
    if (requested.length === 0) return this.formatModels(models, current?.model ?? null)
    const normalized = requested.toLowerCase()
    const selected = models.find(
      (model) => model.model.toLowerCase() === normalized || model.id.toLowerCase() === normalized,
    )
    if (selected === undefined) {
      return `Model ${requested} отсутствует в текущем Codex model/list. Используй /model.`
    }
    const keepEffort = current?.effort !== null && current?.effort !== undefined &&
      selected.supportedEfforts.includes(current.effort)
      ? current.effort
      : null
    this.settings.updateProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      { model: selected.model, effort: keepEffort },
      this.now(),
    )
    return `Model для проекта ${operation.command.projectId}: ${selected.model}.`
  }

  private formatModels(models: readonly AgentModel[], current: string | null): string {
    if (models.length === 0) return 'Codex не вернул доступных моделей.'
    const lines = models.slice(0, 20).map((model) => {
      const marker = current === model.model || (current === null && model.isDefault) ? '●' : '○'
      const efforts = model.supportedEfforts.length === 0
        ? ''
        : ` · effort: ${model.supportedEfforts.join(',')}`
      return `${marker} ${model.model} — ${model.displayName}${efforts}`
    })
    if (models.length > 20) lines.push(`…ещё ${models.length - 20}`)
    lines.push('/model <id> · /model default')
    return lines.join('\n')
  }

  private async effort(operation: CommandOperation): Promise<string> {
    const requested = operation.command.args.trim()
    if (requested.toLowerCase() === 'default') {
      this.settings.updateProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
        { effort: null },
        this.now(),
      )
      return 'Effort сброшен к значению выбранной модели по умолчанию.'
    }
    const models = await this.backend.listModels()
    const current = this.settings.getProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
    )
    const selectedModel = current?.model === null || current?.model === undefined
      ? models.find((model) => model.isDefault) ?? models[0]
      : models.find((model) => model.model === current.model || model.id === current.model)
    if (selectedModel === undefined) return 'Сначала выбери доступную модель через /model.'
    if (requested.length === 0) {
      const values = selectedModel.supportedEfforts
      if (values.length === 0) return `Model ${selectedModel.model} не объявила варианты effort.`
      return [
        `Model: ${selectedModel.model}`,
        ...values.map((value) => {
          const active = current?.effort === value ||
            (current?.effort == null && selectedModel.defaultEffort === value)
          return `${active ? '●' : '○'} ${value}`
        }),
        '/effort <value> · /effort default',
      ].join('\n')
    }
    const effort = selectedModel.supportedEfforts.find(
      (value) => value.toLowerCase() === requested.toLowerCase(),
    )
    if (effort === undefined) {
      return `Effort ${requested} не поддерживается model ${selectedModel.model}. Используй /effort.`
    }
    this.settings.updateProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      { effort },
      this.now(),
    )
    return `Effort для ${selectedModel.model}: ${effort}.`
  }

  private sandbox(operation: CommandOperation): string {
    const requested = operation.command.args.trim().toLowerCase()
    if (requested.length === 0) {
      const current = this.settings.getProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
      )?.sandbox ?? this.defaultSandbox
      return [
        `Sandbox: ${current}`,
        ...[...this.allowedSandboxModes].map((value) => `${value === current ? '●' : '○'} ${value}`),
        '/sandbox <mode> · /sandbox default',
      ].join('\n')
    }
    if (requested === 'default') {
      this.settings.updateProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
        { sandbox: null },
        this.now(),
      )
      return `Sandbox сброшен к default: ${this.defaultSandbox}.`
    }
    if (
      requested !== 'read-only' &&
      requested !== 'workspace-write' &&
      requested !== 'danger-full-access'
    ) {
      return 'Неизвестный sandbox mode. Используй /sandbox.'
    }
    if (!this.allowedSandboxModes.has(requested)) {
      return `Sandbox ${requested} запрещён конфигурацией bridge.`
    }
    this.settings.updateProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      { sandbox: requested },
      this.now(),
    )
    return `Sandbox для проекта ${operation.command.projectId}: ${requested}.`
  }

  private approval(operation: CommandOperation): string {
    const requested = operation.command.args.trim().toLowerCase()
    const values: readonly AgentApprovalPolicy[] = ['untrusted', 'on-request', 'never']
    if (requested.length === 0) {
      const current = this.settings.getProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
      )?.approvalPolicy ?? this.defaultApprovalPolicy
      return [
        `Approval: ${current}`,
        ...values.map((value) => `${value === current ? '●' : '○'} ${value}`),
        '/approval <policy> · /approval default',
      ].join('\n')
    }
    if (requested === 'default') {
      this.settings.updateProjectSettings(
        operation.botId,
        operation.command.chatId,
        operation.command.projectId,
        { approvalPolicy: null },
        this.now(),
      )
      return `Approval сброшен к default: ${this.defaultApprovalPolicy}.`
    }
    if (requested !== 'untrusted' && requested !== 'on-request' && requested !== 'never') {
      return 'Неизвестная approval policy. Используй /approval.'
    }
    this.settings.updateProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      { approvalPolicy: requested },
      this.now(),
    )
    return `Approval policy для проекта ${operation.command.projectId}: ${requested}.`
  }

  private cwd(operation: CommandOperation): string {
    const requested = operation.command.args.trim()
    const selected = this.settings.getSelectedProject(
      operation.botId,
      operation.command.chatId,
    ) ?? this.defaultProjectId
    if (requested.length === 0) {
      return [
        `Текущий проект: ${selected}`,
        ...[...this.projects.values()].map(
          (project) => `${project.id === selected ? '●' : '○'} ${project.id}`,
        ),
        '/cwd <project-id>',
      ].join('\n')
    }
    const project = this.projects.get(requested)
    if (project === undefined) return `Проект ${requested} не разрешён. Используй /cwd.`
    if (project.id === selected) return `Проект ${project.id} уже выбран.`
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    if (overview.activeTurn !== null) {
      return `Нельзя сменить проект: turn ${overview.activeTurn.backendTurnId ?? overview.activeTurn.id} имеет состояние ${overview.activeTurn.state}.`
    }
    this.settings.selectProject(
      operation.botId,
      operation.command.chatId,
      project.id,
      this.now(),
    )
    return `Текущий проект: ${project.id}. Следующее сообщение использует разрешённый cwd этого проекта.`
  }

  private settingsPanel(operation: CommandOperation): CommandResult {
    const current = this.settings.getProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
    )
    return {
      text: [
        `⚙️ ${operation.command.projectId}`,
        `Model: ${current?.model ?? 'Codex default'}`,
        `Effort: ${current?.effort ?? 'model default'}`,
        `Sandbox: ${current?.sandbox ?? this.defaultSandbox}`,
        `Approval: ${current?.approvalPolicy ?? this.defaultApprovalPolicy}`,
        `Guided Plan: ${current?.guidedPlanEnabled === true ? 'on' : 'off'}`,
        'Кнопки открывают безопасный выбор; значения сохраняются в SQLite.',
      ].join('\n'),
      buttons: [
        [
          { text: 'Model', callbackData: 'dx:s:open:model' },
          { text: 'Effort', callbackData: 'dx:s:open:effort' },
        ],
        [
          { text: 'Sandbox', callbackData: 'dx:s:open:sandbox' },
          { text: 'Approval', callbackData: 'dx:s:open:approval' },
        ],
        [
          { text: 'Project', callbackData: 'dx:s:open:cwd' },
          { text: 'Guided Plan', callbackData: 'dx:s:open:plan' },
        ],
      ],
    }
  }

  async handleSettingsAction(input: {
    botId: string
    chatId: string
    projectId: string
    operationKey: string
    action: string
  }): Promise<CommandResult> {
    const operation: CommandOperation = {
      operationKey: input.operationKey,
      botId: input.botId,
      inboxUpdateId: 0,
      updateId: 0,
      command: {
        chatId: input.chatId,
        projectId: input.projectId,
        name: 'settings',
        args: '',
      },
    }
    const [verb, category, rawIndex] = input.action.split(':')
    if (verb === 'open') {
      if (category === 'model') {
        const models = await this.backend.listModels()
        return {
          text: 'Выбери model:',
          buttons: [
            ...models.slice(0, 20).map((model, index) => [{
              text: `${model.isDefault ? '★ ' : ''}${model.model}`,
              callbackData: `dx:s:set:model:${index}`,
            }]),
            [{ text: 'Codex default', callbackData: 'dx:s:set:model:default' }],
          ],
        }
      }
      if (category === 'effort') {
        const models = await this.backend.listModels()
        const current = this.settings.getProjectSettings(input.botId, input.chatId, input.projectId)
        const model = current?.model === null || current?.model === undefined
          ? models.find((item) => item.isDefault) ?? models[0]
          : models.find((item) => item.model === current.model || item.id === current.model)
        const efforts = model?.supportedEfforts ?? []
        return {
          text: `Effort для ${model?.model ?? 'текущей model'}:`,
          buttons: [
            ...efforts.map((effort, index) => [{
              text: effort,
              callbackData: `dx:s:set:effort:${index}`,
            }]),
            [{ text: 'Model default', callbackData: 'dx:s:set:effort:default' }],
          ],
        }
      }
      if (category === 'sandbox') {
        return {
          text: 'Выбери sandbox:',
          buttons: [...this.allowedSandboxModes].map((value) => [{
            text: value,
            callbackData: `dx:s:set:sandbox:${value}`,
          }]),
        }
      }
      if (category === 'approval') {
        return {
          text: 'Выбери approval policy:',
          buttons: (['untrusted', 'on-request', 'never'] as const).map((value) => [{
            text: value,
            callbackData: `dx:s:set:approval:${value}`,
          }]),
        }
      }
      if (category === 'cwd') {
        return {
          text: 'Выбери разрешённый проект:',
          buttons: [...this.projects.values()].map((project, index) => [{
            text: project.id,
            callbackData: `dx:s:set:cwd:${index}`,
          }]),
        }
      }
      if (category === 'plan') {
        return {
          text: 'Guided Plan gate:',
          buttons: [[
            { text: 'On', callbackData: 'dx:s:set:plan:on' },
            { text: 'Off', callbackData: 'dx:s:set:plan:off' },
          ]],
        }
      }
    }

    if (verb !== 'set' || category === undefined || rawIndex === undefined) {
      return { text: 'Настройка устарела. Открой /settings заново.' }
    }
    if (category === 'model') {
      if (rawIndex === 'default') {
        this.settings.updateProjectSettings(
          input.botId, input.chatId, input.projectId,
          { model: null, effort: null }, this.now(),
        )
      } else {
        const selected = (await this.backend.listModels())[Number.parseInt(rawIndex, 10)]
        if (selected === undefined) return { text: 'Model list изменилась. Открой /settings снова.' }
        this.settings.updateProjectSettings(
          input.botId, input.chatId, input.projectId,
          { model: selected.model, effort: null }, this.now(),
        )
      }
    } else if (category === 'effort') {
      if (rawIndex === 'default') {
        this.settings.updateProjectSettings(
          input.botId, input.chatId, input.projectId, { effort: null }, this.now(),
        )
      } else {
        const models = await this.backend.listModels()
        const current = this.settings.getProjectSettings(input.botId, input.chatId, input.projectId)
        const model = current?.model === null || current?.model === undefined
          ? models.find((item) => item.isDefault) ?? models[0]
          : models.find((item) => item.model === current.model || item.id === current.model)
        const effort = model?.supportedEfforts[Number.parseInt(rawIndex, 10)]
        if (effort === undefined) return { text: 'Effort list изменилась. Открой /settings снова.' }
        this.settings.updateProjectSettings(
          input.botId, input.chatId, input.projectId, { effort }, this.now(),
        )
      }
    } else if (category === 'sandbox') {
      if (!this.allowedSandboxModes.has(rawIndex as AgentSandboxMode)) {
        return { text: 'Этот sandbox запрещён конфигурацией bridge.' }
      }
      this.settings.updateProjectSettings(
        input.botId, input.chatId, input.projectId,
        { sandbox: rawIndex as AgentSandboxMode }, this.now(),
      )
    } else if (category === 'approval') {
      if (!['untrusted', 'on-request', 'never'].includes(rawIndex)) {
        return { text: 'Неизвестная approval policy.' }
      }
      this.settings.updateProjectSettings(
        input.botId, input.chatId, input.projectId,
        { approvalPolicy: rawIndex as AgentApprovalPolicy }, this.now(),
      )
    } else if (category === 'cwd') {
      const project = [...this.projects.values()][Number.parseInt(rawIndex, 10)]
      if (project === undefined) return { text: 'Project list изменилась. Открой /settings снова.' }
      const overview = this.sessions.getOverview(
        input.botId, input.chatId, input.projectId, this.backendName,
      )
      if (overview.activeTurn !== null) return { text: 'Нельзя менять project во время активного turn.' }
      this.settings.selectProject(input.botId, input.chatId, project.id, this.now())
      return { text: `Текущий проект: ${project.id}.` }
    } else if (category === 'plan') {
      if (rawIndex !== 'on' && rawIndex !== 'off') return { text: 'Неизвестный режим Guided Plan.' }
      this.settings.updateProjectSettings(
        input.botId, input.chatId, input.projectId,
        { guidedPlanEnabled: rawIndex === 'on' }, this.now(),
      )
    } else {
      return { text: 'Настройка устарела. Открой /settings заново.' }
    }
    return this.settingsPanel(operation)
  }

  private planMode(operation: CommandOperation): string {
    const requested = operation.command.args.trim().toLowerCase()
    const current = this.settings.getProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
    )?.guidedPlanEnabled ?? false
    if (requested.length === 0) {
      return `Guided Plan: ${current ? 'on' : 'off'}\n/plan on · /plan off`
    }
    if (requested !== 'on' && requested !== 'off') return 'Использование: /plan on|off'
    this.settings.updateProjectSettings(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      { guidedPlanEnabled: requested === 'on' },
      this.now(),
    )
    return `Guided Plan: ${requested}.`
  }

  private async auth(): Promise<string> {
    if (this.backend.readAccount === undefined) return 'Эта версия backend не поддерживает account/read.'
    const account = await this.backend.readAccount()
    if (account.kind === 'none') {
      return account.requiresOpenaiAuth
        ? 'Codex не авторизован. Используй /login.'
        : 'Аккаунт не подключён; OpenAI auth для текущего backend не требуется.'
    }
    return [
      `Auth: ${account.kind}`,
      ...(account.email === null ? [] : [`Email: ${account.email}`]),
      ...(account.planType === null ? [] : [`Plan: ${account.planType}`]),
    ].join('\n')
  }

  private async login(): Promise<CommandResult> {
    if (this.backend.startDeviceLogin === undefined) {
      return { text: 'Эта версия backend не поддерживает device-code login.' }
    }
    const login = await this.backend.startDeviceLogin()
    return {
      text: [
        'Войди в ChatGPT по ссылке и введи одноразовый код:',
        login.userCode,
        'После подтверждения проверь /auth.',
      ].join('\n\n'),
      buttons: [[{ text: 'Открыть страницу входа', url: login.verificationUrl }]],
    }
  }

  private async limits(): Promise<string> {
    if (this.backend.readRateLimits === undefined) {
      return 'Эта версия backend не поддерживает account/rateLimits/read.'
    }
    const limits = await this.backend.readRateLimits()
    if (limits.length === 0) return 'Codex не вернул rate limits.'
    const lines: string[] = []
    for (const limit of limits) {
      lines.push(`${limit.name ?? limit.id}${limit.planType === null ? '' : ` · ${limit.planType}`}`)
      for (const [label, window] of [['Основное', limit.primary], ['Дополнительное', limit.secondary]] as const) {
        if (window === null) continue
        const reset = window.resetsAt === null
          ? ''
          : ` · reset ${new Date(window.resetsAt * 1_000).toISOString()}`
        lines.push(`${label}: ${window.usedPercent.toFixed(1)}% использовано${reset}`)
      }
      if (limit.reachedType !== null) lines.push(`Ограничение: ${limit.reachedType}`)
    }
    return clipText(lines.join('\n'))
  }

  private async usage(operation: CommandOperation): Promise<string> {
    if (this.backend.readUsage === undefined) {
      return 'Эта версия backend не поддерживает account/usage/read.'
    }
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    const usage = await this.backend.readUsage(overview.binding?.threadId)
    const lines = [
      `Lifetime tokens: ${usage.lifetimeTokens ?? 'н/д'}`,
      `Peak daily: ${usage.peakDailyTokens ?? 'н/д'}`,
      `Current streak: ${usage.currentStreakDays ?? 'н/д'} дней`,
    ]
    if (usage.recentDaily.length > 0) {
      lines.push('Последние дни:', ...usage.recentDaily.map((day) => `${day.date}: ${day.tokens}`))
    }
    if (usage.thread !== null) {
      lines.push(
        `Thread ${usage.thread.id}: ${usage.thread.creditsMicros} credit μ` +
          (usage.thread.usdMicros === null ? '' : ` · ${usage.thread.usdMicros} USD μ`),
      )
    }
    return clipText(lines.join('\n'))
  }

  private async nativeSessions(operation: CommandOperation): Promise<string> {
    if (this.backend.listNativeThreads === undefined) {
      return 'Эта версия backend не поддерживает thread/list.'
    }
    const tokens = operation.command.args.trim().split(/\s+/).filter(Boolean)
    const archived = tokens[0]?.toLowerCase() === 'archived'
    if (archived) tokens.shift()
    const project = this.projects.get(operation.command.projectId)
    if (project === undefined) return 'Текущий проект не разрешён.'
    const threads = await this.backend.listNativeThreads({
      cwd: [project.cwd],
      archived,
      ...(tokens.length === 0 ? {} : { search: tokens.join(' ') }),
    })
    if (threads.length === 0) {
      return archived ? 'Архивных Codex-сессий в этом проекте нет.' : 'Codex-сессий в этом проекте нет.'
    }
    const visible = threads.slice(0, THREAD_LIST_LIMIT)
    const lines = visible.map((thread) => {
      const title = thread.name ?? (thread.preview.replace(/\s+/g, ' ').trim() || 'без названия')
      return `${thread.archived ? '◌' : '○'} ${thread.id} · ${clipText(title, 90)} · ${thread.status}`
    })
    if (threads.length > visible.length) lines.push(`…ещё ${threads.length - visible.length}`)
    lines.push('/attach <thread-id> · /sessions archived')
    return clipText(lines.join('\n'))
  }

  private async findNativeThread(operation: CommandOperation, threadId: string) {
    if (this.backend.listNativeThreads === undefined) return null
    const project = this.projects.get(operation.command.projectId)
    if (project === undefined) return null
    for (const archived of [false, true]) {
      const threads = await this.backend.listNativeThreads({
        cwd: [project.cwd], archived,
      })
      const found = threads.find((thread) => thread.id === threadId)
      if (found !== undefined) return found
    }
    return null
  }

  private async attach(operation: CommandOperation): Promise<string> {
    const threadId = operation.command.args.trim()
    if (threadId.length === 0 || /\s/.test(threadId)) return 'Использование: /attach <thread-id>'
    const thread = await this.findNativeThread(operation, threadId)
    if (thread === null) return `Thread ${threadId} не найден в разрешённом cwd.`
    if (thread.archived) return `Thread ${threadId} архивирован. Используй /unarchive ${threadId}.`
    const result = this.sessions.attachExternalThread(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
      threadId,
      this.now(),
    )
    if (result.outcome === 'blocked') {
      return `Нельзя attach: turn ${result.turn.backendTurnId ?? result.turn.id} имеет состояние ${result.turn.state}.`
    }
    return result.outcome === 'already_selected'
      ? `Thread ${threadId} уже выбран.`
      : `Thread ${threadId} подключён. Следующее сообщение продолжит его.`
  }

  private handback(operation: CommandOperation): string {
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    if (overview.binding === null) return 'Сначала создай или подключи thread.'
    const project = this.projects.get(operation.command.projectId)
    if (project === undefined) return 'Текущий проект не разрешён.'
    return `Продолжить локально:\ncd -- ${shellQuote(project.cwd)} && codex resume ${shellQuote(overview.binding.threadId)}`
  }

  private async rename(operation: CommandOperation): Promise<string> {
    if (this.backend.renameThread === undefined) return 'Эта версия backend не поддерживает rename.'
    const match = operation.command.args.trim().match(/^(\S+)\s+([\s\S]+)$/)
    if (match?.[1] === undefined || match[2] === undefined) {
      return 'Использование: /rename <thread-id> <новое имя>'
    }
    const thread = await this.findNativeThread(operation, match[1])
    if (thread === null) return `Thread ${match[1]} не найден в разрешённом cwd.`
    await this.backend.renameThread(match[1], match[2].trim().slice(0, 200))
    return `Thread ${match[1]} переименован.`
  }

  private async unarchive(operation: CommandOperation): Promise<string> {
    if (this.backend.unarchiveNativeThread === undefined) return 'Эта версия backend не поддерживает unarchive.'
    const threadId = operation.command.args.trim()
    if (threadId.length === 0 || /\s/.test(threadId)) return 'Использование: /unarchive <thread-id>'
    const thread = await this.findNativeThread(operation, threadId)
    if (thread === null) return `Thread ${threadId} не найден в разрешённом cwd.`
    if (thread.archived) await this.backend.unarchiveNativeThread(threadId)
    const result = this.sessions.attachExternalThread(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
      threadId,
      this.now(),
    )
    return result.outcome === 'blocked'
      ? `Thread разархивирован, но attach заблокирован turn ${result.turn.backendTurnId ?? result.turn.id}.`
      : `Thread ${threadId} разархивирован и выбран.`
  }

  private async fork(operation: CommandOperation): Promise<string> {
    if (this.backend.forkNativeThread === undefined) return 'Эта версия backend не поддерживает fork.'
    const threadId = operation.command.args.trim()
    if (threadId.length === 0 || /\s/.test(threadId)) return 'Использование: /fork <thread-id>'
    const thread = await this.findNativeThread(operation, threadId)
    if (thread === null || thread.archived) return `Активный thread ${threadId} не найден в разрешённом cwd.`
    const project = this.projects.get(operation.command.projectId)
    if (project === undefined) return 'Текущий проект не разрешён.'
    const forked = await this.backend.forkNativeThread(threadId, project.cwd)
    const attached = this.sessions.attachExternalThread(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
      forked,
      this.now(),
    )
    return attached.outcome === 'blocked'
      ? `Fork ${forked} создан, но текущий активный turn мешает переключению.`
      : `Fork ${forked} создан и выбран.`
  }

  private async compact(operation: CommandOperation): Promise<string> {
    if (this.backend.compactThread === undefined) return 'Эта версия backend не поддерживает compact.'
    const requested = operation.command.args.trim()
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    const threadId = requested || overview.binding?.threadId
    if (threadId === undefined) return 'Использование: /compact <thread-id> или выбери thread.'
    if (overview.activeTurn !== null) return 'Нельзя compact во время активного turn.'
    const thread = await this.findNativeThread(operation, threadId)
    if (thread === null || thread.archived) return `Thread ${threadId} недоступен в разрешённом cwd.`
    await this.backend.compactThread(threadId)
    return `Compaction для thread ${threadId} запущен.`
  }

  private diff(operation: CommandOperation): string {
    if (this.backend.getLatestDiff === undefined) return 'Эта версия backend не собирает turn diff.'
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    if (overview.binding === null) return 'Сначала создай или подключи thread.'
    const artifact = this.backend.getLatestDiff(overview.binding.threadId)
    if (artifact === null || artifact.diff.trim().length === 0) return 'Для выбранного thread diff пока нет.'
    const requested = operation.command.args.trim()
    const value = requested.length === 0 ? artifact.diff : diffForPath(artifact.diff, requested)
    if (value.trim().length === 0) return `В последнем diff нет пути ${requested}.`
    return clipText(`Thread ${artifact.threadId} · turn ${artifact.turnId}\n\n${value}`)
  }

  private async resolveProjectFile(operation: CommandOperation, path: string): Promise<string> {
    const project = this.projects.get(operation.command.projectId)
    if (project === undefined) throw new SafeProjectFileError('Текущий проект не разрешён.')
    const root = await realpath(project.cwd)
    const unresolved = resolve(root, path)
    if (!inside(root, unresolved)) {
      throw new SafeProjectFileError('Путь выходит за пределы разрешённого cwd.')
    }
    const candidate = await realpath(unresolved)
    if (!inside(root, candidate)) {
      throw new SafeProjectFileError('Путь выходит за пределы разрешённого cwd.')
    }
    const metadata = await stat(candidate)
    if (!metadata.isFile()) throw new SafeProjectFileError('Путь не является обычным файлом.')
    return candidate
  }

  private async file(operation: CommandOperation): Promise<string> {
    const parts = operation.command.args.trim().split(/\s+/).filter(Boolean)
    const sendAll = parts[0] === '--all' || parts.at(-1) === '--all'
    const path = parts.filter((part) => part !== '--all').join(' ')
    if (path.length === 0) return 'Использование: /file [--all] <путь внутри проекта>'
    let resolved: string
    try {
      resolved = await this.resolveProjectFile(operation, path)
    } catch (error) {
      return error instanceof SafeProjectFileError
        ? error.message
        : 'Файл не найден или недоступен внутри выбранного проекта.'
    }
    if (sendAll) {
      if (this.outboundMediaStore === undefined) return 'Отправка файлов отключена в конфигурации.'
      const mimeType = fileMime(resolved)
      if (mimeType === 'application/octet-stream') {
        return 'Тип файла не входит в allowlist outbound media.'
      }
      const reference = await this.outboundMediaStore.register({
        path: resolved,
        fileName: basename(resolved),
        mimeType,
        kind: 'document',
      })
      this.outbox.enqueue({
        sourceKey: `${operation.operationKey}:file`,
        kind: 'send_media',
        payload: {
          chatId: operation.command.chatId,
          mediaKind: 'document',
          reference,
          caption: basename(resolved),
        },
        createdAtMs: this.now(),
      })
      return `Файл ${basename(resolved)} поставлен в durable outbox.`
    }
    const metadata = await stat(resolved)
    if (metadata.size > 256 * 1024) {
      return `Файл ${basename(resolved)} слишком велик для preview (${metadata.size} bytes). Используй /file --all ${path}`
    }
    const content = await readFile(resolved, 'utf8')
    if (content.includes('\u0000')) return 'Бинарный файл нельзя показать текстом. Используй /file --all.'
    return clipText(`${basename(resolved)}\n\n${content}`)
  }

  private async review(operation: CommandOperation): Promise<string> {
    if (this.backend.runReview === undefined) return 'Эта версия backend не поддерживает review/start.'
    const overview = this.sessions.getOverview(
      operation.botId,
      operation.command.chatId,
      operation.command.projectId,
      this.backendName,
    )
    if (overview.binding === null) return 'Сначала создай или подключи thread.'
    const args = operation.command.args.trim()
    let target: AgentReviewTarget
    if (args.length === 0 || args === 'uncommitted') {
      target = { type: 'uncommittedChanges' }
    } else if (args.startsWith('base ')) {
      target = { type: 'baseBranch', branch: args.slice(5).trim() }
    } else if (args.startsWith('commit ')) {
      target = { type: 'commit', sha: args.slice(7).trim(), title: null }
    } else if (args.startsWith('custom ')) {
      target = { type: 'custom', instructions: args.slice(7).trim() }
    } else {
      return 'Использование: /review [uncommitted|base <branch>|commit <sha>|custom <instructions>]'
    }
    const result = await this.backend.runReview({
      operationKey: operation.operationKey,
      threadId: overview.binding.threadId,
      target,
    })
    return clipText(result.finalText)
  }

  private formatProblemAction(
    action: DeliveryProblemAction,
    jobId: string,
    result: DeliveryProblemActionResult,
  ): string {
    if (result.outcome === 'not_found') return `Delivery job ${jobId} не найден.`
    if (result.outcome === 'invalid_state') {
      if (result.job.state === 'AMBIGUOUS' && action === 'RETRY') {
        return `Job ${jobId} имеет состояние AMBIGUOUS: retry запрещён из-за риска дубля. Используй /resolved или /archive.`
      }
      return `Действие ${action} неприменимо: job ${jobId} имеет состояние ${result.job.state}.`
    }
    if (result.outcome === 'replayed' && action === 'RETRY') {
      return `Retry job ${jobId} уже применён; текущее состояние ${result.job.state}.`
    }
    const replay = result.outcome === 'replayed' ? ' (уже применено)' : ''
    switch (action) {
      case 'RETRY':
        return `Job ${jobId} возвращён в PENDING${replay}.`
      case 'RESOLVE':
        return `Job ${jobId} отмечен DELIVERED с remote proof ${result.job.remoteId}${replay}.`
      case 'ARCHIVE':
        return `Job ${jobId} архивирован${replay}.`
    }
  }
}
