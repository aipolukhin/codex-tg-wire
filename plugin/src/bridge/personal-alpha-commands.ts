import type {
  AgentBackend,
  AgentApprovalPolicy,
  AgentModel,
  AgentSandboxMode,
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

export interface PersonalAlphaCommandsOptions {
  backendName?: string
  now?: () => number
  projects: readonly { id: string; cwd: string }[]
  defaultProjectId: string
  defaultApprovalPolicy?: AgentApprovalPolicy
  defaultSandbox?: AgentSandboxMode
  allowedSandboxModes?: readonly AgentSandboxMode[]
}

const PROBLEM_LIST_LIMIT = 10
const THREAD_LIST_LIMIT = 20

function problemLine(job: DeliveryJob): string {
  return `${job.id} · ${job.kind} · попыток ${job.attemptCount} · ${new Date(job.updatedAtMs).toISOString()}`
}

export class PersonalAlphaCommands implements CommandHandler {
  private readonly backendName: string
  private readonly now: () => number
  private readonly projects: ReadonlyMap<string, { id: string; cwd: string }>
  private readonly defaultProjectId: string
  private readonly defaultApprovalPolicy: AgentApprovalPolicy
  private readonly defaultSandbox: AgentSandboxMode
  private readonly allowedSandboxModes: ReadonlySet<AgentSandboxMode>

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
            'Dashi Codex bridge готов.',
            'Отправь текст, чтобы запустить turn.',
            '/new — новый thread · /status — состояние · /stop — остановить turn',
            '/steer <текст> — уточнить задачу внутри активного turn',
            '/threads — сохранённые Codex threads',
            '/model · /effort · /sandbox · /approval · /cwd — настройки',
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
        return { text: this.archive(operation) }
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
    if (overview.session === null) {
      return [
        `Проект: ${command.projectId}`,
        'Thread ещё не создан.',
        `Model: ${settings?.model ?? 'Codex default'}`,
        `Effort: ${settings?.effort ?? 'model default'}`,
        `Sandbox: ${settings?.sandbox ?? this.defaultSandbox}`,
        `Approval: ${settings?.approvalPolicy ?? this.defaultApprovalPolicy}`,
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

  private archive(operation: CommandOperation): string {
    const parts = operation.command.args.trim().split(/\s+/).filter(Boolean)
    if (parts.length !== 1) return 'Использование: /archive <job-id|thread-id>'
    const targetId = parts[0] as string
    if (this.outbox.get(targetId) !== null) return this.problemAction(operation, 'ARCHIVE')

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
        return `Job или thread ${targetId} не найден.`
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
