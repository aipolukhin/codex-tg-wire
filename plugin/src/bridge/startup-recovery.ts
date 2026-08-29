import type { AgentBackend, AgentTurnInspection } from './contracts.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../durable/sqlite-repositories.js'
import {
  SqliteSessionRepository,
  type ActiveTurnRecoveryCandidate,
} from '../durable/session-repository.js'

export interface TurnRecoverySweep {
  candidates: number
  completed: number
  failed: number
  interrupted: number
  unknown: number
}

export interface StartupTurnRecoveryOptions {
  now?: () => number
  backendName?: string
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
    return `⚠️ Turn ${turn} завершился ошибкой во время перезапуска. Автоповтор не выполнялся.`
  }
  if (inspection.state === 'INTERRUPTED') {
    return `⏹ Turn ${turn} был прерван во время перезапуска. Автоповтор не выполнялся.`
  }
  return [
    `⚠️ После перезапуска состояние turn ${turn} нельзя доказать.`,
    'Автоповтор заблокирован, чтобы не выполнить задачу дважды.',
    'Чтобы явно отбросить этот turn и создать новый thread: /new force',
  ].join('\n')
}

/**
 * Reconciles turns left ACTIVE by a previous bridge process. Inspection is
 * read-only; an uncertain result is never converted into a new turn.
 */
export class StartupTurnRecovery {
  private readonly now: () => number
  private readonly backendName: string

  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly inbox: SqliteInboxRepository,
    private readonly outbox: SqliteOutboxRepository,
    private readonly backend: AgentBackend,
    options: StartupTurnRecoveryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.backendName = options.backendName ?? 'codex'
  }

  async run(): Promise<TurnRecoverySweep> {
    const candidates = this.sessions.listActiveTurnsForRecovery(this.backendName)
    const sweep: TurnRecoverySweep = {
      candidates: candidates.length,
      completed: 0,
      failed: 0,
      interrupted: 0,
      unknown: 0,
    }
    for (const candidate of candidates) {
      const inspection = await this.inspect(candidate)
      const nowMs = this.now()
      if (inspection.state === 'COMPLETED') {
        this.sessions.completeTurn(candidate.turn.id, inspection.result, nowMs)
        if (candidate.turn.sourceUpdateId !== null) {
          this.inbox.releaseForTurnRecovery(candidate.turn.sourceUpdateId, nowMs)
        }
        sweep.completed += 1
        continue
      }

      const errorName = inspection.state === 'UNKNOWN'
        ? `CodexTurnRecoveryUnknown:${inspection.reason}`
        : `CodexTurnRecovery${inspection.state}`
      this.sessions.markTerminal(
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
        operationKey: candidate.turn.operationKey,
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
}
