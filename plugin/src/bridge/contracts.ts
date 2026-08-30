import type { DeliveryJob, DeliveryJobInput, InboxUpdate } from '../durable/contracts.js'

export interface IncomingTextMessage {
  chatId: string
  projectId: string
  text: string
  attachments?: readonly IncomingTelegramAttachment[]
  /** Durable route recovered from the Telegram message being replied to. */
  preferredThreadId?: string
}

export interface IncomingTelegramAttachment {
  kind: 'image' | 'audio' | 'file'
  fileId: string
  uniqueId: string | null
  fileName: string | null
  mimeType: string
  declaredSize: number | null
  transcribe?: boolean
}

export interface AgentLocalAttachment {
  kind: 'image' | 'audio' | 'file'
  path: string
  fileName: string
  mimeType: string
  size: number
  sha256: string
}

export interface PreparedIncomingMessage {
  chatId: string
  projectId: string
  text: string
  attachments: readonly AgentLocalAttachment[]
  preferredThreadId?: string
}

export type InboundMessagePreparation =
  | { outcome: 'accepted'; message: PreparedIncomingMessage }
  | { outcome: 'rejected'; text: string }

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
  | 'model'
  | 'effort'
  | 'sandbox'
  | 'approval'
  | 'cwd'
  | 'settings'
  | 'auth'
  | 'login'
  | 'groq'
  | 'limits'
  | 'usage'
  | 'version'
  | 'sessions'
  | 'attach'
  | 'handback'
  | 'rename'
  | 'unarchive'
  | 'fork'
  | 'compact'
  | 'diff'
  | 'file'
  | 'review'
  | 'plan'

export interface IncomingCommand {
  chatId: string
  projectId: string
  name: PersonalAlphaCommandName
  args: string
  messageId?: number
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
  | {
      kind: 'mcp_elicitation_action'
      chatId: string
      token: string
      action: 'accept' | 'decline' | 'cancel'
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'mcp_elicitation_option'
      chatId: string
      token: string
      fieldIndex: number
      optionIndex: number
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'mcp_elicitation_done' | 'mcp_elicitation_skip'
      chatId: string
      token: string
      fieldIndex: number
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'mcp_elicitation_text'
      chatId: string
      token: string
      fieldIndex: number
      text: string
    }
  | {
      kind: 'feature_action'
      feature: 'settings' | 'busy' | 'plan' | 'onboarding' | 'git'
      chatId: string
      token: string
      action: string
      callbackQueryId: string
      callbackMessageId: number
    }
  | {
      kind: 'guided_plan_revision'
      chatId: string
      token: string
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
  buttons?: readonly (readonly CommandButton[])[]
  sensitiveInput?: boolean
  deleteSourceMessage?: boolean
}

export type CommandButton =
  | { text: string; callbackData: string }
  | { text: string; url: string }

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
  attachments?: readonly AgentLocalAttachment[]
  preferredThreadId?: string
  /** Internal-only policy tightening; never populated from Telegram payloads. */
  trustedSettingsOverride?: AgentTurnSettings
}

export interface AgentGeneratedImageArtifact {
  kind: 'generated_image'
  /** Absolute path reported by the trusted Codex App Server. */
  path: string
}

export type AgentTurnArtifact = AgentGeneratedImageArtifact

export interface TextTurnResult {
  threadId: string
  turnId: string
  finalText: string
  artifacts?: readonly AgentTurnArtifact[]
  buttons?: readonly (readonly CommandButton[])[]
  presentation?: 'answer' | 'busy_choice' | 'guided_plan'
}

export type AgentApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type AgentSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface AgentTurnSettings {
  model?: string
  effort?: string
  sandbox?: AgentSandboxMode
  approvalPolicy?: AgentApprovalPolicy
}

export interface AgentExecutionPolicy {
  writableRoots: readonly string[]
  networkAccess: boolean
}

export interface AgentModel {
  id: string
  model: string
  displayName: string
  isDefault: boolean
  supportedEfforts: string[]
  defaultEffort: string | null
}

export interface AgentAccountSnapshot {
  kind: 'none' | 'apiKey' | 'chatgpt' | 'amazonBedrock'
  email: string | null
  planType: string | null
  requiresOpenaiAuth: boolean
}

export interface AgentDeviceLogin {
  loginId: string
  verificationUrl: string
  userCode: string
}

export interface AgentRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface AgentRateLimit {
  id: string
  name: string | null
  primary: AgentRateLimitWindow | null
  secondary: AgentRateLimitWindow | null
  planType: string | null
  reachedType: string | null
}

export interface AgentRuntimeDefaults {
  model: string | null
  effort: string | null
}

export interface AgentUsageSnapshot {
  lifetimeTokens: string | null
  peakDailyTokens: string | null
  currentStreakDays: string | null
  recentDaily: readonly { date: string; tokens: string }[]
  thread: {
    id: string
    creditsMicros: string
    usdMicros: string | null
  } | null
}

export interface AgentNativeThread {
  id: string
  cwd: string
  name: string | null
  preview: string
  createdAtSeconds: number
  updatedAtSeconds: number
  status: string
  archived: boolean
}

export type AgentReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title: string | null }
  | { type: 'custom'; instructions: string }

export interface AgentTurnDiff {
  threadId: string
  turnId: string
  diff: string
  updatedAtMs: number
}

export interface AgentArtifactStore {
  recordTurnDiff(diff: AgentTurnDiff): void
  getLatestTurnDiff(threadId: string): AgentTurnDiff | null
}

export interface AgentSettingsProvider {
  getTurnSettings(botId: string, chatId: string, projectId: string): AgentTurnSettings
}

export interface AgentEventDiagnostics {
  recordUnhandledNotification(notification: { method: string; params?: unknown }): void
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
  attachments?: readonly AgentLocalAttachment[]
  settings?: AgentTurnSettings
  executionPolicy?: AgentExecutionPolicy
}

export interface AgentTurnLifecycle {
  onThreadReady?(threadId: string, created: boolean): void | Promise<void>
  onTurnStarted?(threadId: string, turnId: string): void | Promise<void>
  onProgress?(progress: AgentTurnProgress): void | Promise<void>
}

export type AgentActivity =
  | 'starting'
  | 'reasoning'
  | 'planning'
  | 'command'
  | 'file_change'
  | 'mcp'
  | 'web_search'
  | 'image'
  | 'compacting'
  | 'working'

export type AgentTurnProgress =
  | {
      kind: 'activity'
      threadId: string
      turnId: string
      activity: AgentActivity
      atMs: number
    }
  | {
      kind: 'plan'
      threadId: string
      turnId: string
      completed: number
      total: number
      atMs: number
    }
  | {
      kind: 'usage'
      threadId: string
      turnId: string
      /** Tokens used by the latest model call, not the cumulative thread counter. */
      totalTokens: number
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
      /** Monotonic usage counter for the whole native Codex thread. */
      threadTotalTokens: number
      contextWindow: number | null
      atMs: number
    }

export interface AgentTurnUxObserver {
  onPreparing(operation: TextTurnOperation, settings: AgentTurnSettings): void
  onThreadReady(operation: TextTurnOperation, threadId: string): void
  onTurnStarted(operation: TextTurnOperation, threadId: string, turnId: string): void
  onProgress(operation: TextTurnOperation, progress: AgentTurnProgress): void
  onCompleted(operation: TextTurnOperation, result: TextTurnResult): void
  onTerminal(
    operation: TextTurnOperation,
    state: 'FAILED' | 'INTERRUPTED' | 'UNKNOWN',
    errorName: string,
  ): void
}

export interface AgentUxStatusSnapshot {
  phase: 'PREPARING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN'
  activity: AgentActivity
  planCompleted: number
  planTotal: number
  totalTokens: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  threadTotalTokens: number | null
  contextWindow: number | null
  updatedAtMs: number
}

export interface AgentUxStatusProvider {
  getStatus(botId: string, chatId: string, projectId: string): AgentUxStatusSnapshot | null
}

export type AgentTurnInspection =
  | { state: 'COMPLETED'; result: TextTurnResult }
  | { state: 'FAILED'; turnId: string }
  | { state: 'INTERRUPTED'; turnId: string }
  | {
      state: 'UNKNOWN'
      turnId: string | null
      reason:
        | 'turn_not_found'
        | 'turn_in_progress'
        | 'missing_final_message'
        | 'inspection_failed'
    }

export interface AgentTurnInspectionInput {
  threadId: string
  turnId: string | null
  operationKey: string
}

export interface AgentBackend {
  listModels(): Promise<AgentModel[]>
  runTextTurn(input: AgentTextTurnInput, lifecycle?: AgentTurnLifecycle): Promise<TextTurnResult>
  inspectTurn?(input: AgentTurnInspectionInput): Promise<AgentTurnInspection>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  steerTurn(input: {
    operationKey: string
    threadId: string
    turnId: string
    text: string
  }): Promise<void>
  readAccount?(): Promise<AgentAccountSnapshot>
  startDeviceLogin?(): Promise<AgentDeviceLogin>
  readRateLimits?(): Promise<AgentRateLimit[]>
  readRuntimeDefaults?(cwd?: string): Promise<AgentRuntimeDefaults>
  readUsage?(threadId?: string): Promise<AgentUsageSnapshot>
  listNativeThreads?(input: {
    cwd: readonly string[]
    archived?: boolean
    search?: string
  }): Promise<AgentNativeThread[]>
  renameThread?(threadId: string, name: string): Promise<void>
  archiveNativeThread?(threadId: string): Promise<void>
  unarchiveNativeThread?(threadId: string): Promise<void>
  forkNativeThread?(threadId: string, cwd: string): Promise<string>
  compactThread?(threadId: string): Promise<void>
  runReview?(input: {
    operationKey: string
    threadId: string
    target: AgentReviewTarget
  }): Promise<TextTurnResult>
  getLatestDiff?(threadId: string): AgentTurnDiff | null
  getActiveTurn?(threadId: string): string | null
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

export interface FinalArtifactDelivery extends FinalTextDelivery {
  /** Optional delivery that must be proven before the first artifact is sent. */
  dependsOnSourceKey?: string
}

export interface TurnCompletionReporter {
  buildTurnCompletionDeliveries(
    input: FinalArtifactDelivery,
  ): Promise<readonly DeliveryJobInput[]>
}

export interface CommandDelivery {
  update: InboxUpdate
  command: IncomingCommand
  result: CommandResult
  sourceKey: string
  nowMs: number
}

export interface InboundRejectionDelivery {
  update: InboxUpdate
  message: IncomingTextMessage
  text: string
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
  prepareInboundMessage?(
    update: InboxUpdate,
    message: IncomingTextMessage,
  ): Promise<InboundMessagePreparation>
  extractCommand?(update: InboxUpdate): IncomingCommand | null
  extractInteractionResponse?(update: InboxUpdate): IncomingInteractionResponse | null
  buildFinalTextDeliveries(input: FinalTextDelivery): readonly DeliveryJobInput[]
  buildFinalArtifactDeliveries?(
    input: FinalArtifactDelivery,
  ): Promise<readonly DeliveryJobInput[]>
  buildInboundRejectionDelivery?(input: InboundRejectionDelivery): DeliveryJobInput
  buildCommandDelivery?(input: CommandDelivery): DeliveryJobInput
  buildCommandCleanupDelivery?(input: CommandDelivery): DeliveryJobInput
  prepareDelivery(job: DeliveryJob): Promise<PreparedDelivery>
  executeDelivery(prepared: PreparedDelivery): Promise<DeliveryProof>
  recordDelivery?(job: DeliveryJob, proof: DeliveryProof, deliveredAtMs: number): void
}
