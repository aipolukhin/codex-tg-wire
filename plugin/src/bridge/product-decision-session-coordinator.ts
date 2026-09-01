import type {
  ProductDecisionFlowRecord,
  SqliteProductDecisionRepository,
} from '../durable/product-decision-repository.js'
import type {
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from './contracts.js'
import type { ProductDecisionAcceptanceService } from './product-decision-acceptance.js'
import {
  acceptedProductDecisionVersion,
  parseProductDecisionResult,
  productDecisionAgentInstruction,
  productDecisionButtons,
  productDecisionHash,
  productDecisionMode,
  renderProductDecisionCard,
} from './product-decision.js'

function acceptanceSummary(
  decisionId: string,
  gitCommit: string,
  pushed: boolean,
): string {
  return [
    `✅ Принято и зафиксировано: ${decisionId}.`,
    `Git commit: ${gitCommit}`,
    pushed ? 'Карточка отправлена в приватный Git.' : 'Карточка зафиксирована локально; push отключён конфигурацией.',
    'Код и работающий сервис не изменялись.',
  ].join('\n')
}

export class ProductDecisionSessionCoordinator implements SessionCoordinator {
  constructor(
    private readonly delegate: SessionCoordinator,
    private readonly decisions: SqliteProductDecisionRepository,
    private readonly acceptance: ProductDecisionAcceptanceService,
    private readonly now: () => number = Date.now,
  ) {}

  async runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult> {
    const mode = productDecisionMode(operation.text)
    let flow = this.decisions.getOpenFlow(
      operation.botId,
      operation.chatId,
      operation.projectId,
    )

    if (mode === null && flow?.state === 'AWAITING_ACCEPTANCE') {
      const acceptedVersion = acceptedProductDecisionVersion(operation.text)
      if (acceptedVersion !== null) return this.acceptByText(operation, flow, acceptedVersion)
    }

    if (mode === null && flow === null) return this.delegate.runTextTurn(operation)
    if (flow?.state === 'ACCEPTING') {
      return {
        threadId: flow.threadId,
        turnId: flow.lastTurnId,
        finalText: 'Карточка уже фиксируется в Git. Дождись результата текущего принятия.',
        presentation: 'product_decision',
      }
    }

    let previousBrief = flow === null
      ? null
      : this.decisions.getCurrentDraft(flow)?.brief ?? this.decisions.getLatestDraft(flow.id)?.brief ?? null
    if (mode !== null && flow !== null) {
      this.decisions.replaceFlow(flow.id, operation.operationKey, this.now())
      flow = null
      previousBrief = null
    } else if (flow?.state === 'AWAITING_ACCEPTANCE') {
      this.decisions.invalidateCurrentDraft(flow.id, 'edit', operation.operationKey, this.now())
      flow = this.decisions.getFlow(flow.id)
    }

    const activeMode = mode ?? flow?.mode
    if (activeMode === undefined) return this.delegate.runTextTurn(operation)
    const version = (flow?.currentVersion ?? 0) + 1
    const decisionTurn = await this.delegate.runTextTurn({
      ...operation,
      operationKey: `${operation.operationKey}:product-decision:v${version}`,
      text: productDecisionAgentInstruction({
        mode: activeMode,
        version,
        currentBrief: previousBrief,
        ownerText: operation.text,
      }),
      ...(flow === null ? {} : { preferredThreadId: flow.threadId }),
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    const parsed = parseProductDecisionResult(decisionTurn.finalText)
    if (flow === null) {
      flow = this.decisions.createFlow({
        sourceOperationKey: operation.operationKey,
        botId: operation.botId,
        chatId: operation.chatId,
        projectId: operation.projectId,
        mode: activeMode,
        sourceUpdateId: String(operation.updateId),
        sourceMessageId: operation.sourceMessageId === undefined
          ? 'unknown'
          : String(operation.sourceMessageId),
        threadId: decisionTurn.threadId,
        turnId: decisionTurn.turnId,
        nowMs: this.now(),
      })
    } else {
      this.decisions.updateConversation(flow.id, decisionTurn.threadId, decisionTurn.turnId, this.now())
      flow = this.decisions.getFlow(flow.id) as ProductDecisionFlowRecord
    }

    if (parsed.brief === null) {
      const { buttons: _buttons, ...plainDecisionTurn } = decisionTurn
      const error = parsed.error === null
        ? ''
        : `\n\n⚠️ Карточка не показана: ${parsed.error}. Я должен подготовить новую корректную версию.`
      return {
        ...plainDecisionTurn,
        finalText: `${parsed.visibleText}${error}`.trim(),
        presentation: 'product_decision',
      }
    }
    const draft = this.decisions.storeDraft({
      flowId: flow.id,
      turnId: decisionTurn.turnId,
      brief: parsed.brief,
      briefSha256: productDecisionHash(parsed.brief),
      nowMs: this.now(),
    })
    return {
      ...decisionTurn,
      finalText: renderProductDecisionCard({
        brief: draft.brief,
        version: draft.version,
        hash: draft.briefSha256,
      }),
      buttons: productDecisionButtons(draft.token, draft.version),
      presentation: 'product_decision',
    }
  }

  private acceptByText(
    operation: TextTurnOperation,
    flow: ProductDecisionFlowRecord,
    version: number,
  ): TextTurnResult {
    const draft = this.decisions.getCurrentDraft(flow)
    if (draft === null || draft.version !== version) {
      return {
        threadId: flow.threadId,
        turnId: flow.lastTurnId,
        finalText: `Нельзя принять v${version}: актуальная версия — v${flow.currentVersion}.`,
        presentation: 'product_decision',
      }
    }
    const accepted = this.acceptance.accept({
      token: draft.token,
      chatId: operation.chatId,
      operationKey: `${operation.operationKey}:product-decision:accept`,
      acceptanceUpdateId: `telegram:${operation.updateId}`,
      acceptanceMessageId: operation.sourceMessageId === undefined
        ? 'unknown'
        : String(operation.sourceMessageId),
      acceptanceCallbackQueryId: 'unknown',
    })
    if (accepted.outcome === 'accepted') {
      return {
        threadId: flow.threadId,
        turnId: flow.lastTurnId,
        finalText: acceptanceSummary(
          accepted.result.decisionId,
          accepted.result.gitCommit,
          accepted.result.pushed,
        ),
        presentation: 'product_decision',
      }
    }
    if (accepted.outcome === 'failed') {
      return {
        threadId: flow.threadId,
        turnId: flow.lastTurnId,
        finalText: `⚠️ Карточка не зафиксирована: ${accepted.error}. Версия v${version} остаётся доступна для повторного принятия.`,
        buttons: productDecisionButtons(draft.token, draft.version),
        presentation: 'product_decision',
      }
    }
    return {
      threadId: flow.threadId,
      turnId: flow.lastTurnId,
      finalText: 'Эта версия уже закрыта или заменена новой.',
      presentation: 'product_decision',
    }
  }
}
