import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

export const PRODUCT_HOME_DOMAINS = [
  { id: 'capacity', title: 'Capacity' },
  { id: 'commercial', title: 'Commercial' },
  { id: 'lifecycle', title: 'Lifecycle' },
  { id: 'customer-experience', title: 'Customer experience' },
  { id: 'surfaces', title: 'Surfaces' },
  { id: 'legal', title: 'Legal and claims' },
] as const

export type ProductHomeDomain = typeof PRODUCT_HOME_DOMAINS[number]['id']
export type DecisionLifecycle = 'active' | 'superseded'
export type DecisionImplementationStatus =
  | 'not_implemented'
  | 'partial'
  | 'aligned'
  | 'unknown'

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
  verdict: DecisionImplementationStatus
  summary: string
  checks: ImplementationEvidenceCheck[]
}

export interface DecisionHistoryEntry {
  id: string
  title: string
  decidedAt: string
  reason: string
  lifecycle: DecisionLifecycle
  supersedes: string | null
  supersededBy: string | null
  implementationStatus: DecisionImplementationStatus
  implementationCheckedAt: string | null
}

export interface DecisionSource {
  telegramUpdateId: string
  telegramMessageId: string
  telegramAcceptanceUpdateId: string
  telegramAcceptanceMessageId: string
  telegramAcceptanceCallbackQueryId: string
  codexThreadId: string
  codexTurnId: string
}

export interface DecisionSummary {
  id: string
  policyKey: string
  domain: ProductHomeDomain
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
  lifecycle: DecisionLifecycle
  implementationStatus: DecisionImplementationStatus
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
  source: DecisionSource
  history: string[]
  policyHistory: DecisionHistoryEntry[]
}

interface ParsedDecision extends Omit<DecisionDetail, 'history' | 'policyHistory'> {
  searchText: string
}

export interface DomainSummary {
  id: ProductHomeDomain
  title: string
  count: number
  activeCount: number
  reviewDueCount: number
}

export interface DecisionRegistrySnapshot {
  decisions: DecisionDetail[]
  domains: DomainSummary[]
  stats: {
    active: number
    reviewDue: number
    superseded: number
  }
}

export class ProductHomeRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductHomeRegistryError'
  }
}

export interface ProductDecisionRegistryOptions {
  repositoryPath: string
  nowMs?: () => number
}

const MAX_CARD_BYTES = 1024 * 1024
const MAX_IMPLEMENTATION_CHECK_BYTES = 256 * 1024
const IMPLEMENTATION_CHECK_FIELDS = new Set([
  'schema',
  'decision_id',
  'checked_at',
  'checked_by',
  'repository',
  'checked_commit',
  'implementation_commits',
  'scope_paths',
  'verdict',
  'summary',
  'checks',
])
const IMPLEMENTATION_EVIDENCE_FIELDS = new Set(['name', 'command', 'outcome', 'evidence'])
const SOURCE_FIELDS = [
  'telegram_update_id',
  'telegram_message_id',
  'telegram_acceptance_update_id',
  'telegram_acceptance_message_id',
  'telegram_acceptance_callback_query_id',
  'codex_thread_id',
  'codex_turn_id',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProductHomeRegistryError(`${path}: ${key} must be a non-empty string`)
  }
  return value.trim()
}

function exactFields(record: Record<string, unknown>, fields: ReadonlySet<string>, path: string): void {
  const missing = [...fields].filter((field) => !(field in record))
  const unknown = Object.keys(record).filter((field) => !fields.has(field))
  if (missing.length > 0 || unknown.length > 0) {
    throw new ProductHomeRegistryError(`${path}: implementation-check fields are invalid`)
  }
}

function requiredStrings(
  record: Record<string, unknown>,
  key: string,
  path: string,
  maximum = 100,
): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ProductHomeRegistryError(`${path}: ${key} must be an array`)
  }
  const strings = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ProductHomeRegistryError(`${path}: ${key}[${index}] must be a non-empty string`)
    }
    return item.trim()
  })
  if (new Set(strings).size !== strings.length) {
    throw new ProductHomeRegistryError(`${path}: ${key} contains duplicates`)
  }
  return strings
}

function parseImplementationCheck(text: string, filename: string): {
  decisionId: string
  check: ImplementationCheck
} {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProductHomeRegistryError(`${filename}: implementation check is invalid JSON`)
  }
  if (!isRecord(value)) {
    throw new ProductHomeRegistryError(`${filename}: implementation check must be an object`)
  }
  exactFields(value, IMPLEMENTATION_CHECK_FIELDS, filename)
  if (value.schema !== 1) {
    throw new ProductHomeRegistryError(`${filename}: implementation check schema is unsupported`)
  }
  const decisionId = requiredString(value, 'decision_id', filename)
  if (!/^PD-[A-Z]{3}-\d{4}$/.test(decisionId)) {
    throw new ProductHomeRegistryError(`${filename}: implementation decision id is invalid`)
  }
  const checkedAt = requiredString(value, 'checked_at', filename)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) {
    throw new ProductHomeRegistryError(`${filename}: checked_at is invalid`)
  }
  const stamp = checkedAt.replaceAll('-', '').replaceAll(':', '')
  if (filename !== `${decisionId}-${stamp}.json`) {
    throw new ProductHomeRegistryError(`${filename}: filename does not match decision and check time`)
  }
  const checkedCommit = requiredString(value, 'checked_commit', filename)
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(checkedCommit)) {
    throw new ProductHomeRegistryError(`${filename}: checked_commit is invalid`)
  }
  const implementationCommits = requiredStrings(value, 'implementation_commits', filename)
  if (implementationCommits.some((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))) {
    throw new ProductHomeRegistryError(`${filename}: implementation commit is invalid`)
  }
  const scopePaths = requiredStrings(value, 'scope_paths', filename)
  if (scopePaths.some((scope) => scope.startsWith('/') || scope.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw new ProductHomeRegistryError(`${filename}: scope path is unsafe`)
  }
  const verdict = requiredString(value, 'verdict', filename)
  if (!['not_implemented', 'partial', 'aligned', 'unknown'].includes(verdict)) {
    throw new ProductHomeRegistryError(`${filename}: implementation verdict is invalid`)
  }
  const rawChecks = value.checks
  if (!Array.isArray(rawChecks) || rawChecks.length < 1 || rawChecks.length > 100) {
    throw new ProductHomeRegistryError(`${filename}: checks must contain evidence`)
  }
  const checks = rawChecks.map((raw, index): ImplementationEvidenceCheck => {
    if (!isRecord(raw)) {
      throw new ProductHomeRegistryError(`${filename}: checks[${index}] must be an object`)
    }
    exactFields(raw, IMPLEMENTATION_EVIDENCE_FIELDS, filename)
    const outcome = requiredString(raw, 'outcome', filename)
    if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'not_run') {
      throw new ProductHomeRegistryError(`${filename}: checks[${index}] outcome is invalid`)
    }
    return {
      name: requiredString(raw, 'name', filename),
      command: requiredString(raw, 'command', filename),
      outcome,
      evidence: requiredString(raw, 'evidence', filename),
    }
  })
  if ((verdict === 'aligned' || verdict === 'partial') && (implementationCommits.length === 0 || scopePaths.length === 0)) {
    throw new ProductHomeRegistryError(`${filename}: implementation evidence is incomplete`)
  }
  if (verdict === 'aligned' && checks.some((check) => check.outcome !== 'pass')) {
    throw new ProductHomeRegistryError(`${filename}: aligned check contains non-passing evidence`)
  }
  if (verdict === 'partial' && checks.every((check) => check.outcome === 'pass')) {
    throw new ProductHomeRegistryError(`${filename}: partial check has no incomplete evidence`)
  }
  if (verdict === 'not_implemented' && implementationCommits.length > 0) {
    throw new ProductHomeRegistryError(`${filename}: not implemented check names implementation commits`)
  }
  return {
    decisionId,
    check: {
      checkedAt,
      checkedBy: requiredString(value, 'checked_by', filename),
      repository: requiredString(value, 'repository', filename),
      checkedCommit,
      implementationCommits,
      scopePaths,
      verdict: verdict as DecisionImplementationStatus,
      summary: requiredString(value, 'summary', filename),
      checks,
    },
  }
}

function nullableString(record: Record<string, unknown>, key: string, path: string): string | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProductHomeRegistryError(`${path}: ${key} must be a string or null`)
  }
  return value.trim()
}

function parseSections(body: string, path: string): { title: string; sections: Map<string, string> } {
  const title = body.match(/^# (.+?)\s*$/m)?.[1]?.trim()
  if (title === undefined || title.length === 0) {
    throw new ProductHomeRegistryError(`${path}: decision title is missing`)
  }
  const matches = [...body.matchAll(/^## (.+?)\s*$/gm)]
  const sections = new Map<string, string>()
  for (const [index, match] of matches.entries()) {
    const name = match[1]?.trim()
    if (name === undefined || match.index === undefined) continue
    const start = match.index + match[0].length
    const end = matches[index + 1]?.index ?? body.length
    sections.set(name, body.slice(start, end).trim())
  }
  return { title, sections }
}

function requireSection(sections: Map<string, string>, name: string, path: string): string {
  const value = sections.get(name)
  if (value === undefined || value.length === 0) {
    throw new ProductHomeRegistryError(`${path}: section ${name} is missing`)
  }
  return value
}

function plainExcerpt(markdown: string, maxLength = 220): string {
  const plain = markdown
    .replace(/^[-*]\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= maxLength) return plain
  return `${plain.slice(0, maxLength - 1).trimEnd()}…`
}

function bulletValues(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0)
}

function implementationStatus(markdown: string): DecisionImplementationStatus {
  const normalized = markdown.toLocaleLowerCase('ru-RU')
  if (/не\s+реализован/.test(normalized)) return 'not_implemented'
  if (/частичн/.test(normalized)) return 'partial'
  if (/\baligned\b|полностью\s+реализован/.test(normalized)) return 'aligned'
  return 'unknown'
}

function asDomain(value: string, path: string): ProductHomeDomain {
  if (!PRODUCT_HOME_DOMAINS.some((domain) => domain.id === value)) {
    throw new ProductHomeRegistryError(`${path}: unsupported domain ${value}`)
  }
  return value as ProductHomeDomain
}

function parseSource(metadata: Record<string, unknown>, path: string): DecisionSource {
  const raw = metadata.source
  if (!isRecord(raw)) throw new ProductHomeRegistryError(`${path}: source must be an object`)
  for (const field of SOURCE_FIELDS) requiredString(raw, field, path)
  return {
    telegramUpdateId: requiredString(raw, 'telegram_update_id', path),
    telegramMessageId: requiredString(raw, 'telegram_message_id', path),
    telegramAcceptanceUpdateId: requiredString(raw, 'telegram_acceptance_update_id', path),
    telegramAcceptanceMessageId: requiredString(raw, 'telegram_acceptance_message_id', path),
    telegramAcceptanceCallbackQueryId: requiredString(
      raw,
      'telegram_acceptance_callback_query_id',
      path,
    ),
    codexThreadId: requiredString(raw, 'codex_thread_id', path),
    codexTurnId: requiredString(raw, 'codex_turn_id', path),
  }
}

function parseCard(
  text: string,
  relativePath: string,
  nowMs: number,
): ParsedDecision {
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/)
  if (frontMatter?.[1] === undefined || frontMatter[2] === undefined) {
    throw new ProductHomeRegistryError(`${relativePath}: YAML front matter is missing`)
  }
  let rawMetadata: unknown
  try {
    rawMetadata = loadYaml(frontMatter[1], { schema: JSON_SCHEMA })
  } catch {
    throw new ProductHomeRegistryError(`${relativePath}: YAML front matter is invalid`)
  }
  if (!isRecord(rawMetadata)) {
    throw new ProductHomeRegistryError(`${relativePath}: YAML front matter must be an object`)
  }
  if (rawMetadata.status !== 'accepted') {
    throw new ProductHomeRegistryError(`${relativePath}: only accepted decisions may be shown`)
  }
  const domain = asDomain(requiredString(rawMetadata, 'domain', relativePath), relativePath)
  const domainTitle = PRODUCT_HOME_DOMAINS.find((item) => item.id === domain)?.title
  if (domainTitle === undefined) throw new ProductHomeRegistryError(`${relativePath}: domain is unknown`)
  const briefVersion = rawMetadata.brief_version
  if (!Number.isSafeInteger(briefVersion) || (briefVersion as number) < 1) {
    throw new ProductHomeRegistryError(`${relativePath}: brief_version must be positive`)
  }
  const decidedAt = requiredString(rawMetadata, 'decided_at', relativePath)
  const decidedAtMs = Date.parse(decidedAt)
  if (!Number.isFinite(decidedAtMs)) {
    throw new ProductHomeRegistryError(`${relativePath}: decided_at is invalid`)
  }
  const reviewAt = nullableString(rawMetadata, 'review_at', relativePath)
  const reviewAtMs = reviewAt === null ? null : Date.parse(reviewAt)
  if (reviewAtMs !== null && !Number.isFinite(reviewAtMs)) {
    throw new ProductHomeRegistryError(`${relativePath}: review_at is invalid`)
  }

  const { title, sections } = parseSections(frontMatter[2], relativePath)
  const decision = requireSection(sections, 'Решение', relativePath)
  const definitions = requireSection(sections, 'Определения и границы', relativePath)
  const reason = requireSection(sections, 'Почему', relativePath)
  const alternatives = requireSection(sections, 'Альтернативы', relativePath)
  const evidence = requireSection(sections, 'Основания и допущения', relativePath)
  const affectedMarkdown = requireSection(sections, 'Что затронуто', relativePath)
  const verification = requireSection(sections, 'Как проверим', relativePath)
  const implementation = requireSection(sections, 'Реализация', relativePath)
  const source = parseSource(rawMetadata, relativePath)
  const affected = bulletValues(affectedMarkdown)
  const id = requiredString(rawMetadata, 'id', relativePath)
  if (!/^PD-[A-Z]{2,4}-\d{4}$/.test(id)) {
    throw new ProductHomeRegistryError(`${relativePath}: decision id is invalid`)
  }
  const briefSha256 = requiredString(rawMetadata, 'brief_sha256', relativePath)
  if (!/^[0-9a-f]{64}$/.test(briefSha256)) {
    throw new ProductHomeRegistryError(`${relativePath}: brief_sha256 is invalid`)
  }
  const supersedes = nullableString(rawMetadata, 'supersedes', relativePath)
  const searchText = [
    id,
    requiredString(rawMetadata, 'policy_key', relativePath),
    domain,
    domainTitle,
    title,
    frontMatter[2],
    affected.join(' '),
  ].join('\n').toLocaleLowerCase('ru-RU')
  return {
    id,
    policyKey: requiredString(rawMetadata, 'policy_key', relativePath),
    domain,
    domainTitle,
    title,
    decision: plainExcerpt(decision),
    reason: plainExcerpt(reason),
    affected,
    decidedAt,
    decidedBy: requiredString(rawMetadata, 'decided_by', relativePath),
    reviewAt,
    reviewDue: reviewAtMs !== null && reviewAtMs <= nowMs,
    supersedes,
    supersededBy: null,
    lifecycle: 'active',
    implementationStatus: implementationStatus(implementation),
    implementationCheckedAt: null,
    implementationSummary: plainExcerpt(implementation),
    originStored: SOURCE_FIELDS.every((field) => typeof (rawMetadata.source as Record<string, unknown>)[field] === 'string'),
    briefVersion: briefVersion as number,
    briefSha256,
    definitions,
    alternatives,
    evidence,
    verification,
    implementation,
    implementationCheck: null,
    implementationChecks: [],
    source,
    searchText,
  }
}

function summary(decision: DecisionDetail): DecisionSummary {
  const {
    briefVersion: _briefVersion,
    briefSha256: _briefSha256,
    definitions: _definitions,
    alternatives: _alternatives,
    evidence: _evidence,
    verification: _verification,
    implementation: _implementation,
    implementationCheck: _implementationCheck,
    implementationChecks: _implementationChecks,
    source: _source,
    history: _history,
    policyHistory: _policyHistory,
    ...rest
  } = decision
  return rest
}

export class ProductDecisionRegistry {
  private readonly productRoot: string
  private readonly nowMs: () => number

  constructor(options: ProductDecisionRegistryOptions) {
    this.productRoot = join(options.repositoryPath, 'docs', 'product')
    this.nowMs = options.nowMs ?? Date.now
  }

  async snapshot(): Promise<DecisionRegistrySnapshot> {
    const nowMs = this.nowMs()
    const parsed: ParsedDecision[] = []
    for (const domain of PRODUCT_HOME_DOMAINS) {
      const directory = join(this.productRoot, domain.id)
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name === 'README.md' || !entry.name.endsWith('.md')) continue
        const path = join(directory, entry.name)
        const fileStat = await stat(path)
        if (fileStat.size > MAX_CARD_BYTES) {
          throw new ProductHomeRegistryError(`${domain.id}/${entry.name}: decision card is too large`)
        }
        const text = await readFile(path, 'utf8')
        const card = parseCard(text, `${domain.id}/${entry.name}`, nowMs)
        if (card.domain !== domain.id) {
          throw new ProductHomeRegistryError(`${domain.id}/${entry.name}: domain does not match directory`)
        }
        parsed.push(card)
      }
    }

    const byId = new Map(parsed.map((card) => [card.id, card]))
    if (byId.size !== parsed.length) throw new ProductHomeRegistryError('decision ids are not unique')

    const implementationDirectory = join(this.productRoot, 'implementation-checks')
    const implementationByDecision = new Map<string, ImplementationCheck[]>()
    let implementationEntries: Dirent[]
    try {
      implementationEntries = await readdir(implementationDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      implementationEntries = []
    }
    for (const entry of implementationEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(implementationDirectory, entry.name)
      const fileStat = await stat(path)
      if (fileStat.size > MAX_IMPLEMENTATION_CHECK_BYTES) {
        throw new ProductHomeRegistryError(`implementation-checks/${entry.name}: file is too large`)
      }
      const parsedCheck = parseImplementationCheck(await readFile(path, 'utf8'), entry.name)
      if (!byId.has(parsedCheck.decisionId)) {
        throw new ProductHomeRegistryError(`${entry.name}: implementation check decision does not exist`)
      }
      const checks = implementationByDecision.get(parsedCheck.decisionId) ?? []
      if (checks.some((check) => check.checkedAt === parsedCheck.check.checkedAt)) {
        throw new ProductHomeRegistryError(`${entry.name}: duplicate implementation check time`)
      }
      checks.push(parsedCheck.check)
      implementationByDecision.set(parsedCheck.decisionId, checks)
    }
    for (const card of parsed) {
      const checks = (implementationByDecision.get(card.id) ?? [])
        .sort((left, right) => left.checkedAt.localeCompare(right.checkedAt))
      const latest = checks.at(-1) ?? null
      card.implementationChecks = checks
      card.implementationCheck = latest
      if (latest !== null) {
        card.implementationStatus = latest.verdict
        card.implementationCheckedAt = latest.checkedAt
        card.implementationSummary = latest.summary
      }
    }

    for (const card of parsed) {
      if (card.supersedes === null) continue
      const predecessor = byId.get(card.supersedes)
      if (predecessor === undefined) {
        throw new ProductHomeRegistryError(`${card.id}: superseded decision does not exist`)
      }
      if (predecessor.policyKey !== card.policyKey) {
        throw new ProductHomeRegistryError(`${card.id}: supersedes changes policy_key`)
      }
      if (predecessor.decidedAt >= card.decidedAt) {
        throw new ProductHomeRegistryError(`${card.id}: superseding decision is not newer`)
      }
      if (predecessor.supersededBy !== null) {
        throw new ProductHomeRegistryError(`${card.id}: decision history forks`)
      }
      predecessor.supersededBy = card.id
      predecessor.lifecycle = 'superseded'
      predecessor.reviewDue = false
    }

    const histories = new Map<string, ParsedDecision[]>()
    const policyKeys = new Set(parsed.map((card) => card.policyKey))
    for (const policyKey of policyKeys) {
      const policyCards = parsed.filter((card) => card.policyKey === policyKey)
      const roots = policyCards.filter((card) => card.supersedes === null)
      if (roots.length !== 1) {
        throw new ProductHomeRegistryError(`${policyKey}: decision history must have exactly one root`)
      }
      const chain: ParsedDecision[] = []
      const seen = new Set<string>()
      let current: ParsedDecision | undefined = roots[0]
      while (current !== undefined) {
        if (seen.has(current.id)) {
          throw new ProductHomeRegistryError(`${policyKey}: decision history contains a cycle`)
        }
        seen.add(current.id)
        chain.push(current)
        current = current.supersededBy === null ? undefined : byId.get(current.supersededBy)
      }
      if (seen.size !== policyCards.length) {
        throw new ProductHomeRegistryError(`${policyKey}: decision history is disconnected`)
      }
      for (const card of policyCards) histories.set(card.id, chain)
    }
    const decisions = parsed
      .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt) || left.id.localeCompare(right.id))
      .map(({ searchText: _searchText, ...card }) => ({
        ...card,
        history: (histories.get(card.id) ?? [card]).map((entry) => entry.id),
        policyHistory: (histories.get(card.id) ?? [card]).map((entry) => ({
          id: entry.id,
          title: entry.title,
          decidedAt: entry.decidedAt,
          reason: entry.reason,
          lifecycle: entry.lifecycle,
          supersedes: entry.supersedes,
          supersededBy: entry.supersededBy,
          implementationStatus: entry.implementationStatus,
          implementationCheckedAt: entry.implementationCheckedAt,
        })),
      }))
    const domains = PRODUCT_HOME_DOMAINS.map((domain) => {
      const cards = decisions.filter((decision) => decision.domain === domain.id)
      return {
        ...domain,
        count: cards.length,
        activeCount: cards.filter((decision) => decision.lifecycle === 'active').length,
        reviewDueCount: cards.filter((decision) => decision.reviewDue).length,
      }
    })
    return {
      decisions,
      domains,
      stats: {
        active: decisions.filter((decision) => decision.lifecycle === 'active').length,
        reviewDue: decisions.filter((decision) => decision.reviewDue).length,
        superseded: decisions.filter((decision) => decision.lifecycle === 'superseded').length,
      },
    }
  }

  async list(options: {
    query?: string
    domain?: string
    view?: 'all' | 'active' | 'review' | 'superseded' | 'implementation'
  } = {}): Promise<{ decisions: DecisionSummary[]; snapshot: DecisionRegistrySnapshot }> {
    const snapshot = await this.snapshot()
    const query = options.query?.trim().toLocaleLowerCase('ru-RU') ?? ''
    const parsedForSearch = await this.searchIndex(snapshot.decisions)
    const decisions = snapshot.decisions.filter((decision) => {
      if (options.domain !== undefined && decision.domain !== options.domain) return false
      if (options.view === 'active' && decision.lifecycle !== 'active') return false
      if (options.view === 'review' && !decision.reviewDue) return false
      if (options.view === 'superseded' && decision.lifecycle !== 'superseded') return false
      if (options.view === 'implementation' && (
        decision.lifecycle !== 'active' || decision.implementationStatus === 'aligned'
      )) return false
      if (query.length > 0 && !parsedForSearch.get(decision.id)?.includes(query)) return false
      return true
    }).map(summary)
    return { decisions, snapshot }
  }

  async get(id: string): Promise<DecisionDetail | null> {
    const snapshot = await this.snapshot()
    return snapshot.decisions.find((decision) => decision.id === id) ?? null
  }

  private async searchIndex(decisions: readonly DecisionDetail[]): Promise<Map<string, string>> {
    const index = new Map<string, string>()
    for (const decision of decisions) {
      index.set(decision.id, [
        decision.id,
        decision.policyKey,
        decision.domain,
        decision.domainTitle,
        decision.title,
        decision.decision,
        decision.reason,
        decision.affected.join(' '),
        decision.definitions,
        decision.alternatives,
        decision.evidence,
        decision.verification,
        decision.implementation,
        decision.implementationSummary,
        decision.implementationChecks.flatMap((check) => [
          check.summary,
          check.repository,
          check.checkedCommit,
          check.implementationCommits.join(' '),
          check.scopePaths.join(' '),
          ...check.checks.flatMap((item) => [item.name, item.command, item.evidence]),
        ]).join('\n'),
      ].join('\n').toLocaleLowerCase('ru-RU'))
    }
    return index
  }
}
