import type {
  AgentBackend,
  CommandHandler,
  CommandOperation,
  CommandResult,
} from './contracts.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'

export interface PersonalAlphaCommandsOptions {
  backendName?: string
}

export class PersonalAlphaCommands implements CommandHandler {
  private readonly backendName: string

  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly backend: AgentBackend,
    options: PersonalAlphaCommandsOptions = {},
  ) {
    this.backendName = options.backendName ?? 'codex'
  }

  async handleCommand(operation: CommandOperation): Promise<CommandResult> {
    switch (operation.command.name) {
      case 'start':
        return {
          text: [
            'Dashi Codex bridge готов.',
            'Отправь текст, чтобы запустить turn.',
            '/new — новый thread · /status — состояние · /stop — остановить turn',
          ].join('\n'),
        }
      case 'status':
        return { text: this.status(operation) }
      case 'new':
        return { text: this.reset(operation) }
      case 'stop':
        return { text: await this.stop(operation) }
    }
  }

  private status(operation: CommandOperation): string {
    const command = operation.command
    const overview = this.sessions.getOverview(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    if (overview.session === null) {
      return `Проект: ${command.projectId}\nThread ещё не создан.`
    }
    const thread = overview.binding === null
      ? 'не создан'
      : `${overview.binding.threadId} (${overview.binding.state})`
    const turn = overview.latestTurn === null
      ? 'нет'
      : `${overview.latestTurn.backendTurnId ?? overview.latestTurn.id} (${overview.latestTurn.state})`
    return `Проект: ${command.projectId}\nThread: ${thread}\nПоследний turn: ${turn}`
  }

  private reset(operation: CommandOperation): string {
    const command = operation.command
    const reset = this.sessions.resetBinding(
      operation.botId,
      command.chatId,
      command.projectId,
      this.backendName,
    )
    switch (reset.outcome) {
      case 'no_session':
      case 'already_new':
        return 'Новый thread будет создан следующим сообщением.'
      case 'reset':
        return `Thread ${reset.previousThreadId} отвязан. Следующее сообщение создаст новый.`
      case 'blocked':
        return `Нельзя создать новый thread: turn ${reset.turn.backendTurnId ?? reset.turn.id} имеет состояние ${reset.turn.state}.`
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
}
