import type { OutboxRepository } from '../durable/contracts.js'
import {
  SqliteCodexInteractionRepository,
  type CodexInteractionKind,
  type CodexInteractionRecord,
} from '../durable/interaction-repository.js'
import type { SqliteSessionRepository } from '../durable/session-repository.js'
import { redactSecrets } from '../safety/redact.js'
import type {
  IncomingInteractionResponse,
  InteractionHandler,
  InteractionOperation,
  InteractionResult,
} from '../bridge/contracts.js'
import type { CodexAppServerClient } from './app-server-client.js'
import type {
  RequestId,
  RpcErrorBody,
  ServerNotification,
  ServerRequest,
} from './protocol.js'
import type { TransportClose } from './transport.js'

interface InteractionClient {
  respond(requestId: RequestId, result: unknown): Promise<void>
  respondError(requestId: RequestId, error: RpcErrorBody): Promise<void>
  onServerRequest(listener: (request: ServerRequest) => void | Promise<void>): () => void
  onNotification(listener: (notification: ServerNotification) => void): () => void
  onClose(listener: (close: TransportClose) => void): () => void
}

interface CommonInteractionParams {
  threadId: string
  turnId: string
  itemId: string
}

interface ApprovalParams extends CommonInteractionParams {
  reason: string | null
  command: string | null
  cwd: string | null
  grantRoot: string | null
  availableDecisions: readonly unknown[] | null
}

interface UserInputOption {
  label: string
  description: string
}

interface UserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: readonly UserInputOption[] | null
}

interface UserInputParams extends CommonInteractionParams {
  questions: readonly UserInputQuestion[]
  isBlocking: boolean
}

type ParsedServerInteraction =
  | { kind: 'COMMAND_APPROVAL'; params: ApprovalParams }
  | { kind: 'FILE_APPROVAL'; params: ApprovalParams }
  | { kind: 'USER_INPUT'; params: UserInputParams }

export interface CodexInteractionBrokerOptions {
  backendName?: string
  interactionTimeoutMs?: number
  now?: () => number
  connectionId?: string
}

const DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60_000
const MAX_PREVIEW = 1_200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseCommon(value: unknown): CommonInteractionParams | null {
  if (!isRecord(value)) return null
  if (
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.itemId !== 'string'
  ) {
    return null
  }
  return { threadId: value.threadId, turnId: value.turnId, itemId: value.itemId }
}

function parseApproval(value: unknown): ApprovalParams | null {
  const common = parseCommon(value)
  if (common === null || !isRecord(value)) return null
  return {
    ...common,
    reason: nullableString(value.reason),
    command: nullableString(value.command),
    cwd: nullableString(value.cwd),
    grantRoot: nullableString(value.grantRoot),
    availableDecisions: Array.isArray(value.availableDecisions) ? value.availableDecisions : null,
  }
}

function parseQuestions(value: unknown): readonly UserInputQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 99) return null
  const ids = new Set<string>()
  const questions: UserInputQuestion[] = []
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      raw.id.length === 0 ||
      ids.has(raw.id) ||
      typeof raw.header !== 'string' ||
      typeof raw.question !== 'string' ||
      typeof raw.isOther !== 'boolean' ||
      typeof raw.isSecret !== 'boolean'
    ) {
      return null
    }
    let options: UserInputOption[] | null = null
    if (raw.options !== null) {
      if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 99) return null
      options = []
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.label !== 'string' || typeof option.description !== 'string') {
          return null
        }
        options.push({ label: option.label, description: option.description })
      }
    }
    ids.add(raw.id)
    questions.push({
      id: raw.id,
      header: raw.header,
      question: raw.question,
      isOther: raw.isOther,
      isSecret: raw.isSecret,
      options,
    })
  }
  return questions
}

function parseUserInput(value: unknown): UserInputParams | null {
  const common = parseCommon(value)
  if (common === null || !isRecord(value) || typeof value.isBlocking !== 'boolean') return null
  const questions = parseQuestions(value.questions)
  if (questions === null) return null
  return { ...common, questions, isBlocking: value.isBlocking }
}

function parseServerInteraction(request: ServerRequest): ParsedServerInteraction | null {
  if (request.method === 'item/commandExecution/requestApproval') {
    const params = parseApproval(request.params)
    return params === null ? null : { kind: 'COMMAND_APPROVAL', params }
  }
  if (request.method === 'item/fileChange/requestApproval') {
    const params = parseApproval(request.params)
    return params === null ? null : { kind: 'FILE_APPROVAL', params }
  }
  if (request.method === 'item/tool/requestUserInput') {
    const params = parseUserInput(request.params)
    return params === null ? null : { kind: 'USER_INPUT', params }
  }
  return null
}

function isKnownInteractiveMethod(method: string): boolean {
  return method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/tool/requestUserInput' ||
    method === 'item/permissions/requestApproval'
}

function clip(text: string, max = MAX_PREVIEW): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function approvalButtons(
  token: string,
  params: ApprovalParams,
): Array<Array<{ text: string; callback_data: string }>> {
  const allowed = new Set(
    (params.availableDecisions ?? ['accept', 'acceptForSession', 'decline'])
      .filter((decision): decision is string => typeof decision === 'string'),
  )
  const row: Array<{ text: string; callback_data: string }> = []
  if (allowed.has('accept')) row.push({ text: '✅ Разрешить один раз', callback_data: `dx:a:${token}:once` })
  if (allowed.has('acceptForSession')) {
    row.push({ text: '🔁 На сессию', callback_data: `dx:a:${token}:session` })
  }
  if (allowed.has('decline')) row.push({ text: '❌ Запретить', callback_data: `dx:a:${token}:deny` })
  if (allowed.has('cancel')) row.push({ text: '⏹ Отменить', callback_data: `dx:a:${token}:cancel` })
  return row.map((button) => [button])
}

function renderApproval(kind: CodexInteractionKind, token: string, params: ApprovalParams): string {
  const lines = [
    kind === 'COMMAND_APPROVAL'
      ? '🔐 Codex просит разрешить команду'
      : '📝 Codex просит разрешить изменение файлов',
  ]
  if (params.reason !== null && params.reason.trim().length > 0) {
    lines.push(`Причина: ${clip(params.reason, 500)}`)
  }
  if (params.command !== null && params.command.trim().length > 0) {
    lines.push(`Команда:\n${clip(params.command)}`)
  }
  if (params.cwd !== null && params.cwd.trim().length > 0) lines.push(`Каталог: ${clip(params.cwd, 500)}`)
  if (params.grantRoot !== null && params.grantRoot.trim().length > 0) {
    lines.push(`Запрашиваемый root: ${clip(params.grantRoot, 500)}`)
  }
  const footer = `ID: ${token}`
  return redactSecrets(`${clip(lines.join('\n\n'), 3_500 - footer.length)}\n\n${footer}`)
}

function renderQuestion(token: string, question: UserInputQuestion, index: number, total: number): string {
  const lines = [
    `❓ Codex ждёт ответ — ${index + 1}/${total}`,
    question.header.trim().length > 0 ? question.header : 'Вопрос',
    clip(question.question, 1_500),
  ]
  if (question.options !== null) {
    for (const [optionIndex, option] of question.options.entries()) {
      const description = option.description.trim().length > 0 ? ` — ${clip(option.description, 300)}` : ''
      lines.push(`${optionIndex + 1}. ${clip(option.label, 200)}${description}`)
    }
  }
  const footer = [
    question.options === null || question.isOther
      ? `Свободный ответ: /answer ${token} ${index + 1} <текст>`
      : null,
    `ID: ${token}`,
  ].filter((line): line is string => line !== null).join('\n\n')
  return redactSecrets(`${clip(lines.join('\n\n'), 3_500 - footer.length)}\n\n${footer}`)
}

function questionButtons(
  token: string,
  question: UserInputQuestion,
  questionIndex: number,
): Array<Array<{ text: string; callback_data: string }>> {
  if (question.options === null) return []
  return question.options.map((option, optionIndex) => [{
    text: clip(option.label, 48),
    callback_data: `dx:q:${token}:${questionIndex}:${optionIndex}`,
  }])
}

function parseResolvedNotification(
  notification: ServerNotification,
): { threadId: string; requestId: RequestId } | null {
  if (notification.method !== 'serverRequest/resolved' || !isRecord(notification.params)) return null
  const { threadId, requestId } = notification.params
  if (typeof threadId !== 'string' || (typeof requestId !== 'string' && typeof requestId !== 'number')) {
    return null
  }
  return { threadId, requestId }
}

function closeText(state: CodexInteractionRecord['state']): string {
  return state === 'EXPIRED' ? 'Запрос истёк' : 'Запрос уже закрыт'
}

export class CodexInteractionBroker implements InteractionHandler {
  readonly connectionId: string
  private readonly backendName: string
  private readonly interactionTimeoutMs: number
  private readonly now: () => number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly unsubscribeRequest: () => void
  private readonly unsubscribeNotification: () => void
  private readonly unsubscribeClose: () => void
  private closed = false

  constructor(
    private readonly client: CodexAppServerClient | InteractionClient,
    private readonly interactions: SqliteCodexInteractionRepository,
    private readonly sessions: SqliteSessionRepository,
    private readonly outbox: OutboxRepository,
    options: CodexInteractionBrokerOptions = {},
  ) {
    this.connectionId = options.connectionId ?? crypto.randomUUID()
    this.backendName = options.backendName ?? 'codex'
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.interactionTimeoutMs) || this.interactionTimeoutMs <= 0) {
      throw new TypeError('interactionTimeoutMs must be a positive safe integer')
    }
    this.interactions.markAbandonedConnectionsStale(this.connectionId, this.now())
    this.unsubscribeRequest = client.onServerRequest((request) => this.handleServerRequest(request))
    this.unsubscribeNotification = client.onNotification((notification) => {
      const resolved = parseResolvedNotification(notification)
      if (resolved === null) return
      const interaction = this.interactions.markExternallyResolved(
        this.connectionId,
        resolved.requestId,
        resolved.threadId,
        this.now(),
      )
      if (interaction !== null) this.clearTimer(interaction.id)
    })
    this.unsubscribeClose = client.onClose(() => this.markConnectionStale())
  }

  async handleInteraction(operation: InteractionOperation): Promise<InteractionResult> {
    const interaction = this.interactions.getByToken(operation.response.token)
    if (interaction === null || interaction.connectionId !== this.connectionId) {
      return this.enqueueClosedResponse(operation, 'Запрос не найден')
    }
    const context = this.sessions.getContextByThread(interaction.threadId, this.backendName)
    if (
      context === null ||
      context.session.id !== interaction.sessionId ||
      context.session.chatId !== operation.response.chatId
    ) {
      return this.enqueueClosedResponse(operation, 'Запрос относится к другой сессии')
    }
    if (interaction.state !== 'PENDING') {
      return this.enqueueClosedResponse(operation, closeText(interaction.state))
    }
    if (interaction.expiresAtMs <= this.now()) {
      await this.expireInteraction(interaction.id)
      return this.enqueueClosedResponse(operation, 'Запрос истёк')
    }

    if (operation.response.kind === 'approval') {
      return this.handleApproval(operation, interaction, operation.response)
    }
    return this.handleUserInput(operation, interaction, operation.response)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeRequest()
    this.unsubscribeNotification()
    this.unsubscribeClose()
    this.markConnectionStale()
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    const parsed = parseServerInteraction(request)
    if (parsed === null) {
      if (request.method === 'item/permissions/requestApproval') {
        await this.client.respondError(request.id, {
          code: -32004,
          message: 'Permission-profile approvals are not supported by this Telegram bridge yet',
        })
      } else if (isKnownInteractiveMethod(request.method)) {
        await this.client.respondError(request.id, {
          code: -32602,
          message: 'Malformed Codex interaction request',
        })
      }
      return
    }
    const context = this.sessions.getContextByThread(parsed.params.threadId, this.backendName)
    if (context === null) {
      await this.failClosedUnroutable(request, parsed.kind)
      return
    }
    const nowMs = this.now()
    const created = this.interactions.create({
      connectionId: this.connectionId,
      serverRequestId: request.id,
      sessionId: context.session.id,
      threadId: parsed.params.threadId,
      turnId: parsed.params.turnId,
      itemId: parsed.params.itemId,
      kind: parsed.kind,
      request: request.params,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.interactionTimeoutMs,
    })
    if (!created.created) return

    if (parsed.kind === 'USER_INPUT' && parsed.params.questions.some((question) => question.isSecret)) {
      await this.rejectSecretInput(created.interaction, context.session.chatId)
      return
    }
    if (
      (parsed.kind === 'COMMAND_APPROVAL' || parsed.kind === 'FILE_APPROVAL') &&
      approvalButtons(created.interaction.token, parsed.params).length === 0
    ) {
      await this.rejectUnsupportedApproval(created.interaction, context.session.chatId)
      return
    }
    this.enqueuePrompts(created.interaction, context.session.chatId, parsed)
    this.armTimeout(created.interaction)
  }

  private enqueuePrompts(
    interaction: CodexInteractionRecord,
    chatId: string,
    parsed: ParsedServerInteraction,
  ): void {
    if (parsed.kind === 'COMMAND_APPROVAL' || parsed.kind === 'FILE_APPROVAL') {
      this.outbox.enqueue({
        sourceKey: `codex-interaction:${interaction.id}:prompt`,
        sessionId: interaction.sessionId,
        kind: 'send_text',
        payload: {
          chatId,
          text: renderApproval(parsed.kind, interaction.token, parsed.params),
          options: { reply_markup: { inline_keyboard: approvalButtons(interaction.token, parsed.params) } },
        },
        createdAtMs: interaction.createdAtMs,
        expiresAtMs: interaction.expiresAtMs,
      })
      return
    }
    for (const [index, question] of parsed.params.questions.entries()) {
      const keyboard = questionButtons(interaction.token, question, index)
      this.outbox.enqueue({
        sourceKey: `codex-interaction:${interaction.id}:question:${index}`,
        sessionId: interaction.sessionId,
        kind: 'send_text',
        payload: {
          chatId,
          text: renderQuestion(interaction.token, question, index, parsed.params.questions.length),
          ...(keyboard.length === 0
            ? {}
            : { options: { reply_markup: { inline_keyboard: keyboard } } }),
        },
        createdAtMs: interaction.createdAtMs,
        expiresAtMs: interaction.expiresAtMs,
      })
    }
  }

  private async handleApproval(
    operation: InteractionOperation,
    interaction: CodexInteractionRecord,
    response: Extract<IncomingInteractionResponse, { kind: 'approval' }>,
  ): Promise<InteractionResult> {
    if (interaction.kind !== 'COMMAND_APPROVAL' && interaction.kind !== 'FILE_APPROVAL') {
      return this.enqueueClosedResponse(operation, 'Это не запрос подтверждения')
    }
    const params = parseApproval(interaction.request)
    if (params === null || !this.approvalDecisionAllowed(interaction.kind, params, response.decision)) {
      return this.enqueueClosedResponse(operation, 'Такое решение недоступно')
    }
    const payload = { decision: response.decision }
    const began = this.interactions.beginResolution(
      interaction.token,
      interaction.sessionId,
      payload,
      this.now(),
    )
    if (began.outcome !== 'started') return this.enqueueClosedResponse(operation, closeText(began.interaction.state))
    const resolved = await this.sendResolution(began.interaction, payload)
    const verdict = response.decision === 'decline' || response.decision === 'cancel'
      ? '❌ Запрещено'
      : '✅ Разрешено'
    return this.enqueueCallbackOutcome(operation, resolved ? verdict : '⚠️ Ответ не доставлен в Codex', verdict)
  }

  private async handleUserInput(
    operation: InteractionOperation,
    interaction: CodexInteractionRecord,
    response: Exclude<IncomingInteractionResponse, { kind: 'approval' }>,
  ): Promise<InteractionResult> {
    if (interaction.kind !== 'USER_INPUT') {
      return this.enqueueClosedResponse(operation, 'Это не запрос дополнительного ввода')
    }
    const params = parseUserInput(interaction.request)
    const question = params?.questions[response.questionIndex]
    if (params === null || question === undefined || question.isSecret) {
      return this.enqueueClosedResponse(operation, 'Вопрос недоступен')
    }

    let answer: string
    if (response.kind === 'user_input_option') {
      const option = question.options?.[response.optionIndex]
      if (option === undefined) return this.enqueueClosedResponse(operation, 'Вариант ответа недоступен')
      answer = option.label
    } else {
      if (question.options !== null && !question.isOther) {
        return this.enqueueClosedResponse(operation, 'Для этого вопроса выбери кнопку')
      }
      if (response.text.trim().length === 0) return this.enqueueClosedResponse(operation, 'Пустой ответ не принят')
      answer = response.text
    }

    const recorded = this.interactions.recordAnswer(
      interaction.token,
      interaction.sessionId,
      question.id,
      [answer],
      this.now(),
    )
    if (!recorded.applied) return this.enqueueClosedResponse(operation, 'На этот вопрос уже ответили')
    const updated = recorded.interaction
    if (updated.state !== 'PENDING') return this.enqueueClosedResponse(operation, closeText(updated.state))
    const complete = params.questions.every((item) => updated.answers[item.id] !== undefined)
    if (!complete) return this.enqueueAnswerAccepted(operation, answer, false)

    const responsePayload = {
      answers: Object.fromEntries(
        params.questions.map((item) => [item.id, { answers: updated.answers[item.id] as string[] }]),
      ),
    }
    const began = this.interactions.beginResolution(
      interaction.token,
      interaction.sessionId,
      responsePayload,
      this.now(),
    )
    if (began.outcome !== 'started') return this.enqueueClosedResponse(operation, closeText(began.interaction.state))
    const resolved = await this.sendResolution(began.interaction, responsePayload)
    return this.enqueueAnswerAccepted(operation, answer, resolved)
  }

  private approvalDecisionAllowed(
    kind: 'COMMAND_APPROVAL' | 'FILE_APPROVAL',
    params: ApprovalParams,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): boolean {
    if (
      kind === 'FILE_APPROVAL' &&
      !['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)
    ) {
      return false
    }
    if (params.availableDecisions === null) return true
    return params.availableDecisions.includes(decision)
  }

  private async sendResolution(interaction: CodexInteractionRecord, response: unknown): Promise<boolean> {
    try {
      await this.client.respond(interaction.serverRequestId, response)
      this.interactions.markResolved(interaction.id, this.now())
      this.clearTimer(interaction.id)
      return true
    } catch (error) {
      this.interactions.markFailed(
        interaction.id,
        error instanceof Error ? error.name : 'AppServerResponseError',
        this.now(),
      )
      this.clearTimer(interaction.id)
      return false
    }
  }

  private enqueueAnswerAccepted(
    operation: InteractionOperation,
    answer: string,
    completed: boolean,
  ): InteractionResult {
    if (operation.response.kind === 'user_input_option') {
      return this.enqueueCallbackOutcome(
        operation,
        completed ? '✅ Ответы приняты, Codex продолжает' : '✅ Ответ принят',
        `✅ ${clip(answer, 100)}`,
      )
    }
    const enqueued = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:confirmation`,
      kind: 'send_text',
      payload: {
        chatId: operation.response.chatId,
        text: completed ? '✅ Ответы приняты, Codex продолжает' : '✅ Ответ принят',
      },
      createdAtMs: this.now(),
    })
    return { deliveryJobId: enqueued.job.id }
  }

  private enqueueCallbackOutcome(
    operation: InteractionOperation,
    toast: string,
    cardText: string,
  ): InteractionResult {
    const response = operation.response
    if (response.kind === 'user_input_text') return this.enqueueClosedResponse(operation, toast)
    const nowMs = this.now()
    const edit = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:edit`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text: cardText,
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: nowMs,
    })
    this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:callback-ack`,
      kind: 'reaction',
      payload: { action: 'answer_callback', callbackQueryId: response.callbackQueryId, text: toast },
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 30_000,
    })
    return { deliveryJobId: edit.job.id }
  }

  private enqueueClosedResponse(operation: InteractionOperation, text: string): InteractionResult {
    const response = operation.response
    const nowMs = this.now()
    if (response.kind !== 'user_input_text') {
      const ack = this.outbox.enqueue({
        sourceKey: `${operation.operationKey}:callback-ack`,
        kind: 'reaction',
        payload: { action: 'answer_callback', callbackQueryId: response.callbackQueryId, text },
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 30_000,
      })
      return { deliveryJobId: ack.job.id }
    }
    const sent = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:notice`,
      kind: 'send_text',
      payload: { chatId: response.chatId, text },
      createdAtMs: nowMs,
    })
    return { deliveryJobId: sent.job.id }
  }

  private async failClosedUnroutable(
    request: ServerRequest,
    kind: CodexInteractionKind,
  ): Promise<void> {
    if (kind === 'USER_INPUT') {
      await this.client.respondError(request.id, {
        code: -32001,
        message: 'No durable Telegram session is bound to this Codex thread',
      })
      return
    }
    await this.client.respond(request.id, { decision: 'decline' })
  }

  private async rejectSecretInput(interaction: CodexInteractionRecord, chatId: string): Promise<void> {
    try {
      await this.client.respondError(interaction.serverRequestId, {
        code: -32002,
        message: 'Secret user input is not accepted through Telegram',
      })
    } finally {
      this.interactions.markFailed(interaction.id, 'SecretInputRejected', this.now())
      this.outbox.enqueue({
        sourceKey: `codex-interaction:${interaction.id}:secret-rejected`,
        sessionId: interaction.sessionId,
        kind: 'send_text',
        payload: {
          chatId,
          text: '🔒 Codex запросил секретный ввод. Telegram-мост отклонил запрос: секреты через чат не принимаются.',
        },
        createdAtMs: this.now(),
      })
    }
  }

  private async rejectUnsupportedApproval(
    interaction: CodexInteractionRecord,
    chatId: string,
  ): Promise<void> {
    const response = { decision: 'cancel' }
    const began = this.interactions.beginResolution(
      interaction.token,
      interaction.sessionId,
      response,
      this.now(),
    )
    if (began.outcome === 'started') await this.sendResolution(began.interaction, response)
    this.outbox.enqueue({
      sourceKey: `codex-interaction:${interaction.id}:unsupported-approval`,
      sessionId: interaction.sessionId,
      kind: 'send_text',
      payload: {
        chatId,
        text: '⏹ Codex прислал approval без поддерживаемого безопасного решения. Мост отменил запрос.',
      },
      createdAtMs: this.now(),
    })
  }

  private armTimeout(interaction: CodexInteractionRecord): void {
    const delayMs = Math.max(1, interaction.expiresAtMs - this.now())
    const timer = setTimeout(() => {
      void this.expireInteraction(interaction.id)
    }, delayMs)
    const unrefTimer = timer as unknown as { unref?: () => void }
    unrefTimer.unref?.()
    this.timers.set(interaction.id, timer)
  }

  private async expireInteraction(id: string): Promise<void> {
    const interaction = this.interactions.get(id)
    if (interaction === null || interaction.state !== 'PENDING') return
    const response = interaction.kind === 'USER_INPUT' ? null : { decision: 'decline' }
    if (response === null) {
      const began = this.interactions.beginTimeoutResolution(
        interaction.id,
        { error: 'expired' },
        this.now(),
      )
      if (began.outcome === 'started') {
        try {
          await this.client.respondError(interaction.serverRequestId, {
            code: -32003,
            message: 'Telegram interaction expired',
          })
          this.interactions.markExpired(interaction.id, this.now())
        } catch (error) {
          this.interactions.markFailed(
            interaction.id,
            error instanceof Error ? error.name : 'AppServerResponseError',
            this.now(),
          )
        }
      }
    } else {
      const began = this.interactions.beginTimeoutResolution(
        interaction.id,
        response,
        this.now(),
      )
      if (began.outcome === 'started') {
        try {
          await this.client.respond(interaction.serverRequestId, response)
          this.interactions.markExpired(interaction.id, this.now())
        } catch (error) {
          this.interactions.markFailed(
            interaction.id,
            error instanceof Error ? error.name : 'AppServerResponseError',
            this.now(),
          )
        }
      }
    }
    this.clearTimer(id)
  }

  private markConnectionStale(): void {
    this.interactions.markConnectionStale(this.connectionId, this.now())
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(id)
  }
}
