export type InboxState = 'RECEIVED' | 'LEASED' | 'PROCESSED' | 'RETRY_WAIT' | 'FAILED'

export interface TelegramUpdateInput {
  botId: string
  updateId: number
  chatId?: string | null
  payload: unknown
  receivedAtMs?: number
}

export interface InboxUpdate {
  id: number
  botId: string
  updateId: number
  chatId: string | null
  payload: unknown
  state: InboxState
  attemptCount: number
  availableAtMs: number
  leaseOwner: string | null
  leaseExpiresAtMs: number | null
  receivedAtMs: number
  processedAtMs: number | null
  lastError: string | null
}

export interface IngestResult {
  created: boolean
  update: InboxUpdate
}

export interface LeaseOptions {
  workerId: string
  nowMs: number
  leaseDurationMs: number
}

export interface InboxRepository {
  ingest(input: TelegramUpdateInput): IngestResult
  get(id: number): InboxUpdate | null
  claimNext(options: LeaseOptions): InboxUpdate | null
  markProcessed(id: number, workerId: string, nowMs: number): InboxUpdate
  retry(id: number, workerId: string, error: string, availableAtMs: number): InboxUpdate
  fail(id: number, workerId: string, error: string, nowMs: number): InboxUpdate
  recoverExpiredLeases(nowMs: number): number
}

export type DeliveryKind = 'send_text' | 'send_media' | 'send_album' | 'edit' | 'delete' | 'reaction'
export type DeliveryState =
  | 'PENDING'
  | 'LEASED'
  | 'RETRY_WAIT'
  | 'DELIVERED'
  | 'AMBIGUOUS'
  | 'FAILED'
  | 'EXPIRED'
  | 'ARCHIVED'

export interface DeliveryJobInput {
  id?: string
  sourceKey: string
  sessionId?: string | null
  kind: DeliveryKind
  payload: unknown
  availableAtMs?: number
  expiresAtMs?: number | null
  createdAtMs?: number
}

export interface DeliveryJob {
  id: string
  sourceKey: string
  sessionId: string | null
  kind: DeliveryKind
  payload: unknown
  state: DeliveryState
  attemptCount: number
  availableAtMs: number
  expiresAtMs: number | null
  leaseOwner: string | null
  leaseExpiresAtMs: number | null
  sendStartedAtMs: number | null
  remoteId: string | null
  lastError: string | null
  createdAtMs: number
  updatedAtMs: number
  deliveredAtMs: number | null
}

export interface EnqueueResult {
  created: boolean
  job: DeliveryJob
}

export interface LeaseFailure {
  job: DeliveryJob
  becameAmbiguous: boolean
}

export interface RecoveryResult {
  retryable: number
  ambiguous: number
  expired: number
}

export interface OutboxRepository {
  enqueue(input: DeliveryJobInput): EnqueueResult
  get(id: string): DeliveryJob | null
  getBySourceKey(sourceKey: string): DeliveryJob | null
  claimNext(options: LeaseOptions): DeliveryJob | null
  markSendStarted(id: string, workerId: string, nowMs: number): DeliveryJob
  markDelivered(id: string, workerId: string, remoteId: string, nowMs: number): DeliveryJob
  failLease(id: string, workerId: string, error: string, nowMs: number, retryAtMs?: number): LeaseFailure
  recoverExpiredLeases(nowMs: number): RecoveryResult
}

export class LeaseConflictError extends Error {
  constructor(entity: 'inbox update' | 'delivery job', id: string | number) {
    super(`${entity} ${id} is not leased by this worker`)
    this.name = 'LeaseConflictError'
  }
}
