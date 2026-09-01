import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type {
  ProductDecisionDraftRecord,
  ProductDecisionFlowRecord,
} from '../durable/product-decision-repository.js'
import { productDecisionDomainSpec } from './product-decision.js'

export interface ProductDecisionWriteResult {
  decisionId: string
  gitCommit: string
  pushed: boolean
  path: string
}

export interface ProductDecisionWriterOptions {
  repositoryPath: string
  remote?: string
  push?: boolean
  now?: () => number
}

export interface ProductDecisionWriter {
  write(
    flow: ProductDecisionFlowRecord,
    draft: ProductDecisionDraftRecord,
  ): ProductDecisionWriteResult
}

const HASH = /^[0-9a-f]{64}$/
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const LOCK_NAME = 'product-decision-r1.lock'

function command(cwd: string, executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  }).trim()
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function bullets(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join('\n')
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown writer error'
  const message = error.message.trim().split('\n')[0] ?? error.name
  return message.slice(0, 500)
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function acquireLock(repository: string): () => void {
  const rawGitPath = command(repository, 'git', ['rev-parse', '--git-path', LOCK_NAME])
  const lockPath = resolve(repository, rawGitPath)
  if (existsSync(lockPath)) {
    let stale = false
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown }
      stale = typeof owner.pid !== 'number' || !processAlive(owner.pid)
    } catch {
      stale = true
    }
    if (!stale) throw new Error('another product decision write is in progress')
    rmSync(lockPath, { recursive: true, force: true })
  }
  mkdirSync(lockPath, { mode: 0o700 })
  writeFileSync(
    join(lockPath, 'owner.json'),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  )
  return () => rmSync(lockPath, { recursive: true, force: true })
}

function acceptanceNeedle(draft: ProductDecisionDraftRecord): string {
  return `telegram_acceptance_callback_query_id: ${quoted(draft.acceptanceCallbackQueryId ?? 'unknown')}`
}

function cardPattern(prefix: string): RegExp {
  return new RegExp(`^PD-${prefix}-(\\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\\.md$`)
}

function findExisting(
  repository: string,
  domainDirectory: string,
  prefix: string,
  draft: ProductDecisionDraftRecord,
): ProductDecisionWriteResult | null {
  const card = cardPattern(prefix)
  const needle = acceptanceNeedle(draft)
  for (const name of readdirSync(domainDirectory)) {
    const match = name.match(card)
    if (match?.[1] === undefined) continue
    const path = join(domainDirectory, name)
    const text = readFileSync(path, 'utf8')
    if (!text.includes(`brief_sha256: ${draft.briefSha256}`) || !text.includes(needle)) continue
    const decisionId = `PD-${prefix}-${match[1]}`
    const gitCommit = command(repository, 'git', ['log', '-1', '--format=%H', '--', path])
    if (!GIT_COMMIT.test(gitCommit)) throw new Error(`cannot prove Git commit for ${decisionId}`)
    return { decisionId, gitCommit, pushed: false, path }
  }
  return null
}

function assertSupersedes(
  domainDirectory: string,
  policyKey: string,
  supersedes: string | null,
): void {
  if (supersedes === null) return
  const name = readdirSync(domainDirectory).find((entry) => entry.startsWith(`${supersedes}-`))
  if (name === undefined) throw new Error(`superseded decision ${supersedes} does not exist`)
  const text = readFileSync(join(domainDirectory, name), 'utf8')
  if (!text.includes(`policy_key: ${policyKey}\n`)) {
    throw new Error(`${supersedes} belongs to a different policy key`)
  }
}

function nextDecisionId(domainDirectory: string, prefix: string, title: string): string {
  const card = cardPattern(prefix)
  let highest = 0
  for (const name of readdirSync(domainDirectory)) {
    const match = name.match(card)
    if (match?.[1] === undefined) continue
    highest = Math.max(highest, Number.parseInt(match[1], 10))
  }
  if (highest >= 9_999) throw new Error(`${title} decision id range is exhausted`)
  return `PD-${prefix}-${String(highest + 1).padStart(4, '0')}`
}

function renderCard(input: {
  decisionId: string
  flow: ProductDecisionFlowRecord
  draft: ProductDecisionDraftRecord
  decidedAt: string
}): string {
  const { decisionId, flow, draft, decidedAt } = input
  const brief = draft.brief
  const acceptanceUpdate = draft.acceptanceUpdateId ?? 'unknown'
  const acceptanceMessage = draft.acceptanceMessageId ?? 'unknown'
  const acceptanceCallback = draft.acceptanceCallbackQueryId ?? 'unknown'
  return [
    '---',
    `id: ${decisionId}`,
    `policy_key: ${brief.policyKey}`,
    `domain: ${brief.domain}`,
    'status: accepted',
    `brief_version: ${draft.version}`,
    `brief_sha256: ${draft.briefSha256}`,
    `decided_at: ${decidedAt}`,
    'decided_by: owner',
    `supersedes: ${brief.supersedes ?? 'null'}`,
    `review_at: ${brief.reviewAt ?? 'null'}`,
    'source:',
    `  telegram_update_id: ${quoted(`telegram:${flow.sourceUpdateId}`)}`,
    `  telegram_message_id: ${quoted(flow.sourceMessageId)}`,
    `  telegram_acceptance_update_id: ${quoted(acceptanceUpdate)}`,
    `  telegram_acceptance_message_id: ${quoted(acceptanceMessage)}`,
    `  telegram_acceptance_callback_query_id: ${quoted(acceptanceCallback)}`,
    `  codex_thread_id: ${quoted(flow.threadId)}`,
    `  codex_turn_id: ${quoted(draft.turnId)}`,
    '---',
    '',
    `# ${brief.title}`,
    '',
    '## Решение',
    '',
    brief.decision,
    '',
    '## Определения и границы',
    '',
    bullets(brief.boundaries),
    '',
    '## Почему',
    '',
    brief.reason,
    '',
    '## Альтернативы',
    '',
    bullets(brief.alternatives),
    '',
    '## Основания и допущения',
    '',
    bullets(brief.evidence),
    '',
    '## Что затронуто',
    '',
    bullets(brief.affected),
    '',
    '## Как проверим',
    '',
    brief.verification,
    '',
    '## Реализация',
    '',
    bullets(brief.implementation),
    '',
  ].join('\n')
}

export class GitProductDecisionWriter implements ProductDecisionWriter {
  private readonly repository: string
  private readonly remote: string
  private readonly shouldPush: boolean
  private readonly now: () => number

  constructor(options: ProductDecisionWriterOptions) {
    if (!options.repositoryPath.startsWith('/')) {
      throw new TypeError('product decision repositoryPath must be absolute')
    }
    this.repository = realpathSync(options.repositoryPath)
    this.remote = options.remote?.trim() || 'origin'
    this.shouldPush = options.push ?? true
    this.now = options.now ?? Date.now
    if (basename(this.repository).length === 0) throw new TypeError('invalid product decision repository')
    if (command(this.repository, 'git', ['rev-parse', '--show-toplevel']) !== this.repository) {
      throw new TypeError('product decision repositoryPath must be the Git worktree root')
    }
    const validator = join(this.repository, 'scripts', 'product_decisions.py')
    const productRoot = join(this.repository, 'docs', 'product')
    if (!existsSync(validator) || !existsSync(productRoot)) {
      throw new TypeError('repository does not contain the R0 product decision registry')
    }
  }

  write(flow: ProductDecisionFlowRecord, draft: ProductDecisionDraftRecord): ProductDecisionWriteResult {
    if (draft.state !== 'ACCEPTING') throw new Error('draft is not accepting')
    if (draft.briefSha256.length !== 64 || !HASH.test(draft.briefSha256)) {
      throw new Error('draft hash is invalid')
    }
    const release = acquireLock(this.repository)
    try {
      const domain = productDecisionDomainSpec(draft.brief.domain)
      const domainDirectory = join(this.repository, 'docs', 'product', draft.brief.domain)
      if (!existsSync(domainDirectory)) {
        throw new Error(`product decision domain is not initialized: ${draft.brief.domain}`)
      }
      const existing = findExisting(this.repository, domainDirectory, domain.prefix, draft)
      if (existing !== null) return this.finishPush(existing)

      const status = command(this.repository, 'git', ['status', '--porcelain=v1', '--untracked-files=all'])
      if (status.length > 0) throw new Error('canonical product repository has uncommitted changes')
      assertSupersedes(domainDirectory, draft.brief.policyKey, draft.brief.supersedes)

      const decisionId = nextDecisionId(domainDirectory, domain.prefix, domain.title)
      const cardPath = join(domainDirectory, `${decisionId}-${draft.brief.slug}.md`)
      const indexPath = join(domainDirectory, 'README.md')
      const oldIndex = readFileSync(indexPath, 'utf8')
      let committed = false
      try {
        writeFileSync(cardPath, renderCard({
          decisionId,
          flow,
          draft,
          decidedAt: new Date(this.now()).toISOString(),
        }), { encoding: 'utf8', mode: 0o644, flag: 'wx' })
        command(this.repository, 'python3', ['scripts/product_decisions.py', 'index'])
        command(this.repository, 'python3', ['scripts/product_decisions.py', 'check'])
        command(this.repository, 'git', ['diff', '--check', '--', cardPath, indexPath])
        command(this.repository, 'git', ['add', '--', cardPath, indexPath])
        command(this.repository, 'git', ['commit', '-m', `[codex] record ${decisionId} product decision`, '--', cardPath, indexPath])
        committed = true
      } catch (error) {
        if (!committed) {
          try {
            command(this.repository, 'git', ['restore', '--staged', '--', cardPath, indexPath])
          } catch {
            // Nothing may have reached the index.
          }
          rmSync(cardPath, { force: true })
          writeFileSync(indexPath, oldIndex, 'utf8')
        }
        throw new Error(`cannot record product decision: ${safeError(error)}`)
      }
      const result: ProductDecisionWriteResult = {
        decisionId,
        gitCommit: command(this.repository, 'git', ['rev-parse', 'HEAD']),
        pushed: false,
        path: cardPath,
      }
      return this.finishPush(result)
    } finally {
      release()
    }
  }

  private finishPush(result: ProductDecisionWriteResult): ProductDecisionWriteResult {
    if (!this.shouldPush) return result
    command(this.repository, 'git', ['remote', 'get-url', this.remote])
    command(this.repository, 'git', ['push', '--porcelain', this.remote, 'HEAD'])
    return { ...result, pushed: true }
  }
}
