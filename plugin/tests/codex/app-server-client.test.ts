import { describe, expect, test } from 'bun:test'

import {
  AppServerClosedError,
  AppServerProtocolError,
  AppServerRequestTimeoutError,
  AppServerRpcError,
  CodexAppServerClient,
} from '../../src/codex/app-server-client.js'
import type {
  AppServerTransport,
  TransportClose,
} from '../../src/codex/transport.js'
import type { OutboundMessage } from '../../src/codex/protocol.js'

class FakeTransport implements AppServerTransport {
  readonly sent: OutboundMessage[] = []
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(close: TransportClose) => void>()
  closed = false
  failNextSend: Error | undefined

  async send(message: OutboundMessage): Promise<void> {
    if (this.failNextSend !== undefined) {
      const error = this.failNextSend
      this.failNextSend = undefined
      throw error
    }
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (close: TransportClose) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message)
  }

  emitClose(close: TransportClose = { code: 0, signal: null }): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(close)
  }

  async close(): Promise<void> {
    this.emitClose()
  }
}

const CLIENT_INFO = {
  name: 'dashi_codex_bridge',
  title: 'Dashi Codex Bridge',
  version: '0.1.0',
}

async function initialize(
  transport: FakeTransport,
  options: ConstructorParameters<typeof CodexAppServerClient>[1] = {},
): Promise<CodexAppServerClient> {
  const client = new CodexAppServerClient(transport, options)
  const promise = client.initialize({ clientInfo: CLIENT_INFO, capabilities: null })
  await Promise.resolve()
  const request = transport.sent[0]
  if (request === undefined || !('id' in request)) throw new Error('initialize not sent')
  transport.emit({
    id: request.id,
    result: {
      userAgent: 'codex-cli/test',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  })
  await promise
  return client
}

describe('CodexAppServerClient handshake', () => {
  test('sends initialize, waits for its response, then sends initialized', async () => {
    const transport = new FakeTransport()
    const client = new CodexAppServerClient(transport)

    const promise = client.initialize({ clientInfo: CLIENT_INFO, capabilities: null })
    await Promise.resolve()

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: { clientInfo: CLIENT_INFO, capabilities: null },
      },
    ])
    expect(client.ready).toBe(false)

    transport.emit({
      id: 1,
      result: {
        userAgent: 'codex-cli/0.149.1',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })

    expect(await promise).toEqual({
      userAgent: 'codex-cli/0.149.1',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    })
    expect(transport.sent[1]).toEqual({ method: 'initialized' })
    expect(client.ready).toBe(true)
  })

  test('rejects requests before initialize and duplicate initialize', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)

    await expect(client.initialize({ clientInfo: CLIENT_INFO, capabilities: null })).rejects.toBeInstanceOf(
      AppServerProtocolError,
    )

    const fresh = new CodexAppServerClient(new FakeTransport())
    await expect(fresh.request('model/list', {})).rejects.toBeInstanceOf(
      AppServerProtocolError,
    )
  })

  test('closes the connection when initialize fails', async () => {
    const transport = new FakeTransport()
    const client = new CodexAppServerClient(transport)
    const promise = client.initialize({ clientInfo: CLIENT_INFO, capabilities: null })
    await Promise.resolve()
    transport.emit({ id: 1, error: { code: -32602, message: 'bad client info' } })

    await expect(promise).rejects.toBeInstanceOf(AppServerRpcError)
    expect(client.closed).toBe(true)
    await expect(
      client.initialize({ clientInfo: CLIENT_INFO, capabilities: null }),
    ).rejects.toBeInstanceOf(AppServerProtocolError)
  })
})

describe('CodexAppServerClient requests', () => {
  test('correlates concurrent responses even when they arrive out of order', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)

    const first = client.request<{ value: string }>('test/first', { n: 1 })
    const second = client.request<{ value: string }>('test/second', { n: 2 })
    await Promise.resolve()

    expect(transport.sent.slice(-2)).toEqual([
      { id: 2, method: 'test/first', params: { n: 1 } },
      { id: 3, method: 'test/second', params: { n: 2 } },
    ])
    transport.emit({ id: 3, result: { value: 'second' } })
    transport.emit({ id: 2, result: { value: 'first' } })

    expect(await first).toEqual({ value: 'first' })
    expect(await second).toEqual({ value: 'second' })
  })

  test('surfaces structured RPC errors', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)
    const promise = client.request('thread/start', {})
    await Promise.resolve()
    transport.emit({ id: 2, error: { code: -32602, message: 'bad params', data: { x: 1 } } })

    try {
      await promise
      throw new Error('request should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerRpcError)
      expect((error as AppServerRpcError).code).toBe(-32602)
      expect((error as AppServerRpcError).method).toBe('thread/start')
      expect((error as AppServerRpcError).data).toEqual({ x: 1 })
    }
  })

  test('times out a request and reports a late response as a protocol issue', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport, { requestTimeoutMs: 5 })
    const issues: string[] = []
    client.onProtocolIssue((error) => issues.push(error.message))

    const promise = client.request('slow/method', {})
    await expect(promise).rejects.toBeInstanceOf(AppServerRequestTimeoutError)
    transport.emit({ id: 2, result: {} })

    expect(issues).toEqual(['received a response for unknown request id 2'])
  })

  test('rejects pending requests when the process closes', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)
    const promise = client.request('thread/start', {})
    await Promise.resolve()

    transport.emitClose({ code: 7, signal: null })

    await expect(promise).rejects.toBeInstanceOf(AppServerClosedError)
    expect(client.closed).toBe(true)
  })

  test('cleans up a request when transport.send fails', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)
    transport.failNextSend = new Error('broken pipe')

    await expect(client.request('thread/start', {})).rejects.toThrow('broken pipe')

    const next = client.request('thread/start', {})
    await Promise.resolve()
    transport.emit({ id: 3, result: { thread: { id: 'thr_ok' } } })
    expect(await next).toEqual({ thread: { id: 'thr_ok' } })
  })
})

describe('CodexAppServerClient events', () => {
  test('dispatches notifications and server-initiated requests separately', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)
    const notifications: string[] = []
    const requests: string[] = []
    client.onNotification((event) => {
      notifications.push(event.method)
    })
    client.onServerRequest((request) => {
      requests.push(request.method)
    })

    transport.emit({ method: 'turn/started', params: { turn: { id: 'turn_1' } } })
    transport.emit({
      id: 'approval_1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'make test' },
    })
    await client.respond('approval_1', { decision: 'decline' })

    expect(notifications).toEqual(['turn/started'])
    expect(requests).toEqual(['item/commandExecution/requestApproval'])
    expect(transport.sent.at(-1)).toEqual({
      id: 'approval_1',
      result: { decision: 'decline' },
    })
  })

  test('isolates listener failures from protocol processing', async () => {
    const transport = new FakeTransport()
    const listenerErrors: string[] = []
    const client = await initialize(transport, {
      onListenerError: (error) => listenerErrors.push(String(error)),
    })
    client.onNotification(() => {
      throw new Error('bad listener')
    })

    transport.emit({ method: 'turn/started', params: {} })
    const request = client.request('model/list', {})
    await Promise.resolve()
    transport.emit({ id: 2, result: { data: [], nextCursor: null } })

    expect(await request).toEqual({ data: [], nextCursor: null })
    expect(listenerErrors[0]).toContain('bad listener')
  })

  test('reports malformed envelopes without killing the connection', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)
    const issues: string[] = []
    client.onProtocolIssue((error) => issues.push(error.message))

    transport.emit(null)
    transport.emit({ hello: 'world' })
    transport.emit({ method: 'approval', id: { bad: true } })

    expect(issues).toEqual([
      'received a non-object App Server message',
      'response has no valid id or method',
      'server request has an invalid id',
    ])
    expect(client.ready).toBe(true)
  })
})

describe('CodexAppServerClient typed operations', () => {
  test('uses current thread/turn method names and text input shape', async () => {
    const transport = new FakeTransport()
    const client = await initialize(transport)

    const start = client.startThread({ cwd: '/workspace/project' })
    await Promise.resolve()
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: 'thread/start',
      params: { cwd: '/workspace/project' },
    })
    transport.emit({ id: 2, result: { thread: { id: 'thr_1' } } })
    await start

    const turn = client.startTurn({
      threadId: 'thr_1',
      input: [{ type: 'text', text: 'Run tests', text_elements: [] }],
    })
    await Promise.resolve()
    expect(transport.sent.at(-1)).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_1',
        input: [{ type: 'text', text: 'Run tests', text_elements: [] }],
      },
    })
    transport.emit({ id: 3, result: { turn: { id: 'turn_1' } } })
    await turn

    const interrupt = client.interruptTurn({ threadId: 'thr_1', turnId: 'turn_1' })
    await Promise.resolve()
    expect(transport.sent.at(-1)).toEqual({
      id: 4,
      method: 'turn/interrupt',
      params: { threadId: 'thr_1', turnId: 'turn_1' },
    })
    transport.emit({ id: 4, result: {} })
    await interrupt
  })
})
