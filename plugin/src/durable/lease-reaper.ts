import type { InboxRepository, OutboxRepository, RecoveryResult } from './contracts.js'

export interface LeaseRecoverySweep {
  inboxRecovered: number
  outbox: RecoveryResult
}

export interface DurableLeaseReaperOptions {
  now?: () => number
}

export class DurableLeaseReaper {
  private readonly now: () => number

  constructor(
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    options: DurableLeaseReaperOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  runOnce(): LeaseRecoverySweep {
    const nowMs = this.now()
    return {
      inboxRecovered: this.inbox.recoverExpiredLeases(nowMs),
      outbox: this.outbox.recoverExpiredLeases(nowMs),
    }
  }
}
