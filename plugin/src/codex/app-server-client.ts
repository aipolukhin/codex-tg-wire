import {
  AppServerTransportError,
  StdioAppServerTransport,
  type AppServerTransport,
  type StdioTransportOptions,
  type TransportClose,
} from './transport.js'
import type {
  InitializeParams,
  InitializeResult,
  ModelListParams,
  ModelListResult,
  OutboundMessage,
  RequestId,
  RpcErrorBody,
  ServerNotification,
  ServerRequest,
  ThreadResult,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
  TurnSteerParams,
  TurnSteerResult,
} from './protocol.js'

type ClientState = 'new' | 'initializing' | 'ready' | 'closed'

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface AppServerClientOptions {
  requestTimeoutMs?: number
  onListenerError?: (error: unknown) => void
  firstRequestId?: number
}

export interface SpawnedAppServerClientOptions
  extends AppServerClientOptions,
    StdioTransportOptions {}

export class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerProtocolError'
  }
}

export class AppServerRpcError extends Error {
  readonly code: number
  readonly data: unknown
  readonly method: string
  readonly requestId: RequestId

  constructor(method: string, requestId: RequestId, body: RpcErrorBody) {
    super(`Codex App Server ${method} failed (${body.code}): ${body.message}`)
    this.name = 'AppServerRpcError'
    this.code = body.code
    this.data = body.data
    this.method = method
    this.requestId = requestId
  }
}

export class AppServerRequestTimeoutError extends Error {
  readonly method: string
  readonly requestId: RequestId

  constructor(method: string, requestId: RequestId, timeoutMs: number) {
    super(`Codex App Server ${method} timed out after ${timeoutMs}ms`)
    this.name = 'AppServerRequestTimeoutError'
    this.method = method
    this.requestId = requestId
  }
}

export class AppServerClosedError extends Error {
  readonly close: TransportClose

  constructor(close: TransportClose) {
    const detail =
      close.error?.message ??
      `process exited with code ${String(close.code)} signal ${String(close.signal)}`
    super(`Codex App Server connection closed: ${detail}`, {
      ...(close.error !== undefined ? { cause: close.error } : {}),
    })
    this.name = 'AppServerClosedError'
    this.close = close
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number'
}

function parseRpcError(value: unknown): RpcErrorBody | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.code !== 'number' || typeof value.message !== 'string') return undefined
  return {
    code: value.code,
    message: value.message,
    ...('data' in value ? { data: value.data } : {}),
  }
}

export class CodexAppServerClient {
  private readonly transport: AppServerTransport
  private readonly requestTimeoutMs: number
  private readonly onListenerError: (error: unknown) => void
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationListeners = new Set<
    (notification: ServerNotification) => void | Promise<void>
  >()
  private readonly serverRequestListeners = new Set<
    (request: ServerRequest) => void | Promise<void>
  >()
  private readonly protocolIssueListeners = new Set<
    (error: AppServerProtocolError) => void
  >()
  private nextRequestId: number
  private state: ClientState = 'new'
  private readonly unsubscribeMessage: () => void
  private readonly unsubscribeClose: () => void

  constructor(transport: AppServerTransport, options: AppServerClientOptions = {}) {
    this.transport = transport
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onListenerError = options.onListenerError ?? (() => undefined)
    this.nextRequestId = options.firstRequestId ?? 1
    this.unsubscribeMessage = transport.onMessage((message) => this.handleMessage(message))
    this.unsubscribeClose = transport.onClose((close) => this.handleClose(close))
  }

  static spawn(options: SpawnedAppServerClientOptions = {}): CodexAppServerClient {
    const transport = new StdioAppServerTransport(options)
    return new CodexAppServerClient(transport, options)
  }

  get ready(): boolean {
    return this.state === 'ready'
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.state !== 'new') {
      throw new AppServerProtocolError(
        `initialize is only valid for a new connection (current state: ${this.state})`,
      )
    }
    this.state = 'initializing'
    try {
      const result = await this.requestRaw<InitializeResult>('initialize', params)
      await this.transport.send({ method: 'initialized' })
      this.state = 'ready'
      return result
    } catch (error) {
      // The protocol allows one initialize per connection. Once that request
      // was written, retrying the handshake on the same transport can yield
      // `Already initialized`, so a failed handshake makes this client final.
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (this.state !== 'ready') {
      throw new AppServerProtocolError(
        `request ${method} requires an initialized connection (current state: ${this.state})`,
      )
    }
    return this.requestRaw<Result>(method, params)
  }

  startThread(params: ThreadStartParams = {}): Promise<ThreadResult> {
    return this.request<ThreadResult>('thread/start', params)
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResult> {
    return this.request<ThreadResult>('thread/resume', params)
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request<TurnStartResult>('turn/start', params)
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResult> {
    return this.request<TurnSteerResult>('turn/steer', params)
  }

  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    await this.request<Record<string, never>>('turn/interrupt', params)
  }

  listModels(params: ModelListParams = {}): Promise<ModelListResult> {
    return this.request<ModelListResult>('model/list', params)
  }

  async respond(requestId: RequestId, result: unknown): Promise<void> {
    this.assertWritable('respond')
    await this.transport.send({ id: requestId, result })
  }

  async respondError(requestId: RequestId, error: RpcErrorBody): Promise<void> {
    this.assertWritable('respondError')
    await this.transport.send({ id: requestId, error })
  }

  onNotification(
    listener: (notification: ServerNotification) => void | Promise<void>,
  ): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onServerRequest(listener: (request: ServerRequest) => void | Promise<void>): () => void {
    this.serverRequestListeners.add(listener)
    return () => this.serverRequestListeners.delete(listener)
  }

  onProtocolIssue(listener: (error: AppServerProtocolError) => void): () => void {
    this.protocolIssueListeners.add(listener)
    return () => this.protocolIssueListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    await this.transport.close()
    this.markClosedAfterTransportClose()
  }

  private requestRaw<Result>(method: string, params?: unknown): Promise<Result> {
    this.assertWritable(method)
    const id = this.nextRequestId++

    return new Promise<Result>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new AppServerRequestTimeoutError(method, id, this.requestTimeoutMs))
            }, this.requestTimeoutMs)
          : undefined

      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as Result),
        reject,
        timer,
      })

      const message: OutboundMessage = {
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }
      void this.transport.send(message).catch((error: unknown) => {
        const pending = this.takePending(id)
        pending?.reject(
          error instanceof Error
            ? error
            : new AppServerTransportError(`failed to send ${method}: ${String(error)}`),
        )
      })
    })
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.emitProtocolIssue('received a non-object App Server message')
      return
    }

    const method = message.method
    const id = message.id

    if (typeof method === 'string') {
      if (id === undefined) {
        this.dispatchNotification({
          method,
          ...('params' in message ? { params: message.params } : {}),
        })
        return
      }
      if (!isRequestId(id)) {
        this.emitProtocolIssue('server request has an invalid id')
        return
      }
      this.dispatchServerRequest({
        id,
        method,
        ...('params' in message ? { params: message.params } : {}),
      })
      return
    }

    if (!isRequestId(id)) {
      this.emitProtocolIssue('response has no valid id or method')
      return
    }

    const pending = this.takePending(id)
    if (pending === undefined) {
      this.emitProtocolIssue(`received a response for unknown request id ${String(id)}`)
      return
    }

    if ('error' in message) {
      const error = parseRpcError(message.error)
      if (error === undefined) {
        pending.reject(new AppServerProtocolError('response contains a malformed error'))
        return
      }
      pending.reject(new AppServerRpcError(pending.method, id, error))
      return
    }

    if (!('result' in message)) {
      pending.reject(new AppServerProtocolError('response has neither result nor error'))
      return
    }
    pending.resolve(message.result)
  }

  private handleClose(close: TransportClose): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.unsubscribeMessage()
    this.unsubscribeClose()
    const error = new AppServerClosedError(close)
    for (const id of [...this.pending.keys()]) {
      this.takePending(id)?.reject(error)
    }
  }

  private takePending(id: RequestId): PendingRequest | undefined {
    const pending = this.pending.get(id)
    if (pending === undefined) return undefined
    this.pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    return pending
  }

  private dispatchNotification(notification: ServerNotification): void {
    for (const listener of this.notificationListeners) {
      this.invokeListener(() => listener(notification))
    }
  }

  private dispatchServerRequest(request: ServerRequest): void {
    for (const listener of this.serverRequestListeners) {
      this.invokeListener(() => listener(request))
    }
  }

  private invokeListener(invoke: () => void | Promise<void>): void {
    try {
      const result = invoke()
      if (result instanceof Promise) void result.catch(this.onListenerError)
    } catch (error) {
      this.onListenerError(error)
    }
  }

  private emitProtocolIssue(message: string): void {
    const error = new AppServerProtocolError(message)
    for (const listener of this.protocolIssueListeners) {
      try {
        listener(error)
      } catch (listenerError) {
        this.onListenerError(listenerError)
      }
    }
  }

  private assertWritable(operation: string): void {
    if (this.state === 'closed' || this.transport.closed) {
      throw new AppServerProtocolError(`${operation} is invalid on a closed connection`)
    }
  }

  // TypeScript intentionally does not widen a narrowed property across await,
  // while transport callbacks can change this state during that await.
  // Keep the callback-aware read in a separate method.
  private markClosedAfterTransportClose(): void {
    if (this.state !== 'closed') this.handleClose({ code: null, signal: null })
  }
}
