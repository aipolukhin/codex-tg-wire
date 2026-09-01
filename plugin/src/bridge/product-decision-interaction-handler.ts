import type { OutboxRepository } from '../durable/contracts.js'
import type { SqliteProductDecisionRepository } from '../durable/product-decision-repository.js'
import type {
  IncomingInteractionResponse,
  InteractionHandler,
  InteractionOperation,
  InteractionResult,
} from './contracts.js'
import type { ProductDecisionAcceptanceService } from './product-decision-acceptance.js'
import {
  productDecisionButtons,
  renderProductDecisionCard,
} from './product-decision.js'

type FeatureAction = Extract<IncomingInteractionResponse, { kind: 'feature_action' }>

export class ProductDecisionInteractionHandler implements InteractionHandler {
  constructor(
    private readonly delegate: InteractionHandler,
    private readonly decisions: SqliteProductDecisionRepository,
    private readonly acceptance: ProductDecisionAcceptanceService,
    private readonly outbox: OutboxRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async handleInteraction(operation: InteractionOperation): Promise<InteractionResult> {
    const response = operation.response
    if (response.kind !== 'feature_action' || response.feature !== 'decision') {
      return this.delegate.handleInteraction(operation)
    }
    if (response.action === 'accept') return this.accept(operation, response)
    if (!['edit', 'data', 'reject'].includes(response.action)) {
      return this.ack(operation, response, 'Неизвестное действие')
    }
    const action = response.action as 'edit' | 'data' | 'reject'
    const changed = this.decisions.beginDraftAction({
      token: response.token,
      chatId: response.chatId,
      action,
      operationKey: operation.operationKey,
      nowMs: this.now(),
    })
    if (changed.outcome === 'not_found' || changed.draft === null) {
      return this.closeCard(operation, response, 'Эта версия не найдена.', 'Версия не найдена')
    }
    if (changed.outcome === 'closed') {
      return this.closeCard(operation, response, 'Эта версия уже закрыта или заменена новой.', 'Версия устарела')
    }
    const text = action === 'reject'
      ? `❌ Версия v${changed.draft.version} отклонена. Решение не принято и в Git не записано.`
      : action === 'data'
        ? `📊 Версия v${changed.draft.version} не принята. Напиши, какие данные собрать или какой факт проверить.`
        : `✏️ Версия v${changed.draft.version} закрыта. Пришли исправление обычным сообщением — бот покажет новую версию с новым SHA.`
    return this.closeCard(operation, response, text, action === 'reject' ? 'Отклонено' : 'Жду продолжение')
  }

  private accept(operation: InteractionOperation, response: FeatureAction): InteractionResult {
    const accepted = this.acceptance.accept({
      token: response.token,
      chatId: response.chatId,
      operationKey: operation.operationKey,
      acceptanceUpdateId: `telegram:${operation.updateId}`,
      acceptanceMessageId: String(response.callbackMessageId),
      acceptanceCallbackQueryId: response.callbackQueryId,
    })
    if (accepted.outcome === 'accepted') {
      return this.closeCard(
        operation,
        response,
        [
          `✅ Принято и зафиксировано: ${accepted.result.decisionId}.`,
          `Git commit: ${accepted.result.gitCommit}`,
          accepted.result.pushed
            ? 'Карточка отправлена в приватный Git.'
            : 'Карточка зафиксирована локально; push отключён конфигурацией.',
          'Код и работающий сервис не изменялись.',
        ].join('\n'),
        accepted.result.decisionId,
      )
    }
    if (accepted.outcome === 'failed') {
      const card = renderProductDecisionCard({
        brief: accepted.draft.brief,
        version: accepted.draft.version,
        hash: accepted.draft.briefSha256,
      })
      const edit = this.outbox.enqueue({
        sourceKey: `${operation.operationKey}:decision-error`,
        kind: 'edit',
        payload: {
          chatId: response.chatId,
          messageId: response.callbackMessageId,
          text: `${card}\n\n⚠️ Запись не выполнена: ${accepted.error}`,
          options: {
            reply_markup: {
              inline_keyboard: productDecisionButtons(
                accepted.draft.token,
                accepted.draft.version,
              ).map((row) => row.map((button) => ({
                text: button.text,
                callback_data: 'callbackData' in button ? button.callbackData : '',
              }))),
            },
          },
        },
        createdAtMs: this.now(),
      })
      this.enqueueAck(operation, response, 'Не записано; можно повторить')
      return { deliveryJobId: edit.job.id }
    }
    return this.closeCard(
      operation,
      response,
      'Эта версия уже закрыта или заменена новой.',
      'Версия устарела',
    )
  }

  private closeCard(
    operation: InteractionOperation,
    response: FeatureAction,
    text: string,
    toast: string,
  ): InteractionResult {
    const edit = this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:decision-edit`,
      kind: 'edit',
      payload: {
        chatId: response.chatId,
        messageId: response.callbackMessageId,
        text,
        options: { reply_markup: { inline_keyboard: [] } },
      },
      createdAtMs: this.now(),
    })
    this.enqueueAck(operation, response, toast)
    return { deliveryJobId: edit.job.id }
  }

  private ack(
    operation: InteractionOperation,
    response: FeatureAction,
    text: string,
  ): InteractionResult {
    return { deliveryJobId: this.enqueueAck(operation, response, text) }
  }

  private enqueueAck(operation: InteractionOperation, response: FeatureAction, text: string): string {
    return this.outbox.enqueue({
      sourceKey: `${operation.operationKey}:decision-ack`,
      kind: 'reaction',
      payload: {
        action: 'answer_callback',
        callbackQueryId: response.callbackQueryId,
        text,
      },
      createdAtMs: this.now(),
      expiresAtMs: this.now() + 30_000,
    }).job.id
  }
}
