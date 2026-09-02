import type { AgentBackend, AgentTurnInspection } from './contracts.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../durable/sqlite-repositories.js'
import {
  SqliteSessionRepository,
  type ActiveTurnRecoveryCandidate,
} from '../durable/session-repository.js'
import type { TaskWorkspaceController } from './durable-task-workspaces.js'

export interface TurnRecoverySweep {
  candidates: number
  completed: number
  failed: number
  interrupted: number
  unknown: number
  resumed: number
  unblocked: number
}

export interface StartupTurnRecoveryOptions {
  now?: () => number
  backendName?: string
  taskWorkspaces?: Pick<
    TaskWorkspaceController,
    'isCancellationRequested' | 'complete' | 'abort'
  >
}

function safeTurnLabel(candidate: ActiveTurnRecoveryCandidate, backendTurnId: string | null): string {
  return backendTurnId ?? candidate.turn.backendTurnId ?? candidate.turn.id
}

function recoveryNotice(
  candidate: ActiveTurnRecoveryCandidate,
  inspection: Exclude<AgentTurnInspection, { state: 'COMPLETED' }>,
): string {
  const turn = safeTurnLabel(candidate, inspection.turnId)
  if (inspection.state === 'FAILED') {
    return [
      `⚠️ Turn ${turn} завершился ошибкой во время перезапуска.`,
      'Автовосстановление невозможно без исходного Telegram update. Напиши «продолжай».',
    ].join('\n')
  }
  if (inspection.state === 'INTERRUPTED') {
    return [
      `⏹ Turn ${turn} был прерван во время перезапуска.`,
      'Автовосстановление невозможно без исходного Telegram update. Напиши «продолжай».',
    ].join('\n')
  }
  return [
    `⚠️ После перезапуска состояние turn ${turn} нельзя доказать.`,
    'Автоповтор заблокирован, чтобы не выполнить задачу дважды.',
    'Чтобы явно отбросить этот turn и создать новый thread: /new force',
  ].join('\n')
}

function autoResumeNotice(
  candidate: ActiveTurnRecoveryCandidate,
  inspection: Extract<AgentTurnInspection, { state: 'FAILED' | 'INTERRUPTED' }>,
  attemptNumber: number,
): string {
  const turn = safeTurnLabel(candidate, inspection.turnId)
  const outcome = inspection.state === 'INTERRUPTED' ? 'прерван' : 'завершился ошибкой'
  return [
    `↻ Turn ${turn} ${outcome} во время перезапуска.`,
    `Автовосстановление #${attemptNumber}: продолжаю тот же Codex thread. Писать «продолжай» не нужно.`,
  ].join('\n')
}

function workspaceRecoveryNotice(): string {
  return [
    '⚠️ После перезапуска не удалось безопасно завершить локальные изменения задачи.',
    'Повтор не выполнялся. Изменения изолированы; повтори запрос новым сообщением.',
  ].join('\n')
}

/**
 * Reconciles turns left ACTIVE by a previous bridge process. Proven terminal
 * failures are requeued in the same logical operation/thread. An uncertain
 * result is never converted into a new turn because that could duplicate work.
 */
export class StartupTurnRecovery {
  private readonly now: () => number
  private readonly backendName: string
  private readonly taskWorkspaces: StartupTurnRecoveryOptions['taskWorkspaces']

  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly inbox: SqliteInboxRepository,
    private readonly outbox: SqliteOutboxRepository,
    private readonly backend: AgentBackend,
    options: StartupTurnRecoveryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.backendName = options.backendName ?? 'codex'
    this.taskWorkspaces = options.taskWorkspaces
  }

  async run(): Promise<TurnRecoverySweep> {
    const candidates = this.sessions.listActiveTurnsForRecovery(this.backendName)
    const sweep: TurnRecoverySweep = {
      candidates: candidates.length,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
      resumed: 0,
      unblocked: 0,
    }
    for (const candidate of candidates) {
      if (this.taskWorkspaces?.isCancellationRequested(candidate.turn.operationKey) === true) {
        const nowMs = this.now()
        if (candidate.binding !== null && candidate.turn.backendTurnId !== null) {
          await this.backend.interruptTurn(
            candidate.binding.threadId,
            candidate.turn.backendTurnId,
          ).catch(() => undefined)
        }
        await this.taskWorkspaces.abort(candidate.turn.operationKey, 'INTERRUPTED')
        this.sessions.markRecoveredTerminal(
          candidate.turn.id,
          'INTERRUPTED',
          'OperatorCancelledTurn',
          nowMs,
          candidate.turn.backendTurnId,
        )
        if (candidate.turn.sourceUpdateId !== null) {
          this.inbox.quarantineForTurnRecovery(
            candidate.turn.sourceUpdateId,
            'OperatorCancelledTurn',
            nowMs,
          )
        }
        sweep.interrupted += 1
        continue
      }
      const inspection = await this.inspect(candidate)
      const nowMs = this.now()
      if (inspection.state === 'COMPLETED') {
        try {
          const completion = await this.taskWorkspaces?.complete(candidate.turn.operationKey)
          if (completion?.cancelled === true) {
            this.sessions.markRecoveredTerminal(
              candidate.turn.id,
              'INTERRUPTED',
              'OperatorCancelledTurn',
              nowMs,
              inspection.result.turnId,
            )
            if (candidate.turn.sourceUpdateId !== null) {
              this.inbox.quarantineForTurnRecovery(
                candidate.turn.sourceUpdateId,
                'OperatorCancelledTurn',
                nowMs,
              )
            }
            sweep.interrupted += 1
            continue
          }
        } catch {
          const errorName = 'TaskWorkspaceRecoveryFailed'
          this.sessions.markRecoveredTerminal(
            candidate.turn.id,
            'UNKNOWN',
            errorName,
            nowMs,
            inspection.result.turnId,
          )
          if (candidate.turn.sourceUpdateId !== null) {
            this.inbox.quarantineForTurnRecovery(candidate.turn.sourceUpdateId, errorName, nowMs)
          }
          this.outbox.enqueue({
            sourceKey: `turn:${candidate.turn.id}:workspace-recovery`,
            sessionId: candidate.session.id,
            kind: 'send_text',
            payload: {
              chatId: candidate.session.chatId,
              text: workspaceRecoveryNotice(),
            },
            createdAtMs: nowMs,
          })
          sweep.unknown += 1
          continue
        }
        if (candidate.binding !== null) {
          this.sessions.activateRecoveredBinding(
            candidate.session.id,
            this.backendName,
            candidate.binding.threadId,
            nowMs,
          )
        }
        this.sessions.completeRecoveredTurn(candidate.turn.id, inspection.result, nowMs)
        if (candidate.turn.sourceUpdateId !== null) {
          this.inbox.releaseForTurnRecovery(candidate.turn.sourceUpdateId, nowMs)
        }
        sweep.completed += 1
        continue
      }

      const errorName = inspection.state === 'UNKNOWN'
        ? `CodexTurnRecoveryUnknown:${inspection.reason}`
        : `CodexTurnRecovery${inspection.state}`
      if (inspection.state === 'FAILED' || inspection.state === 'INTERRUPTED') {
        try {
          await this.taskWorkspaces?.abort(candidate.turn.operationKey, inspection.state)
        } catch {
          const workspaceErrorName = 'TaskWorkspaceRecoveryFailed'
          this.sessions.markRecoveredTerminal(
            candidate.turn.id,
            'UNKNOWN',
            workspaceErrorName,
            nowMs,
            inspection.turnId,
          )
          if (candidate.turn.sourceUpdateId !== null) {
            this.inbox.quarantineForTurnRecovery(
              candidate.turn.sourceUpdateId,
              workspaceErrorName,
              nowMs,
            )
          }
          this.outbox.enqueue({
            sourceKey: `turn:${candidate.turn.id}:workspace-recovery`,
            sessionId: candidate.session.id,
            kind: 'send_text',
            payload: { chatId: candidate.session.chatId, text: workspaceRecoveryNotice() },
            createdAtMs: nowMs,
          })
          sweep.unknown += 1
          continue
        }
      }
      if (
        (inspection.state === 'FAILED' || inspection.state === 'INTERRUPTED') &&
        candidate.turn.sourceUpdateId !== null &&
        this.isReplayableSource(candidate.turn.sourceUpdateId)
      ) {
        if (candidate.binding !== null) {
          this.sessions.activateRecoveredBinding(
            candidate.session.id,
            this.backendName,
            candidate.binding.threadId,
            nowMs,
          )
        }
        const recovery = this.sessions.requeueRecoveredTurn(
          candidate.turn.id,
          candidate.turn.sourceUpdateId,
          inspection.state,
          errorName,
          nowMs,
          inspection.turnId,
        )
        this.outbox.enqueue({
          sourceKey: `turn:${candidate.turn.id}:auto-resume:${recovery.attempt.attemptNumber}`,
          sessionId: candidate.session.id,
          kind: 'send_text',
          payload: {
            chatId: candidate.session.chatId,
            text: autoResumeNotice(candidate, inspection, recovery.attempt.attemptNumber),
          },
          createdAtMs: nowMs,
        })
        sweep[inspection.state === 'FAILED' ? 'failed' : 'interrupted'] += 1
        sweep.resumed += 1
        continue
      }
      this.sessions.markRecoveredTerminal(
        candidate.turn.id,
        inspection.state,
        errorName,
        nowMs,
        inspection.turnId,
      )
      if (candidate.turn.sourceUpdateId !== null) {
        this.inbox.quarantineForTurnRecovery(
          candidate.turn.sourceUpdateId,
          errorName,
          nowMs,
        )
      }
      this.outbox.enqueue({
        sourceKey: `turn:${candidate.turn.id}:startup-recovery`,
        sessionId: candidate.session.id,
        kind: 'send_text',
        payload: {
          chatId: candidate.session.chatId,
          text: recoveryNotice(candidate, inspection),
        },
        createdAtMs: nowMs,
      })
      sweep[inspection.state === 'FAILED'
        ? 'failed'
        : inspection.state === 'INTERRUPTED'
          ? 'interrupted'
          : 'unknown'] += 1
    }
    sweep.unblocked =
      this.inbox.releaseTurnRecoveryBlocked(this.now()) +
      this.inbox.releaseStrandedQueuedSources(this.now())
    return sweep
  }

  private async inspect(candidate: ActiveTurnRecoveryCandidate): Promise<AgentTurnInspection> {
    if (candidate.binding === null || this.backend.inspectTurn === undefined) {
      return {
        state: 'UNKNOWN',
        turnId: candidate.turn.backendTurnId,
        reason: 'turn_not_found',
      }
    }
    try {
      return await this.backend.inspectTurn({
        threadId: candidate.binding.threadId,
        turnId: candidate.turn.backendTurnId,
        operationKey: candidate.turn.backendOperationKey,
      })
    } catch {
      // App Server error text may contain paths or provider details and is not
      // persisted or forwarded to Telegram.
      return {
        state: 'UNKNOWN',
        turnId: candidate.turn.backendTurnId,
        reason: 'inspection_failed',
      }
    }
  }

  private isReplayableSource(sourceUpdateId: number): boolean {
    const source = this.inbox.get(sourceUpdateId)
    return source !== null && source.state !== 'PROCESSED'
  }
}
