export type DomainId =
  | 'capacity'
  | 'commercial'
  | 'lifecycle'
  | 'customer-experience'
  | 'surfaces'
  | 'legal'

export type ImplementationStatus = 'not_implemented' | 'partial' | 'aligned' | 'unknown'

export interface ImplementationEvidenceCheck {
  name: string
  command: string
  outcome: 'pass' | 'fail' | 'not_run'
  evidence: string
}

export interface ImplementationCheck {
  checkedAt: string
  checkedBy: string
  repository: string
  checkedCommit: string
  implementationCommits: string[]
  scopePaths: string[]
  verdict: ImplementationStatus
  summary: string
  checks: ImplementationEvidenceCheck[]
}

export interface DecisionHistoryEntry {
  id: string
  title: string
  decidedAt: string
  reason: string
  lifecycle: 'active' | 'superseded'
  supersedes: string | null
  supersededBy: string | null
  implementationStatus: ImplementationStatus
  implementationCheckedAt: string | null
}

export interface DomainSummary {
  id: DomainId
  title: string
  count: number
  activeCount: number
  reviewDueCount: number
}

export interface DecisionSummary {
  id: string
  policyKey: string
  domain: DomainId
  domainTitle: string
  title: string
  decision: string
  reason: string
  affected: string[]
  decidedAt: string
  decidedBy: string
  reviewAt: string | null
  reviewDue: boolean
  supersedes: string | null
  supersededBy: string | null
  lifecycle: 'active' | 'superseded'
  implementationStatus: ImplementationStatus
  implementationCheckedAt: string | null
  implementationSummary: string
  originStored: boolean
}

export interface DecisionDetail extends DecisionSummary {
  briefVersion: number
  briefSha256: string
  definitions: string
  alternatives: string
  evidence: string
  verification: string
  implementation: string
  implementationCheck: ImplementationCheck | null
  implementationChecks: ImplementationCheck[]
  source: {
    telegramUpdateId: string
    telegramMessageId: string
    telegramAcceptanceUpdateId: string
    telegramAcceptanceMessageId: string
    telegramAcceptanceCallbackQueryId: string
    codexThreadId: string
    codexTurnId: string
  }
  history: string[]
  policyHistory: DecisionHistoryEntry[]
}

export interface DecisionsResponse {
  decisions: DecisionSummary[]
  total: number
  domains: DomainSummary[]
  stats: { active: number; reviewDue: number; superseded: number }
}
