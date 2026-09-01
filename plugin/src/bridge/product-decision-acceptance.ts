import type {
  ProductDecisionDraftRecord,
  ProductDecisionFlowRecord,
  SqliteProductDecisionRepository,
} from '../durable/product-decision-repository.js'
import type {
  ProductDecisionWriteResult,
  ProductDecisionWriter,
} from './product-decision-writer.js'

export type ProductDecisionAcceptanceOutcome =
  | { outcome: 'accepted'; flow: ProductDecisionFlowRecord; draft: ProductDecisionDraftRecord; result: ProductDecisionWriteResult }
  | { outcome: 'closed' | 'not_found'; flow: ProductDecisionFlowRecord | null; draft: ProductDecisionDraftRecord | null }
  | { outcome: 'failed'; flow: ProductDecisionFlowRecord; draft: ProductDecisionDraftRecord; error: string }

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Неизвестная ошибка записи'
  return raw.trim().split('\n')[0]?.slice(0, 500) || 'Неизвестная ошибка записи'
}

export class ProductDecisionAcceptanceService {
  constructor(
    private readonly decisions: SqliteProductDecisionRepository,
    private readonly writer: ProductDecisionWriter,
    private readonly now: () => number = Date.now,
  ) {}

  accept(input: {
    token: string
    chatId: string
    operationKey: string
    acceptanceUpdateId: string
    acceptanceMessageId: string
    acceptanceCallbackQueryId: string
  }): ProductDecisionAcceptanceOutcome {
    const began = this.decisions.beginAcceptance({ ...input, nowMs: this.now() })
    if (began.flow === null || began.draft === null) {
      return { outcome: 'not_found', flow: null, draft: null }
    }
    if (began.outcome === 'accepted') {
      if (began.draft.decisionId === null || began.draft.gitCommit === null) {
        return { outcome: 'closed', flow: began.flow, draft: began.draft }
      }
      return {
        outcome: 'accepted',
        flow: began.flow,
        draft: began.draft,
        result: {
          decisionId: began.draft.decisionId,
          gitCommit: began.draft.gitCommit,
          pushed: began.draft.pushed === true,
          path: '',
        },
      }
    }
    if (began.outcome === 'closed') {
      return { outcome: 'closed', flow: began.flow, draft: began.draft }
    }
    try {
      const result = this.writer.write(began.flow, began.draft)
      const completed = this.decisions.completeAcceptance({
        draftId: began.draft.id,
        decisionId: result.decisionId,
        gitCommit: result.gitCommit,
        pushed: result.pushed,
        nowMs: this.now(),
      })
      return { outcome: 'accepted', flow: began.flow, draft: completed, result }
    } catch (error) {
      const message = safeError(error)
      const failed = this.decisions.failAcceptance(began.draft.id, message, this.now())
      return { outcome: 'failed', flow: began.flow, draft: failed, error: message }
    }
  }
}
