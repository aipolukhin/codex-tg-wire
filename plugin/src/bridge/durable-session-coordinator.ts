import type {
  AgentBackend,
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import {
  SqliteSessionRepository,
  type PreparedTextOperation,
  type TurnRecord,
} from '../durable/session-repository.js'
import { safeErrorSummary } from './retry-policy.js'

export interface ProjectDefinition {
  id: string
  cwd: string
}

export interface ProjectResolver {
  resolve(projectId: string): ProjectDefinition | null
}

export class StaticProjectResolver implements ProjectResolver {
  private readonly projects: Map<string, ProjectDefinition>

  constructor(projects: readonly ProjectDefinition[]) {
    this.projects = new Map(projects.map((project) => [project.id, project]))
  }

  resolve(projectId: string): ProjectDefinition | null {
    return this.projects.get(projectId) ?? null
  }
}

export class UnknownProjectError extends Error {
  constructor(projectId: string) {
    super(`unknown project: ${projectId}`)
    this.name = 'UnknownProjectError'
  }
}

export class TurnRecoveryRequiredError extends Error {
  readonly localTurnId: string
  readonly state: TurnRecord['state']

  constructor(turn: TurnRecord) {
    super(`turn ${turn.id} for operation ${turn.operationKey} requires recovery (${turn.state})`)
    this.name = 'TurnRecoveryRequiredError'
    this.localTurnId = turn.id
    this.state = turn.state
  }
}

export class AgentLifecycleProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentLifecycleProtocolError'
  }
}

interface DefiniteTurnError extends Error {
  agentTurnState: 'FAILED' | 'INTERRUPTED'
  turnId: string
}

function isDefiniteTurnError(error: unknown): error is DefiniteTurnError {
  if (!(error instanceof Error)) return false
  const value = error as Partial<DefiniteTurnError>
  return (
    (value.agentTurnState === 'FAILED' || value.agentTurnState === 'INTERRUPTED') &&
    typeof value.turnId === 'string'
  )
}

function cachedResult(turn: TurnRecord): TextTurnResult {
  const value = turn.finalResponse
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { threadId?: unknown }).threadId !== 'string' ||
    typeof (value as { turnId?: unknown }).turnId !== 'string' ||
    typeof (value as { finalText?: unknown }).finalText !== 'string'
  ) {
    throw new TurnRecoveryRequiredError(turn)
  }
  return value as TextTurnResult
}

export interface DurableSessionCoordinatorOptions {
  now?: () => number
  backendName?: string
}

export class DurableSessionCoordinator implements SessionCoordinator {
  private readonly active = new Map<string, Promise<TextTurnResult>>()
  private readonly now: () => number
  private readonly backendName: string

  constructor(
    private readonly sessions: SqliteSessionRepository,
    private readonly backend: AgentBackend,
    private readonly projects: ProjectResolver,
    options: DurableSessionCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.backendName = options.backendName ?? 'codex'
  }

  runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    const running = this.active.get(operation.operationKey)
    if (running !== undefined) return running

    const promise = this.execute(operation)
    this.active.set(operation.operationKey, promise)
    void promise.finally(() => {
      if (this.active.get(operation.operationKey) === promise) {
        this.active.delete(operation.operationKey)
      }
    }).catch(() => undefined)
    return promise
  }

  private async execute(operation: TextTurnOperation): Promise<TextTurnResult> {
    const project = this.projects.resolve(operation.projectId)
    if (project === null) throw new UnknownProjectError(operation.projectId)
    const prepared = this.sessions.prepareTextOperation(operation, this.backendName, this.now())
    if (!prepared.created) {
      if (prepared.turn.state === 'COMPLETED') return cachedResult(prepared.turn)
      if (prepared.turn.state !== 'QUEUED') throw new TurnRecoveryRequiredError(prepared.turn)
    }
    if (prepared.binding !== null && prepared.binding.state !== 'ACTIVE') {
      throw new TurnRecoveryRequiredError(prepared.turn)
    }
    return this.dispatch(prepared, operation, project.cwd)
  }

  private async dispatch(
    prepared: PreparedTextOperation,
    operation: TextTurnOperation,
    cwd: string,
  ): Promise<TextTurnResult> {
    let dispatching = false
    let readyThreadId: string | null = null
    let startedTurnId: string | null = null
    try {
      const result = await this.backend.runTextTurn(
        {
          operationKey: operation.operationKey,
          threadId: prepared.binding?.threadId ?? null,
          projectId: operation.projectId,
          cwd,
          text: operation.text,
        },
        {
          onThreadReady: (threadId, created) => {
            this.sessions.markDispatching(
              prepared.turn.id,
              this.backendName,
              threadId,
              created,
              this.now(),
            )
            dispatching = true
            readyThreadId = threadId
          },
          onTurnStarted: (threadId, turnId) => {
            this.sessions.markBackendTurnStarted(
              prepared.turn.id,
              turnId,
              this.backendName,
              threadId,
              this.now(),
            )
            startedTurnId = turnId
          },
        },
      )
      if (readyThreadId === null || startedTurnId === null) {
        throw new AgentLifecycleProtocolError('agent backend returned without complete lifecycle callbacks')
      }
      if (result.threadId !== readyThreadId || result.turnId !== startedTurnId) {
        throw new AgentLifecycleProtocolError(
          `agent result ${result.threadId}/${result.turnId} does not match lifecycle ${readyThreadId}/${startedTurnId}`,
        )
      }
      this.sessions.completeTurn(prepared.turn.id, result, this.now())
      return result
    } catch (error) {
      if (dispatching) {
        const state = isDefiniteTurnError(error) ? error.agentTurnState : 'UNKNOWN'
        this.sessions.markTerminal(prepared.turn.id, state, safeErrorSummary(error), this.now())
      }
      throw error
    }
  }
}
