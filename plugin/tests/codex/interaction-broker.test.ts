import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { CodexInteractionBroker } from '../../src/codex/interaction-broker.js'
import type {
  RequestId,
  RpcErrorBody,
  ServerNotification,
  ServerRequest,
} from '../../src/codex/protocol.js'
import type { TransportClose } from '../../src/codex/transport.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteCodexInteractionRepository } from '../../src/durable/interaction-repository.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import {
  SqliteInboxRepository,
  SqliteOutboxRepository,
} from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

class FakeInteractionClient {
  readonly responses: Array<{ id: RequestId; result: unknown }> = []
  readonly errors: Array<{ id: RequestId; error: RpcErrorBody }> = []
  readonly requests = new Set<(request: ServerRequest) => void | Promise<void>>()
  readonly notifications = new Set<(notification: ServerNotification) => void>()
  readonly closes = new Set<(close: TransportClose) => void>()

  async respond(id: RequestId, result: unknown): Promise<void> {
    this.responses.push({ id, result })
  }

  async respondError(id: RequestId, error: RpcErrorBody): Promise<void> {
    this.errors.push({ id, error })
  }

  onServerRequest(listener: (request: ServerRequest) => void | Promise<void>): () => void {
    this.requests.add(listener)
    return () => this.requests.delete(listener)
  }

  onNotification(listener: (notification: ServerNotification) => void): () => void {
    this.notifications.add(listener)
    return () => this.notifications.delete(listener)
  }

  onClose(listener: (close: TransportClose) => void): () => void {
    this.closes.add(listener)
    return () => this.closes.delete(listener)
  }

  async emitRequest(request: ServerRequest): Promise<void> {
    await Promise.all([...this.requests].map((listener) => listener(request)))
  }

  emitClose(): void {
    for (const listener of this.closes) listener({ code: 137, signal: null })
  }
}

let root: string
let database: Database
let sessions: SqliteSessionRepository
let interactions: SqliteCodexInteractionRepository
let outbox: SqliteOutboxRepository
let client: FakeInteractionClient
let broker: CodexInteractionBroker

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-interaction-broker-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  sessions = new SqliteSessionRepository(database)
  interactions = new SqliteCodexInteractionRepository(database)
  outbox = new SqliteOutboxRepository(database)
  client = new FakeInteractionClient()

  const sourceUpdate = new SqliteInboxRepository(database).ingest({
    botId: 'primary',
    updateId: 1,
    chatId: '7001',
    payload: { update_id: 1 },
    receivedAtMs: NOW,
  }).update

  const prepared = sessions.prepareTextOperation({
    operationKey: 'telegram:primary:1:turn',
    inboxUpdateId: sourceUpdate.id,
    botId: 'primary',
    updateId: 1,
    chatId: '7001',
    projectId: 'workspace',
    text: 'do work',
  }, 'codex', NOW)
  sessions.markDispatching(prepared.turn.id, 'codex', 'thread-1', true, NOW)
  sessions.markBackendTurnStarted(prepared.turn.id, 'turn-1', 'codex', 'thread-1', NOW)

  broker = new CodexInteractionBroker(client, interactions, sessions, outbox, {
    connectionId: 'connection-1',
    interactionTimeoutMs: 60_000,
    now: () => NOW,
  })
})

afterEach(() => {
  broker.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
})

function onlyInteraction() {
  const row = database.query<{ token: string }, []>('SELECT token FROM codex_interactions').get()
  if (row === null) throw new Error('interaction not created')
  const interaction = interactions.getByToken(row.token)
  if (interaction === null) throw new Error('interaction not readable')
  return interaction
}

describe('CodexInteractionBroker', () => {
  test('persists a command approval, renders buttons and resolves it once', async () => {
    await client.emitRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: NOW,
        reason: 'network access',
        command: 'curl https://example.com',
        cwd: '/srv/workspace',
        availableDecisions: ['accept', 'decline'],
      },
    })

    const interaction = onlyInteraction()
    expect(interaction.state).toBe('PENDING')
    const prompt = outbox.getBySourceKey(`codex-interaction:${interaction.id}:prompt`)
    expect(prompt?.payload).toMatchObject({
      chatId: '7001',
      text: expect.stringContaining('curl https://example.com'),
      options: {
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            [{ callback_data: `dx:a:${interaction.token}:once`, text: expect.any(String) }],
            [{ callback_data: `dx:a:${interaction.token}:deny`, text: expect.any(String) }],
          ]),
        },
      },
    })

    await broker.handleInteraction({
      operationKey: 'telegram:primary:2:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 2,
      updateId: 2,
      response: {
        kind: 'approval',
        chatId: '7001',
        token: interaction.token,
        decision: 'accept',
        callbackQueryId: 'callback-1',
        callbackMessageId: 55,
      },
    })

    expect(client.responses).toEqual([{ id: 'approval-1', result: { decision: 'accept' } }])
    expect(interactions.get(interaction.id)?.state).toBe('RESOLVED')

    await broker.handleInteraction({
      operationKey: 'telegram:primary:3:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 3,
      updateId: 3,
      response: {
        kind: 'approval',
        chatId: '7001',
        token: interaction.token,
        decision: 'decline',
        callbackQueryId: 'callback-2',
        callbackMessageId: 55,
      },
    })
    expect(client.responses).toHaveLength(1)
  })

  test('collects option and free-text answers before responding to Codex', async () => {
    await client.emitRequest({
      id: 91,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-ask',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'stack',
            header: 'Stack',
            question: 'Choose stack',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Bun', description: 'fast' },
              { label: 'Node', description: 'stable' },
            ],
          },
          {
            id: 'note',
            header: 'Note',
            question: 'Add a note',
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    })
    const interaction = onlyInteraction()
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:question:0`)).not.toBeNull()
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:question:1`)).not.toBeNull()

    await broker.handleInteraction({
      operationKey: 'telegram:primary:2:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 2,
      updateId: 2,
      response: {
        kind: 'user_input_option',
        chatId: '7001',
        token: interaction.token,
        questionIndex: 0,
        optionIndex: 0,
        callbackQueryId: 'callback-q1',
        callbackMessageId: 70,
      },
    })
    expect(client.responses).toHaveLength(0)

    await broker.handleInteraction({
      operationKey: 'telegram:primary:22:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 22,
      updateId: 22,
      response: {
        kind: 'user_input_option',
        chatId: '7001',
        token: interaction.token,
        questionIndex: 0,
        optionIndex: 1,
        callbackQueryId: 'callback-q1-replay',
        callbackMessageId: 70,
      },
    })
    expect(interactions.get(interaction.id)?.answers).toEqual({ stack: ['Bun'] })

    await broker.handleInteraction({
      operationKey: 'telegram:primary:3:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 3,
      updateId: 3,
      response: {
        kind: 'user_input_text',
        chatId: '7001',
        token: interaction.token,
        questionIndex: 1,
        text: 'ship it',
      },
    })

    expect(client.responses).toEqual([{
      id: 91,
      result: {
        answers: {
          stack: { answers: ['Bun'] },
          note: { answers: ['ship it'] },
        },
      },
    }])
    expect(interactions.get(interaction.id)).toMatchObject({
      state: 'RESOLVED',
      answers: { stack: ['Bun'], note: ['ship it'] },
    })
  })

  test('rejects secret prompts and makes live requests stale on disconnect', async () => {
    await client.emitRequest({
      id: 'secret-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'secret-item',
        isBlocking: true,
        questions: [{
          id: 'password',
          header: 'Secret',
          question: 'Password',
          isOther: true,
          isSecret: true,
          options: null,
        }],
      },
    })
    const rejected = onlyInteraction()
    expect(rejected.state).toBe('FAILED')
    expect(client.errors[0]).toMatchObject({ id: 'secret-1', error: { code: -32002 } })

    await client.emitRequest({
      id: 'approval-live',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-item',
        startedAtMs: NOW,
        reason: 'write file',
      },
    })
    client.emitClose()
    const live = interactions.getByServerRequest('connection-1', 'approval-live')
    expect(live?.state).toBe('STALE')
    expect(live?.recoveryHandledAtMs).toBe(NOW)
    expect(outbox.getBySourceKey(`codex-interaction:${live?.id}:prompt`)?.state).toBe('ARCHIVED')
  })

  test('fails closed when an approval card expires', async () => {
    broker.close()
    broker = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-timeout',
      interactionTimeoutMs: 5,
      now: () => NOW,
    })
    await client.emitRequest({
      id: 'approval-timeout',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-timeout',
        startedAtMs: NOW,
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(client.responses).toContainEqual({
      id: 'approval-timeout',
      result: { decision: 'decline' },
    })
    expect(interactions.getByServerRequest('connection-timeout', 'approval-timeout')?.state).toBe(
      'EXPIRED',
    )
  })

  test('startup invalidates old requests and closes or retires their Telegram prompts', () => {
    const context = sessions.getContextByThread('thread-1')
    if (context === null) throw new Error('test session is not bound')
    const abandoned = interactions.create({
      connectionId: 'connection-killed',
      serverRequestId: 'old-request',
      sessionId: context.session.id,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'old-item',
      kind: 'FILE_APPROVAL',
      request: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'old-item' },
      createdAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
    }).interaction
    const deliveredPrompt = outbox.enqueue({
      sourceKey: `codex-interaction:${abandoned.id}:prompt`,
      sessionId: abandoned.sessionId,
      kind: 'send_text',
      payload: {
        chatId: '7001',
        text: 'old approval',
        options: { reply_markup: { inline_keyboard: [[{ text: 'Allow', callback_data: 'old' }]] } },
      },
      createdAtMs: NOW - 1_000,
    }).job
    outbox.claimNext({ workerId: 'sender-old', nowMs: NOW - 999, leaseDurationMs: 60_000 })
    outbox.markSendStarted(deliveredPrompt.id, 'sender-old', NOW - 998)
    outbox.markDelivered(deliveredPrompt.id, 'sender-old', 'telegram:55', NOW - 997)

    const restarted = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-restarted',
      now: () => NOW,
    })
    expect(interactions.get(abandoned.id)?.state).toBe('STALE')
    expect(restarted.recoverStartup()).toEqual({
      interactions: 1,
      retiredPrompts: 0,
      closedCards: 1,
      ambiguousPrompts: 0,
    })
    expect(interactions.get(abandoned.id)).toMatchObject({
      state: 'STALE',
      recoveryHandledAtMs: NOW,
    })
    expect(outbox.getBySourceKey(
      `codex-interaction:${abandoned.id}:restart-close:${deliveredPrompt.id}`,
    )?.payload).toEqual({
      chatId: '7001',
      messageId: 55,
      text: '⚠️ Запрос закрыт после перезапуска моста. Повтори действие, если оно ещё нужно.',
      options: { reply_markup: { inline_keyboard: [] } },
    })
    expect(restarted.recoverStartup().interactions).toBe(0)
    restarted.close()
  })

  test('archives an unsent stale prompt before outbound workers can deliver it', () => {
    const context = sessions.getContextByThread('thread-1')
    if (context === null) throw new Error('test session is not bound')
    const abandoned = interactions.create({
      connectionId: 'connection-killed',
      serverRequestId: 'old-unsent',
      sessionId: context.session.id,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'old-unsent-item',
      kind: 'USER_INPUT',
      request: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'old-unsent-item' },
      createdAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
    }).interaction
    const prompt = outbox.enqueue({
      sourceKey: `codex-interaction:${abandoned.id}:question:0`,
      sessionId: abandoned.sessionId,
      kind: 'send_text',
      payload: { chatId: '7001', text: 'old question' },
      createdAtMs: NOW - 1_000,
    }).job

    const restarted = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-restarted',
      now: () => NOW,
    })
    expect(restarted.recoverStartup()).toMatchObject({
      interactions: 1,
      retiredPrompts: 1,
    })
    expect(outbox.get(prompt.id)?.state).toBe('ARCHIVED')
    restarted.close()
  })

  test('quarantines an in-flight stale prompt as AMBIGUOUS and sends a safe notice', () => {
    const context = sessions.getContextByThread('thread-1')
    if (context === null) throw new Error('test session is not bound')
    const abandoned = interactions.create({
      connectionId: 'connection-killed',
      serverRequestId: 'old-in-flight',
      sessionId: context.session.id,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'old-flight-item',
      kind: 'FILE_APPROVAL',
      request: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'old-flight-item' },
      createdAtMs: NOW - 1_000,
      expiresAtMs: NOW + 60_000,
    }).interaction
    const prompt = outbox.enqueue({
      sourceKey: `codex-interaction:${abandoned.id}:prompt`,
      sessionId: abandoned.sessionId,
      kind: 'send_text',
      payload: { chatId: '7001', text: 'possibly sent approval' },
      createdAtMs: NOW - 1_000,
    }).job
    outbox.claimNext({ workerId: 'sender-dead', nowMs: NOW - 999, leaseDurationMs: 60_000 })
    outbox.markSendStarted(prompt.id, 'sender-dead', NOW - 998)

    const restarted = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-restarted',
      now: () => NOW,
    })
    expect(restarted.recoverStartup()).toMatchObject({
      interactions: 1,
      ambiguousPrompts: 1,
    })
    expect(outbox.get(prompt.id)?.state).toBe('AMBIGUOUS')
    expect(outbox.getBySourceKey(
      `codex-interaction:${abandoned.id}:restart-notice`,
    )?.payload).toMatchObject({
      chatId: '7001',
      text: expect.stringContaining('больше не может быть отвечен'),
    })
    restarted.close()
  })

  test('rejects unsupported permission profiles instead of hanging App Server', async () => {
    await client.emitRequest({
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-item',
        permissions: { network: true },
      },
    })
    expect(client.errors).toContainEqual({
      id: 'permissions-1',
      error: {
        code: -32004,
        message: 'Permission-profile approvals are not supported by this Telegram bridge yet',
      },
    })
  })
})
