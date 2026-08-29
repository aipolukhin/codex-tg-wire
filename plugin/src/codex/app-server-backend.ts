import type {
  AgentBackend,
  AgentTextTurnInput,
  TextTurnResult,
} from '../bridge/contracts.js'
import { AppServerClosedError, type CodexAppServerClient } from './app-server-client.js'
import { textInput } from './protocol.js'
import type {
  ServerNotification,
  ThreadResumeParams,
  ThreadResult,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
} from './protocol.js'
import type { TransportClose } from './transport.js'

interface CodexBackendClient {
  startThread(params: ThreadStartParams): Promise<ThreadResult>
  resumeThread(params: ThreadResumeParams): Promise<ThreadResult>
  startTurn(params: TurnStartParams): Promise<TurnStartResult>
  interruptTurn(params: TurnInterruptParams): Promise<void>
  onNotification(listener: (notification: ServerNotification) => void): () => void
  onClose(listener: (close: TransportClose) => void): () => void
}

interface AgentMessage {
  id: string
  text: string
  phase: 'commentary' | 'final_answer' | null
}

interface TerminalTurn {
  id: string
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  errorMessage: string | null
  messages: AgentMessage[]
}

interface PendingTurn {
  threadId: string
  turnId: string | null
  messages: Map<string, AgentMessage>
  resolve: (turn: TerminalTurn) => void
  reject: (error: Error) => void
  promise: Promise<TerminalTurn>
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface CodexAppServerBackendOptions {
  turnTimeoutMs?: number
  threadStartDefaults?: Omit<ThreadStartParams, 'cwd'>
  threadResumeDefaults?: Omit<ThreadResumeParams, 'threadId' | 'cwd'>
  turnDefaults?: Omit<
    TurnStartParams,
    'threadId' | 'clientUserMessageId' | 'input' | 'cwd'
  >
}

export class CodexTurnBusyError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} already has a turn managed by this backend`)
    this.name = 'CodexTurnBusyError'
  }
}

export class CodexTurnFailedError extends Error {
  constructor(turnId: string, detail: string | null) {
    super(`Codex turn ${turnId} failed${detail === null ? '' : `: ${detail}`}`)
    this.name = 'CodexTurnFailedError'
  }
}

export class CodexTurnInterruptedError extends Error {
  constructor(turnId: string) {
    super(`Codex turn ${turnId} was interrupted`)
    this.name = 'CodexTurnInterruptedError'
  }
}

export class CodexTurnProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexTurnProtocolError'
  }
}

export class CodexTurnTimeoutError extends Error {
  constructor(turnId: string | null, timeoutMs: number) {
    super(`Codex turn ${turnId ?? '<pending>'} timed out after ${timeoutMs}ms`)
    this.name = 'CodexTurnTimeoutError'
  }
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAgentMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value) || value.type !== 'agentMessage') return null
  if (typeof value.id !== 'string' || typeof value.text !== 'string') return null
  const phase = value.phase
  if (phase !== null && phase !== undefined && phase !== 'commentary' && phase !== 'final_answer') {
    return null
  }
  return { id: value.id, text: value.text, phase: phase ?? null }
}

function parseThreadTurn(params: unknown): { threadId: string; turnId: string } | null {
  if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.turn)) {
    return null
  }
  if (typeof params.turn.id !== 'string') return null
  return { threadId: params.threadId, turnId: params.turn.id }
}

function parseTerminalTurn(params: unknown): { threadId: string; turn: TerminalTurn } | null {
  if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.turn)) {
    return null
  }
  const raw = params.turn
  if (typeof raw.id !== 'string') return null
  if (
    raw.status !== 'completed' &&
    raw.status !== 'interrupted' &&
    raw.status !== 'failed' &&
    raw.status !== 'inProgress'
  ) {
    return null
  }
  const messages = Array.isArray(raw.items)
    ? raw.items.map(parseAgentMessage).filter((item): item is AgentMessage => item !== null)
    : []
  const errorMessage = isRecord(raw.error) && typeof raw.error.message === 'string'
    ? raw.error.message
    : null
  return {
    threadId: params.threadId,
    turn: { id: raw.id, status: raw.status, errorMessage, messages },
  }
}

function finalText(turn: TerminalTurn, streamed: Map<string, AgentMessage>): string {
  const messages = new Map(streamed)
  for (const message of turn.messages) messages.set(message.id, message)
  const all = [...messages.values()]
  const explicitFinal = all
    .filter((message) => message.phase === 'final_answer' && message.text.trim().length > 0)
    .map((message) => message.text)
  if (explicitFinal.length > 0) return explicitFinal.join('\n\n')

  const legacy = all.filter(
    (message) => message.phase === null && message.text.trim().length > 0,
  )
  return legacy.at(-1)?.text ?? ''
}

export class CodexAppServerBackend implements AgentBackend {
  private readonly client: CodexBackendClient
  private readonly turnTimeoutMs: number
  private readonly threadStartDefaults: Omit<ThreadStartParams, 'cwd'>
  private readonly threadResumeDefaults: Omit<ThreadResumeParams, 'threadId' | 'cwd'>
  private readonly turnDefaults: Omit<
    TurnStartParams,
    'threadId' | 'clientUserMessageId' | 'input' | 'cwd'
  >
  private readonly pendingByThread = new Map<string, PendingTurn>()
  private readonly unsubscribeNotification: () => void
  private readonly unsubscribeClose: () => void

  constructor(client: CodexAppServerClient | CodexBackendClient, options: CodexAppServerBackendOptions = {}) {
    this.client = client
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.threadStartDefaults = options.threadStartDefaults ?? {}
    this.threadResumeDefaults = options.threadResumeDefaults ?? {}
    this.turnDefaults = options.turnDefaults ?? {}
    this.unsubscribeNotification = client.onNotification((event) => this.handleNotification(event))
    this.unsubscribeClose = client.onClose((close) => this.handleClose(close))
  }

  async runTextTurn(input: AgentTextTurnInput): Promise<TextTurnResult> {
    const threadId = await this.ensureThread(input)
    if (this.pendingByThread.has(threadId)) throw new CodexTurnBusyError(threadId)

    const pending = this.createPending(threadId)
    this.pendingByThread.set(threadId, pending)
    try {
      const started = await this.client.startTurn({
        ...this.turnDefaults,
        threadId,
        clientUserMessageId: input.operationKey,
        input: [textInput(input.text)],
        cwd: input.cwd,
      })
      if (pending.turnId !== null && pending.turnId !== started.turn.id) {
        throw new CodexTurnProtocolError(
          `turn/start returned ${started.turn.id} after events for ${pending.turnId}`,
        )
      }
      pending.turnId = started.turn.id
      const terminal = await pending.promise
      if (terminal.id !== started.turn.id) {
        throw new CodexTurnProtocolError(
          `turn/completed returned ${terminal.id}, expected ${started.turn.id}`,
        )
      }
      if (terminal.status === 'interrupted') throw new CodexTurnInterruptedError(terminal.id)
      if (terminal.status === 'failed') {
        throw new CodexTurnFailedError(terminal.id, terminal.errorMessage)
      }
      if (terminal.status !== 'completed') {
        throw new CodexTurnProtocolError(
          `turn/completed carried non-terminal status ${terminal.status}`,
        )
      }
      const text = finalText(terminal, pending.messages)
      if (text.trim().length === 0) {
        throw new CodexTurnProtocolError(`Codex turn ${terminal.id} completed without a final message`)
      }
      return { threadId, turnId: terminal.id, finalText: text }
    } finally {
      this.clearPending(threadId, pending)
    }
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    return this.client.interruptTurn({ threadId, turnId })
  }

  close(): void {
    this.unsubscribeNotification()
    this.unsubscribeClose()
    const error = new CodexTurnProtocolError('Codex App Server backend closed')
    for (const pending of this.pendingByThread.values()) pending.reject(error)
    this.pendingByThread.clear()
  }

  private async ensureThread(input: AgentTextTurnInput): Promise<string> {
    if (input.threadId === null) {
      const started = await this.client.startThread({
        ...this.threadStartDefaults,
        cwd: input.cwd,
      })
      return started.thread.id
    }
    const resumed = await this.client.resumeThread({
      ...this.threadResumeDefaults,
      threadId: input.threadId,
      cwd: input.cwd,
    })
    if (resumed.thread.id !== input.threadId) {
      throw new CodexTurnProtocolError(
        `thread/resume returned ${resumed.thread.id}, expected ${input.threadId}`,
      )
    }
    return resumed.thread.id
  }

  private createPending(threadId: string): PendingTurn {
    let resolve!: (turn: TerminalTurn) => void
    let reject!: (error: Error) => void
    const promise = new Promise<TerminalTurn>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    void promise.catch(() => undefined)
    const pending: PendingTurn = {
      threadId,
      turnId: null,
      messages: new Map(),
      resolve,
      reject,
      promise,
      timer: undefined,
    }
    if (this.turnTimeoutMs > 0) {
      pending.timer = setTimeout(() => {
        pending.reject(new CodexTurnTimeoutError(pending.turnId, this.turnTimeoutMs))
      }, this.turnTimeoutMs)
    }
    return pending
  }

  private handleNotification(notification: ServerNotification): void {
    if (notification.method === 'turn/started') {
      const started = parseThreadTurn(notification.params)
      if (started === null) return
      const pending = this.pendingByThread.get(started.threadId)
      if (pending !== undefined && pending.turnId === null) pending.turnId = started.turnId
      return
    }

    if (notification.method === 'item/completed') {
      if (!isRecord(notification.params)) return
      const params = notification.params
      if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string') return
      const pending = this.pendingByThread.get(params.threadId)
      if (pending === undefined) return
      if (pending.turnId !== null && pending.turnId !== params.turnId) return
      const message = parseAgentMessage(params.item)
      if (message !== null) pending.messages.set(message.id, message)
      return
    }

    if (notification.method !== 'turn/completed') return
    const completed = parseTerminalTurn(notification.params)
    if (completed === null) return
    const pending = this.pendingByThread.get(completed.threadId)
    if (pending === undefined) return
    if (pending.turnId !== null && pending.turnId !== completed.turn.id) return
    if (pending.turnId === null) pending.turnId = completed.turn.id
    pending.resolve(completed.turn)
  }

  private handleClose(close: TransportClose): void {
    const error = new AppServerClosedError(close)
    for (const pending of this.pendingByThread.values()) pending.reject(error)
  }

  private clearPending(threadId: string, pending: PendingTurn): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (this.pendingByThread.get(threadId) === pending) this.pendingByThread.delete(threadId)
  }
}
