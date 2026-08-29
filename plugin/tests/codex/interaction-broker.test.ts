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

  test('grants only the normalized requested permissions for one turn', async () => {
    await client.emitRequest({
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-item',
        environmentId: 'devbox',
        startedAtMs: NOW,
        cwd: '/srv/workspace',
        reason: 'read inputs and write generated files',
        permissions: {
          network: { enabled: true, ignoredFutureField: 'never echoed' },
          fileSystem: {
            read: ['/srv/workspace/input'],
            write: null,
            globScanMaxDepth: 4,
            entries: [
              {
                path: { type: 'path', path: '/srv/workspace/generated' },
                access: 'write',
                ignoredFutureField: true,
              },
              {
                path: { type: 'glob_pattern', pattern: '/srv/workspace/**/*.json' },
                access: 'read',
              },
              {
                path: {
                  type: 'special',
                  value: { kind: 'project_roots', subpath: 'artifacts' },
                },
                access: 'write',
              },
            ],
          },
        },
      },
    })

    const interaction = onlyInteraction()
    expect(interaction.kind).toBe('PERMISSIONS_APPROVAL')
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:prompt`)?.payload).toMatchObject({
      chatId: '7001',
      text: expect.stringContaining('write: /srv/workspace/generated'),
      options: {
        reply_markup: {
          inline_keyboard: [
            [{ callback_data: `dx:a:${interaction.token}:once`, text: expect.any(String) }],
            [{ callback_data: `dx:a:${interaction.token}:session`, text: expect.any(String) }],
            [{ callback_data: `dx:a:${interaction.token}:deny`, text: expect.any(String) }],
          ],
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
        callbackQueryId: 'callback-permissions',
        callbackMessageId: 80,
      },
    })

    expect(client.responses).toEqual([{
      id: 'permissions-1',
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['/srv/workspace/input'],
            write: null,
            globScanMaxDepth: 4,
            entries: [
              { path: { type: 'path', path: '/srv/workspace/generated' }, access: 'write' },
              {
                path: { type: 'glob_pattern', pattern: '/srv/workspace/**/*.json' },
                access: 'read',
              },
              {
                path: {
                  type: 'special',
                  value: { kind: 'project_roots', subpath: 'artifacts' },
                },
                access: 'write',
              },
            ],
          },
        },
        scope: 'turn',
      },
    }])
  })

  test('can persist the requested permission subset for the Codex session', async () => {
    await client.emitRequest({
      id: 'permissions-session',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-session-item',
        environmentId: null,
        startedAtMs: NOW,
        cwd: '/srv/workspace',
        reason: null,
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    })
    const interaction = onlyInteraction()
    await broker.handleInteraction({
      operationKey: 'telegram:primary:2:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 2,
      updateId: 2,
      response: {
        kind: 'approval',
        chatId: '7001',
        token: interaction.token,
        decision: 'acceptForSession',
        callbackQueryId: 'callback-permissions-session',
        callbackMessageId: 81,
      },
    })
    expect(client.responses).toEqual([{
      id: 'permissions-session',
      result: { permissions: { network: { enabled: true } }, scope: 'session' },
    }])
  })

  test('fails permission requests closed on deny, timeout and missing thread route', async () => {
    const permissionParams = {
      environmentId: null,
      startedAtMs: NOW,
      cwd: '/srv/workspace',
      reason: null,
      permissions: { network: { enabled: true }, fileSystem: null },
    }
    await client.emitRequest({
      id: 'permissions-deny',
      method: 'item/permissions/requestApproval',
      params: {
        ...permissionParams,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-deny-item',
      },
    })
    const interaction = onlyInteraction()
    await broker.handleInteraction({
      operationKey: 'telegram:primary:2:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 2,
      updateId: 2,
      response: {
        kind: 'approval',
        chatId: '7001',
        token: interaction.token,
        decision: 'decline',
        callbackQueryId: 'callback-permissions-deny',
        callbackMessageId: 82,
      },
    })
    expect(client.responses).toContainEqual({
      id: 'permissions-deny',
      result: { permissions: {}, scope: 'turn' },
    })

    await client.emitRequest({
      id: 'permissions-unroutable',
      method: 'item/permissions/requestApproval',
      params: {
        ...permissionParams,
        threadId: 'thread-missing',
        turnId: 'turn-missing',
        itemId: 'permissions-unroutable-item',
      },
    })
    expect(client.responses).toContainEqual({
      id: 'permissions-unroutable',
      result: { permissions: {}, scope: 'turn' },
    })

    broker.close()
    broker = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-permissions-timeout',
      interactionTimeoutMs: 5,
      now: () => NOW,
    })
    await client.emitRequest({
      id: 'permissions-timeout',
      method: 'item/permissions/requestApproval',
      params: {
        ...permissionParams,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-timeout-item',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(client.responses).toContainEqual({
      id: 'permissions-timeout',
      result: { permissions: {}, scope: 'turn' },
    })
  })

  test('rejects malformed permission-profile requests without creating a card', async () => {
    await client.emitRequest({
      id: 'permissions-malformed',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-item',
        environmentId: null,
        startedAtMs: NOW,
        cwd: '/srv/workspace',
        reason: null,
        permissions: { network: true, fileSystem: null },
      },
    })
    expect(client.errors).toContainEqual({
      id: 'permissions-malformed',
      error: { code: -32602, message: 'Malformed Codex interaction request' },
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM codex_interactions',
    ).get()?.count).toBe(0)
  })

  test('collects a typed MCP form durably and returns structured content', async () => {
    await client.emitRequest({
      id: 'mcp-form-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'deployments',
        mode: 'form',
        _meta: null,
        message: 'Configure deployment',
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name', minLength: 2 },
            retries: { type: 'integer', title: 'Retries', minimum: 1, maximum: 5 },
            enabled: { type: 'boolean', title: 'Enabled' },
            region: {
              type: 'string',
              title: 'Region',
              oneOf: [
                { const: 'eu', title: 'Europe' },
                { const: 'us', title: 'United States' },
              ],
            },
            features: {
              type: 'array',
              title: 'Features',
              minItems: 1,
              maxItems: 2,
              items: { type: 'string', enum: ['logs', 'metrics', 'traces'] },
            },
            note: { type: 'string', title: 'Note' },
          },
          required: ['name', 'retries', 'enabled', 'region', 'features'],
        },
      },
    })

    const interaction = onlyInteraction()
    expect(interaction.kind).toBe('MCP_ELICITATION')
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-prompt`)?.payload).toMatchObject({
      chatId: '7001',
      text: expect.stringContaining('deployments'),
    })
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-field:4`)?.payload).toMatchObject({
      text: expect.stringContaining('Features'),
      options: {
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            [{ callback_data: `dx:e:${interaction.token}:o:4:0`, text: expect.any(String) }],
            [{ callback_data: `dx:e:${interaction.token}:d:4`, text: expect.any(String) }],
          ]),
        },
      },
    })

    const textResponse = async (fieldIndex: number, text: string, updateId: number) => broker.handleInteraction({
      operationKey: `telegram:primary:${updateId}:turn:interaction`,
      botId: 'primary',
      inboxUpdateId: updateId,
      updateId,
      response: {
        kind: 'mcp_elicitation_text' as const,
        chatId: '7001',
        token: interaction.token,
        fieldIndex,
        text,
      },
    })
    const optionResponse = async (fieldIndex: number, optionIndex: number, updateId: number) => broker.handleInteraction({
      operationKey: `telegram:primary:${updateId}:turn:interaction`,
      botId: 'primary',
      inboxUpdateId: updateId,
      updateId,
      response: {
        kind: 'mcp_elicitation_option' as const,
        chatId: '7001',
        token: interaction.token,
        fieldIndex,
        optionIndex,
        callbackQueryId: `callback-mcp-${updateId}`,
        callbackMessageId: 100 + updateId,
      },
    })

    await textResponse(0, 'service', 2)
    await textResponse(1, '9', 3)
    expect(interactions.get(interaction.id)?.answers['mcp:1:value']).toBeUndefined()
    await textResponse(1, '3', 4)
    await optionResponse(2, 0, 5)
    await optionResponse(3, 1, 6)
    await optionResponse(4, 0, 7)
    await optionResponse(4, 1, 8)
    expect(interactions.get(interaction.id)?.answers['mcp:4:value']).toEqual(['logs', 'metrics'])
    await broker.handleInteraction({
      operationKey: 'telegram:primary:9:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 9,
      updateId: 9,
      response: {
        kind: 'mcp_elicitation_done',
        chatId: '7001',
        token: interaction.token,
        fieldIndex: 4,
        callbackQueryId: 'callback-mcp-done',
        callbackMessageId: 109,
      },
    })
    await broker.handleInteraction({
      operationKey: 'telegram:primary:10:turn:interaction',
      botId: 'primary',
      inboxUpdateId: 10,
      updateId: 10,
      response: {
        kind: 'mcp_elicitation_skip',
        chatId: '7001',
        token: interaction.token,
        fieldIndex: 5,
        callbackQueryId: 'callback-mcp-skip',
        callbackMessageId: 110,
      },
    })

    expect(client.responses).toEqual([{
      id: 'mcp-form-1',
      result: {
        action: 'accept',
        content: {
          name: 'service',
          retries: 3,
          enabled: true,
          region: 'us',
          features: ['logs', 'metrics'],
        },
        _meta: null,
      },
    }])
    expect(interactions.get(interaction.id)?.state).toBe('RESOLVED')
  })

  test('renders an HTTPS MCP URL flow without exposing the full URL in text', async () => {
    const url = 'https://accounts.example.com/authorize?state=opaque-value'
    await client.emitRequest({
      id: 'mcp-url-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: null,
        serverName: 'oauth-server',
        mode: 'url',
        _meta: null,
        message: 'Authorize access',
        url,
        elicitationId: 'elicitation-1',
      },
    })
    const interaction = onlyInteraction()
    const prompt = outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-prompt`)
    const promptText = (prompt?.payload as { text?: unknown } | undefined)?.text
    expect(typeof promptText).toBe('string')
    if (typeof promptText !== 'string') throw new Error('MCP URL prompt text missing')
    expect(promptText).not.toContain('opaque-value')
    expect(prompt?.payload).toMatchObject({
      text: expect.stringContaining('accounts.example.com'),
      options: {
        reply_markup: {
          inline_keyboard: expect.arrayContaining([
            [{ text: expect.any(String), url }],
            [{ callback_data: `dx:e:${interaction.token}:a:accept`, text: expect.any(String) }],
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
        kind: 'mcp_elicitation_action',
        chatId: '7001',
        token: interaction.token,
        action: 'accept',
        callbackQueryId: 'callback-mcp-url',
        callbackMessageId: 120,
      },
    })
    expect(client.responses).toEqual([{
      id: 'mcp-url-1',
      result: { action: 'accept', content: null, _meta: null },
    }])
  })

  test('retires every pending MCP card durably when the App Server disconnects', async () => {
    await client.emitRequest({
      id: 'mcp-restart',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'deployments',
        mode: 'form',
        _meta: null,
        message: 'Choose environment',
        requestedSchema: {
          type: 'object',
          properties: {
            environment: { type: 'string', enum: ['staging', 'production'] },
          },
          required: ['environment'],
        },
      },
    })
    const interaction = onlyInteraction()
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-prompt`)?.state).toBe(
      'PENDING',
    )
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-field:0`)?.state).toBe(
      'PENDING',
    )

    client.emitClose()

    expect(interactions.get(interaction.id)).toMatchObject({
      state: 'STALE',
      recoveryHandledAtMs: NOW,
    })
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-prompt`)?.state).toBe(
      'ARCHIVED',
    )
    expect(outbox.getBySourceKey(`codex-interaction:${interaction.id}:mcp-field:0`)?.state).toBe(
      'ARCHIVED',
    )
  })

  test('cancels unnegotiated extended forms and fails timeout or missing routes closed', async () => {
    await client.emitRequest({
      id: 'mcp-extended',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'extended',
        mode: 'openai/form',
        _meta: null,
        message: 'Collect secret',
        requestedSchema: { type: 'object', properties: {} },
      },
    })
    expect(client.responses).toContainEqual({
      id: 'mcp-extended',
      result: { action: 'cancel', content: null, _meta: null },
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM codex_interactions',
    ).get()?.count).toBe(0)
    const unsupportedNotice = database.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM delivery_jobs WHERE source_key LIKE 'codex-mcp-unsupported:%'",
    ).get()
    expect(JSON.parse(unsupportedNotice?.payload_json ?? '{}')).toMatchObject({
      text: expect.stringContaining('безопасно отменён'),
    })

    const emptyForm = {
      turnId: 'turn-1',
      serverName: 'confirmations',
      mode: 'form',
      _meta: null,
      message: 'Confirm action',
      requestedSchema: { type: 'object', properties: {} },
    }
    await client.emitRequest({
      id: 'mcp-unroutable',
      method: 'mcpServer/elicitation/request',
      params: { ...emptyForm, threadId: 'thread-missing' },
    })
    expect(client.responses).toContainEqual({
      id: 'mcp-unroutable',
      result: { action: 'cancel', content: null, _meta: null },
    })

    broker.close()
    broker = new CodexInteractionBroker(client, interactions, sessions, outbox, {
      connectionId: 'connection-mcp-timeout',
      interactionTimeoutMs: 5,
      now: () => NOW,
    })
    await client.emitRequest({
      id: 'mcp-timeout',
      method: 'mcpServer/elicitation/request',
      params: { ...emptyForm, threadId: 'thread-1' },
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(client.responses).toContainEqual({
      id: 'mcp-timeout',
      result: { action: 'cancel', content: null, _meta: null },
    })
  })

  test('rejects malformed or secret-like MCP forms without creating a card', async () => {
    await client.emitRequest({
      id: 'mcp-malformed',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'unsafe',
        mode: 'form',
        _meta: null,
        message: 'Password',
        requestedSchema: {
          type: 'object',
          properties: { password: { type: 'string', format: 'password' } },
          required: ['password'],
        },
      },
    })
    expect(client.errors).toContainEqual({
      id: 'mcp-malformed',
      error: { code: -32602, message: 'Malformed Codex interaction request' },
    })
    expect(database.query<{ count: number }, []>(
      'SELECT count(*) AS count FROM codex_interactions',
    ).get()?.count).toBe(0)
  })
})
