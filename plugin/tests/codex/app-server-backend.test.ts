import { describe, expect, test } from 'bun:test'

import {
  AppServerClosedError,
} from '../../src/codex/app-server-client.js'
import {
  CodexAppServerBackend,
  CodexTurnBusyError,
  CodexTurnFailedError,
  CodexTurnInterruptedError,
  CodexTurnProtocolError,
  CodexTurnTimeoutError,
} from '../../src/codex/app-server-backend.js'
import type {
  ServerNotification,
  ThreadResumeParams,
  ThreadResult,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResult,
} from '../../src/codex/protocol.js'
import type { TransportClose } from '../../src/codex/transport.js'

class FakeBackendClient {
  readonly threadStarts: ThreadStartParams[] = []
  readonly threadResumes: ThreadResumeParams[] = []
  readonly turnStarts: TurnStartParams[] = []
  readonly interrupts: TurnInterruptParams[] = []
  readonly notificationListeners = new Set<(notification: ServerNotification) => void>()
  readonly closeListeners = new Set<(close: TransportClose) => void>()
  threadIds = ['thread-1']
  turnIds = new Map<string, string>([['thread-1', 'turn-1']])
  emitDuringTurnStart: (() => void) | undefined

  async startThread(params: ThreadStartParams): Promise<ThreadResult> {
    this.threadStarts.push(params)
    const id = this.threadIds.shift()
    if (id === undefined) throw new Error('no fake thread id configured')
    return { thread: { id } }
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadResult> {
    this.threadResumes.push(params)
    return { thread: { id: params.threadId } }
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    this.turnStarts.push(params)
    const id = this.turnIds.get(params.threadId)
    if (id === undefined) throw new Error(`no fake turn id for ${params.threadId}`)
    this.emitDuringTurnStart?.()
    return { turn: { id } }
  }

  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    this.interrupts.push(params)
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onClose(listener: (close: TransportClose) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  emit(notification: ServerNotification): void {
    for (const listener of this.notificationListeners) listener(notification)
  }

  emitClose(close: TransportClose): void {
    for (const listener of this.closeListeners) listener(close)
  }
}

function turnInput(threadId: string | null = null) {
  return {
    operationKey: 'telegram:primary:501:turn',
    threadId,
    projectId: 'workspace',
    cwd: '/workspace/project',
    text: 'проверь тесты',
  }
}

function emitCompleted(
  client: FakeBackendClient,
  threadId: string,
  turnId: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null = 'final_answer',
): void {
  client.emit({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `message-${turnId}`, text, phase },
    },
  })
  client.emit({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed', items: [] },
    },
  })
}

async function waitForTurnStart(client: FakeBackendClient, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 20 && client.turnStarts.length < count; attempt += 1) {
    await Promise.resolve()
  }
  if (client.turnStarts.length < count) throw new Error('turn/start was not called')
}

describe('CodexAppServerBackend text turns', () => {
  test('creates a thread, correlates terminal events and returns final_answer text', async () => {
    const client = new FakeBackendClient()
    const backend = new CodexAppServerBackend(client, {
      threadStartDefaults: { approvalPolicy: 'never' },
      turnDefaults: { model: 'gpt-test' },
    })

    const result = backend.runTextTurn(turnInput())
    await waitForTurnStart(client)
    expect(client.threadStarts).toEqual([{ approvalPolicy: 'never', cwd: '/workspace/project' }])
    expect(client.turnStarts).toEqual([
      {
        model: 'gpt-test',
        threadId: 'thread-1',
        clientUserMessageId: 'telegram:primary:501:turn',
        input: [{ type: 'text', text: 'проверь тесты', text_elements: [] }],
        cwd: '/workspace/project',
      },
    ])

    client.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    client.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'commentary', text: 'Работаю', phase: 'commentary' },
      },
    })
    emitCompleted(client, 'thread-1', 'turn-1', 'Все тесты зелёные')

    expect(await result).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      finalText: 'Все тесты зелёные',
    })
    backend.close()
  })

  test('resumes an existing thread and supports legacy phase-null messages', async () => {
    const client = new FakeBackendClient()
    client.turnIds.set('thread-existing', 'turn-2')
    const backend = new CodexAppServerBackend(client)

    const result = backend.runTextTurn(turnInput('thread-existing'))
    await waitForTurnStart(client)
    expect(client.threadResumes).toEqual([
      { threadId: 'thread-existing', cwd: '/workspace/project' },
    ])
    emitCompleted(client, 'thread-existing', 'turn-2', 'legacy final', null)
    expect((await result).finalText).toBe('legacy final')
    backend.close()
  })

  test('does not lose events emitted before turn/start response resolves', async () => {
    const client = new FakeBackendClient()
    client.emitDuringTurnStart = () => emitCompleted(client, 'thread-1', 'turn-1', 'fast answer')
    const backend = new CodexAppServerBackend(client)

    expect(await backend.runTextTurn(turnInput())).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      finalText: 'fast answer',
    })
    backend.close()
  })

  test('maps failed, interrupted and missing-final terminal states explicitly', async () => {
    const cases = [
      {
        status: 'failed',
        error: { message: 'sandbox denied' },
        expected: CodexTurnFailedError,
      },
      { status: 'interrupted', error: null, expected: CodexTurnInterruptedError },
      { status: 'completed', error: null, expected: CodexTurnProtocolError },
    ] as const

    for (const [index, item] of cases.entries()) {
      const client = new FakeBackendClient()
      client.threadIds = [`thread-${index}`]
      client.turnIds = new Map([[`thread-${index}`, `turn-${index}`]])
      const backend = new CodexAppServerBackend(client)
      const result = backend.runTextTurn(turnInput())
      await waitForTurnStart(client)
      client.emit({
        method: 'turn/completed',
        params: {
          threadId: `thread-${index}`,
          turn: {
            id: `turn-${index}`,
            status: item.status,
            error: item.error,
            items: [],
          },
        },
      })
      await expect(result).rejects.toBeInstanceOf(item.expected)
      backend.close()
    }
  })

  test('isolates concurrent threads and rejects a second active turn on one thread', async () => {
    const client = new FakeBackendClient()
    client.threadIds = ['thread-a', 'thread-b']
    client.turnIds = new Map([
      ['thread-a', 'turn-a'],
      ['thread-b', 'turn-b'],
      ['shared', 'turn-shared'],
    ])
    const backend = new CodexAppServerBackend(client)
    const first = backend.runTextTurn({ ...turnInput(), operationKey: 'op-a' })
    const second = backend.runTextTurn({ ...turnInput(), operationKey: 'op-b' })
    await waitForTurnStart(client, 2)
    emitCompleted(client, 'thread-b', 'turn-b', 'B')
    emitCompleted(client, 'thread-a', 'turn-a', 'A')
    expect((await first).finalText).toBe('A')
    expect((await second).finalText).toBe('B')

    const shared = backend.runTextTurn({ ...turnInput('shared'), operationKey: 'shared-1' })
    await waitForTurnStart(client, 3)
    await expect(
      backend.runTextTurn({ ...turnInput('shared'), operationKey: 'shared-2' }),
    ).rejects.toBeInstanceOf(CodexTurnBusyError)
    emitCompleted(client, 'shared', 'turn-shared', 'done')
    await shared
    backend.close()
  })

  test('forwards interrupt and rejects pending turns immediately when App Server closes', async () => {
    const client = new FakeBackendClient()
    const backend = new CodexAppServerBackend(client)
    await backend.interruptTurn('thread-1', 'turn-1')
    expect(client.interrupts).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }])

    const result = backend.runTextTurn(turnInput())
    await waitForTurnStart(client)
    client.emitClose({ code: 137, signal: null })
    await expect(result).rejects.toBeInstanceOf(AppServerClosedError)
    backend.close()
  })

  test('times out a turn that never emits a terminal event', async () => {
    const client = new FakeBackendClient()
    const backend = new CodexAppServerBackend(client, { turnTimeoutMs: 5 })
    await expect(backend.runTextTurn(turnInput())).rejects.toBeInstanceOf(CodexTurnTimeoutError)
    backend.close()
  })
})
