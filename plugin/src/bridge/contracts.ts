import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'

export interface IncomingTextMessage {
  chatId: string
  projectId: string
  text: string
}

export type PersonalAlphaCommandName =
  | 'start'
  | 'new'
  | 'status'
  | 'stop'
  | 'steer'
  | 'failed'
  | 'ambiguous'
  | 'retry'
  | 'resolved'
  | 'archive'
  | 'threads'
  | 'switch'
  | 'resume'

export interface IncomingCommand {
  chatId: string
  projectId: string
  name: PersonalAlphaCommandName
  args: string
}

export type IncomingInteractionResponse =
  | {
      kind: 'approval'
      chatId: string
      token: string
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'user_input_option'
      chatId: string
      token: string
      questionIndex: number
      optionIndex: number
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'user_input_text'
      chatId: string
      token: string
      questionIndex: number
      text: string
    }

export interface InteractionOperation {
  operationKey: string
  botId: string
  inboxUpdateId: number
  updateId: number
  response: IncomingInteractionResponse
}

export interface InteractionResult {
  deliveryJobId: string | null
}

export interface InteractionHandler {
  handleInteraction(operation: InteractionOperation): Promise<InteractionResult>
}

export interface CommandOperation {
  operationKey: string
  botId: string
  inboxUpdateId: number
  updateId: number
  command: IncomingCommand
}

export interface CommandResult {
  text: string
}

export interface CommandHandler {
  handleCommand(operation: CommandOperation): Promise<CommandResult>
}

export interface TextTurnOperation {
  operationKey: string
  inboxUpdateId: number
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
  cwd: string
  text: string
}

export interface AgentTurnLifecycle {
  onThreadReady?(threadId: string, created: boolean): void | Promise<void>
  onTurnStarted?(threadId: string, turnId: string): void | Promise<void>
}

export interface AgentBackend {
  runTextTurn(input: AgentTextTurnInput, lifecycle?: AgentTurnLifecycle): Promise<TextTurnResult>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  steerTurn(input: {
    operationKey: string
    threadId: string
    turnId: string
    text: string
  }): Promise<void>
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

export interface CommandDelivery {
  update: InboxUpdate
  command: IncomingCommand
  result: CommandResult
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
  extractCommand?(update: InboxUpdate): IncomingCommand | null
  extractInteractionResponse?(update: InboxUpdate): IncomingInteractionResponse | null
  buildFinalTextDelivery(input: FinalTextDelivery): DeliveryJobInput
  buildCommandDelivery?(input: CommandDelivery): DeliveryJobInput
  prepareDelivery(job: DeliveryJob): Promise<PreparedDelivery>
  executeDelivery(prepared: PreparedDelivery): Promise<DeliveryProof>
}
