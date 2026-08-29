import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'

export interface IncomingTextMessage {
  chatId: string
  projectId: string
  text: string
}

export interface TextTurnOperation {
  operationKey: string
  botId: string
  updateId: number
  chatId: string
  projectId: string
  text: string
}

export interface TextTurnResult {
  threadId: string
  turnId: string
  finalText: string
}

/**
 * Owns durable session/thread binding and must treat operationKey as
 * idempotent. Replaying the same operation after a bridge crash must reconcile
 * the original turn, not start an unrelated second turn.
 */
export interface SessionCoordinator {
  runTextTurn(operation: TextTurnOperation): Promise<TextTurnResult>
}

export interface AgentTextTurnInput {
  operationKey: string
  threadId: string | null
  projectId: string
  text: string
}

export interface AgentBackend {
  runTextTurn(input: AgentTextTurnInput): Promise<TextTurnResult>
  interruptTurn(threadId: string, turnId: string): Promise<void>
}

export interface DeliveryProof {
  remoteId: string
}

export interface FinalTextDelivery {
  update: InboxUpdate
  message: IncomingTextMessage
  result: TextTurnResult
  sourceKey: string
  nowMs: number
}

/**
 * The only Telegram boundary used by the durable workers. prepareDelivery may
 * validate payloads or fetch retry-safe media. executeDelivery performs the
 * remote mutation and is called only after send_started_at is persisted.
 */
export interface TelegramGateway<PreparedDelivery = unknown> {
  extractText(update: InboxUpdate): IncomingTextMessage | null
  buildFinalTextDelivery(input: FinalTextDelivery): DeliveryJobInput
  prepareDelivery(job: DeliveryJob): Promise<PreparedDelivery>
  executeDelivery(prepared: PreparedDelivery): Promise<DeliveryProof>
}
