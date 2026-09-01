import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { ProductDecisionAcceptanceService } from '../../src/bridge/product-decision-acceptance.js'
import { ProductDecisionInteractionHandler } from '../../src/bridge/product-decision-interaction-handler.js'
import { ProductDecisionSessionCoordinator } from '../../src/bridge/product-decision-session-coordinator.js'
import {
  parseProductDecisionResult,
  parseProductDecisionTransition,
  productDecisionAgentInstruction,
  productDecisionHash,
  productDecisionMode,
  renderProductDecisionBrief,
  type ProductDecisionBrief,
} from '../../src/bridge/product-decision.js'
import {
  GitProductDecisionWriter,
  type ProductDecisionWriter,
} from '../../src/bridge/product-decision-writer.js'
import type {
  InteractionHandler,
  SessionCoordinator,
  TextTurnOperation,
  TextTurnResult,
} from '../../src/bridge/contracts.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteProductDecisionRepository } from '../../src/durable/product-decision-repository.js'
import { SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'

const NOW = Date.parse('2026-08-31T20:00:00Z')

const brief: ProductDecisionBrief = {
  schema: 1,
  domain: 'capacity',
  policyKey: 'capacity.server_user_slots',
  slug: 'server-user-slots',
  title: 'Лимит слотов на service node',
  supersedes: null,
  decision: 'На service node можно назначить не более 250 активных подписчиков. 251-е назначение блокируется.',
  boundaries: [
    'Один активный подписчик занимает один слот.',
    'Служебные canary-аккаунты не занимают слот.',
  ],
  reason: '250 — выбранный владельцем безопасный предел; измерений для точного числа пока нет.',
  alternatives: ['Не вводить лимит.', 'Показывать мягкое предупреждение без блокировки.'],
  evidence: ['Число 250 является явным допущением владельца.'],
  affected: ['placement', 'capacity view', 'customer provisioning'],
  verification: 'Ни один node не получает 251-го активного подписчика.',
  reviewAt: null,
  implementation: ['Не реализовано.'],
}

const brandBrief: ProductDecisionBrief = {
  schema: 1,
  domain: 'brand',
  policyKey: 'brand.public_service_name',
  slug: 'public-service-name',
  title: 'Публичное имя VPN-сервиса',
  supersedes: null,
  decision: 'Публичное имя сервиса — STVOR / STVOR VPN / СТВОР / СТВОР VPN.',
  boundaries: ['Рабочее имя репозитория остаётся vpn-infra.'],
  reason: 'Имя связывает навигацию, точность и управляемый проход.',
  alternatives: ['Whynaut.', 'Продолжить поиск имени.'],
  evidence: ['Решение владельца в Telegram.'],
  affected: ['public name', 'customer surfaces'],
  verification: 'Новые публичные поверхности используют имя STVOR.',
  reviewAt: null,
  implementation: ['Не проверено.'],
}

function operation(updateId: number, text: string): TextTurnOperation {
  return {
    operationKey: `telegram:bot:${updateId}:turn`,
    inboxUpdateId: updateId,
    botId: 'bot',
    updateId,
    chatId: '7001',
    projectId: 'razvilka',
    sourceMessageId: 100 + updateId,
    text,
  }
}

function machineBrief(value: ProductDecisionBrief = brief): string {
  return `Готово.\n\n<product-decision-brief>\n${JSON.stringify(value)}\n</product-decision-brief>`
}

function executionTransition(): string {
  return '<product-decision-transition>{"action":"execute"}</product-decision-transition>'
}

class FakeCoordinator implements SessionCoordinator {
  calls: TextTurnOperation[] = []
  responses: string[] = [machineBrief()]

  async runTextTurn(input: TextTurnOperation): Promise<TextTurnResult> {
    this.calls.push(input)
    return {
      threadId: input.preferredThreadId ?? 'thread-1',
      turnId: `turn-${this.calls.length}`,
      finalText: this.responses.shift() ?? 'Нужно ещё одно уточнение.',
    }
  }
}

class FakeWriter implements ProductDecisionWriter {
  calls = 0

  write() {
    this.calls += 1
    return {
      decisionId: 'PD-CAP-0001',
      gitCommit: 'a'.repeat(40),
      pushed: true,
      path: '/repo/docs/product/capacity/PD-CAP-0001-server-user-slots.md',
    }
  }
}

class FailOnceWriter extends FakeWriter {
  failed = false

  override write() {
    if (!this.failed) {
      this.failed = true
      throw new Error('fatal: remote https://owner-token@example.invalid rejected /srv/private/vpn-infra')
    }
    return super.write()
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRegistry(repository: string): void {
  mkdirSync(join(repository, 'docs', 'product', 'capacity'), { recursive: true })
  mkdirSync(join(repository, 'docs', 'product', 'brand'), { recursive: true })
  mkdirSync(join(repository, 'scripts'), { recursive: true })
  writeFileSync(join(repository, 'docs', 'product', 'capacity', 'README.md'), '# Capacity\n', 'utf8')
  writeFileSync(join(repository, 'docs', 'product', 'brand', 'README.md'), '# Brand\n', 'utf8')
  writeFileSync(join(repository, 'scripts', 'product_decisions.py'), [
    'from pathlib import Path',
    'import sys',
    'root = Path(__file__).resolve().parents[1]',
    'if sys.argv[1] == "index":',
    '    for domain, prefix, title in [("capacity", "CAP", "Capacity"), ("brand", "BRD", "Brand")]:',
    '        index = root / f"docs/product/{domain}/README.md"',
    '        cards = sorted((root / f"docs/product/{domain}").glob(f"PD-{prefix}-*.md"))',
    '        index.write_text(f"# {title}\\n" + "".join(f"- [{p.stem}]({p.name})\\n" for p in cards))',
    'elif sys.argv[1] != "check":',
    '    raise SystemExit(2)',
  ].join('\n'), 'utf8')
  git(repository, ['init', '-q'])
  git(repository, ['config', 'user.email', 'test@example.invalid'])
  git(repository, ['config', 'user.name', 'R1 Test'])
  git(repository, ['add', '.'])
  git(repository, ['commit', '-qm', 'fixture'])
}

let root: string
let database: Database
let decisions: SqliteProductDecisionRepository

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'product-decision-r1-'))
  database = openDurableDatabase(join(root, 'bridge.sqlite3'))
  decisions = new SqliteProductDecisionRepository(database)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('R1 decision brief', () => {
  test('recognizes all three modes and hashes the exact rendered brief', () => {
    expect(productDecisionMode('Исследуем: лимит')).toBe('research')
    expect(productDecisionMode('Фиксируем: лимит')).toBe('fix')
    expect(productDecisionMode('Меняем: лимит')).toBe('change')
    const parsed = parseProductDecisionResult(machineBrief())
    expect(parsed.brief).toEqual(brief)
    expect(parsed.visibleText).toBe('Готово.')
    expect(productDecisionHash(brief)).toHaveLength(64)
    expect(renderProductDecisionBrief(brief)).toContain('Почему\n250 — выбранный владельцем')
  })

  test('rejects placeholders and malformed machine blocks without exposing an accept button', () => {
    const invalid = { ...brief, reason: '<причина>' }
    const parsed = parseProductDecisionResult(machineBrief(invalid))
    expect(parsed.brief).toBeNull()
    expect(parsed.error).toContain('placeholder')
    expect(parsed.visibleText).toBe('Готово.')
  })

  test('uses a semantic execution transition instead of a required owner phrase', () => {
    const instruction = productDecisionAgentInstruction({
      mode: 'fix',
      version: 2,
      currentBrief: brief,
      ownerText: 'Вариант подходит, теперь внеси это в работающий бот.',
      allowExecutionExit: true,
    })
    expect(instruction).toContain('по смыслу и контексту')
    expect(instruction).toContain('без списка ключевых слов')
    expect(instruction).toContain('<product-decision-transition>')
    expect(parseProductDecisionTransition(executionTransition())).toMatchObject({
      action: 'execute', error: null, visibleText: '',
    })
  })
})

describe('R1 durable versions and acceptance', () => {
  test('supersedes the old token and processes a repeated acceptance only once', () => {
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-1', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '1', sourceMessageId: '101',
      threadId: 'thread-1', turnId: 'turn-1', nowMs: NOW,
    })
    const v1 = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-1', brief, briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    decisions.invalidateCurrentDraft(flow.id, 'edit', 'edit-op', NOW + 1)
    const v2 = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-2', brief: { ...brief, decision: `${brief.decision} Hard cap.` },
      briefSha256: productDecisionHash({ ...brief, decision: `${brief.decision} Hard cap.` }), nowMs: NOW + 2,
    })

    expect(decisions.beginAcceptance({
      token: v1.token, chatId: '7001', operationKey: 'old-accept',
      acceptanceUpdateId: 'telegram:9', acceptanceMessageId: '90',
      acceptanceCallbackQueryId: 'cb-old', nowMs: NOW + 3,
    }).outcome).toBe('closed')

    const writer = new FakeWriter()
    const acceptance = new ProductDecisionAcceptanceService(decisions, writer, () => NOW + 4)
    const first = acceptance.accept({
      token: v2.token, chatId: '7001', operationKey: 'accept-op',
      acceptanceUpdateId: 'telegram:10', acceptanceMessageId: '91',
      acceptanceCallbackQueryId: 'cb-new',
    })
    const replay = acceptance.accept({
      token: v2.token, chatId: '7001', operationKey: 'accept-op-replay',
      acceptanceUpdateId: 'telegram:10', acceptanceMessageId: '91',
      acceptanceCallbackQueryId: 'cb-new',
    })
    expect(first.outcome).toBe('accepted')
    expect(replay.outcome).toBe('accepted')
    expect(writer.calls).toBe(1)
    expect(decisions.getDraftByToken(v2.token)).toMatchObject({
      state: 'ACCEPTED', decisionId: 'PD-CAP-0001', gitCommit: 'a'.repeat(40), pushed: true,
    })
  })

  test('renders a versioned card read-only and accepts the exact text version', async () => {
    const delegate = new FakeCoordinator()
    const writer = new FakeWriter()
    const acceptance = new ProductDecisionAcceptanceService(decisions, writer, () => NOW)
    const coordinator = new ProductDecisionSessionCoordinator(delegate, decisions, acceptance, () => NOW)

    const card = await coordinator.runTextTurn(operation(1, 'Фиксируем: лимит 250 слотов'))
    expect(delegate.calls[0]).toMatchObject({
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    expect(card.finalText).toContain('версия 1')
    expect(card.finalText).toContain('SHA-256:')
    expect(card.buttons?.[0]?.[0]?.text).toBe('✅ Принимаю v1')

    const result = await coordinator.runTextTurn(operation(2, 'Принимаю v1.'))
    expect(result.finalText).toContain('PD-CAP-0001')
    expect(writer.calls).toBe(1)
    expect(delegate.calls).toHaveLength(1)
  })

  test('captures a complete Brand decision from natural language without requiring a prefix', async () => {
    const delegate = new FakeCoordinator()
    delegate.responses = [machineBrief(brandBrief)]
    const acceptance = new ProductDecisionAcceptanceService(decisions, new FakeWriter(), () => NOW)
    const coordinator = new ProductDecisionSessionCoordinator(delegate, decisions, acceptance, () => NOW)

    const card = await coordinator.runTextTurn(operation(
      11,
      'Новое имя сервиса STVOR, рабочее имя репозитория vpn-infra оставляем. Фиксируем.',
    ))

    expect(delegate.calls).toHaveLength(1)
    expect(delegate.calls[0]?.trustedSettingsOverride).toBeUndefined()
    expect(card.finalText).toContain('Новая карточка Brand · версия 1')
    expect(card.finalText).toContain('Публичное имя VPN-сервиса')
    expect(card.buttons?.[0]?.[0]?.text).toBe('✅ Принимаю v1')
    expect(decisions.getOpenFlow('bot', '7001', 'razvilka')).toMatchObject({ mode: 'fix' })
  })

  test('ends an open discussion and executes the same owner request under normal project policy', async () => {
    const delegate = new FakeCoordinator()
    delegate.responses = [executionTransition(), 'Изменения внесены и проверены.']
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-execute', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '12', sourceMessageId: '112',
      threadId: 'thread-execute', turnId: 'turn-draft', nowMs: NOW,
    })
    decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-draft', brief,
      briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const coordinator = new ProductDecisionSessionCoordinator(
      delegate,
      decisions,
      new ProductDecisionAcceptanceService(decisions, new FakeWriter(), () => NOW),
      () => NOW,
    )
    const ownerText = 'Вариант согласован. Внеси эти изменения в бот и проверь их.'

    const result = await coordinator.runTextTurn(operation(12, ownerText))

    expect(result.finalText).toBe('Изменения внесены и проверены.')
    expect(delegate.calls).toHaveLength(2)
    expect(delegate.calls[0]).toMatchObject({
      preferredThreadId: 'thread-execute',
      trustedSettingsOverride: { sandbox: 'read-only', approvalPolicy: 'never' },
    })
    expect(delegate.calls[0]?.text).toContain(ownerText)
    expect(delegate.calls[1]).toMatchObject({ text: ownerText, preferredThreadId: 'thread-execute' })
    expect(delegate.calls[1]?.trustedSettingsOverride).toBeUndefined()
    expect(decisions.getOpenFlow('bot', '7001', 'razvilka')).toBeNull()
    expect(decisions.getFlow(flow.id)?.state).toBe('REJECTED')
  })

  test('does not let a rejected card capture the next ordinary message', async () => {
    const delegate = new FakeCoordinator()
    delegate.responses = ['Обычный ответ вне карточного режима.']
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-reject', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '13', sourceMessageId: '113',
      threadId: 'thread-reject', turnId: 'turn-reject', nowMs: NOW,
    })
    const draft = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-reject', brief,
      briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    decisions.beginDraftAction({
      token: draft.token, chatId: '7001', action: 'reject',
      operationKey: 'reject-card', nowMs: NOW + 1,
    })
    const coordinator = new ProductDecisionSessionCoordinator(
      delegate,
      decisions,
      new ProductDecisionAcceptanceService(decisions, new FakeWriter(), () => NOW),
      () => NOW,
    )

    const result = await coordinator.runTextTurn(operation(13, 'Теперь обычный вопрос про репозиторий.'))

    expect(result.finalText).toBe('Обычный ответ вне карточного режима.')
    expect(delegate.calls).toHaveLength(1)
    expect(delegate.calls[0]?.trustedSettingsOverride).toBeUndefined()
  })

  test('closes a malformed card so the following message is not trapped', async () => {
    const delegate = new FakeCoordinator()
    delegate.responses = [
      machineBrief({ ...brief, reason: '<внутренняя причина>' }),
      'Следующее сообщение обработано обычно.',
    ]
    const coordinator = new ProductDecisionSessionCoordinator(
      delegate,
      decisions,
      new ProductDecisionAcceptanceService(decisions, new FakeWriter(), () => NOW),
      () => NOW,
    )

    const broken = await coordinator.runTextTurn(operation(14, 'Фиксируем: подготовь карточку.'))
    expect(broken.finalText).toContain('Некорректная карточка закрыта')
    expect(decisions.getOpenFlow('bot', '7001', 'razvilka')).toBeNull()

    const next = await coordinator.runTextTurn(operation(15, 'А теперь ответь на обычный вопрос.'))
    expect(next.finalText).toBe('Следующее сообщение обработано обычно.')
    expect(delegate.calls[1]?.trustedSettingsOverride).toBeUndefined()
  })

  test('keeps the exact version active after a failed write and allows a safe retry', () => {
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-retry', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '5', sourceMessageId: '105',
      threadId: 'thread-retry', turnId: 'turn-retry', nowMs: NOW,
    })
    const draft = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-retry', brief,
      briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const writer = new FailOnceWriter()
    const acceptance = new ProductDecisionAcceptanceService(decisions, writer, () => NOW)
    const first = acceptance.accept({
      token: draft.token, chatId: '7001', operationKey: 'accept-failed',
      acceptanceUpdateId: 'telegram:6', acceptanceMessageId: '206',
      acceptanceCallbackQueryId: 'cb-failed',
    })
    expect(first.outcome).toBe('failed')
    if (first.outcome !== 'failed') throw new Error('write failure was not preserved')
    expect(first.error).toBe('Не удалось зафиксировать карточку в Git. Можно повторить принятие.')
    expect(first.error).not.toContain('owner-token')
    expect(first.error).not.toContain('/srv/private')
    expect(decisions.getDraftByToken(draft.token)).toMatchObject({
      state: 'ACTIVE',
      lastError: expect.stringContaining('owner-token'),
    })

    const retry = acceptance.accept({
      token: draft.token, chatId: '7001', operationKey: 'accept-retry',
      acceptanceUpdateId: 'telegram:7', acceptanceMessageId: '206',
      acceptanceCallbackQueryId: 'cb-retry',
    })
    expect(retry.outcome).toBe('accepted')
    expect(writer.calls).toBe(1)
  })

  test('decision callback edits the card to a short durable result', async () => {
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-2', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '2', sourceMessageId: '102',
      threadId: 'thread-2', turnId: 'turn-2', nowMs: NOW,
    })
    const draft = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-2', brief, briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const writer = new FakeWriter()
    const acceptance = new ProductDecisionAcceptanceService(decisions, writer, () => NOW)
    const outbox = new SqliteOutboxRepository(database)
    const legacy: InteractionHandler = { handleInteraction: async () => ({ deliveryJobId: null }) }
    const handler = new ProductDecisionInteractionHandler(legacy, decisions, acceptance, outbox, () => NOW)
    await handler.handleInteraction({
      operationKey: 'callback-op', botId: 'bot', inboxUpdateId: 4, updateId: 4,
      response: {
        kind: 'feature_action', feature: 'decision', chatId: '7001', token: draft.token,
        action: 'accept', callbackQueryId: 'cb-4', callbackMessageId: 204,
      },
    })
    expect(outbox.getBySourceKey('callback-op:decision-edit')).toMatchObject({
      kind: 'edit', payload: { chatId: '7001', messageId: 204, text: expect.stringContaining('PD-CAP-0001') },
    })
    expect(outbox.getBySourceKey('callback-op:decision-ack')).toMatchObject({ kind: 'reaction' })
  })

  test('decision callback never exposes an internal Git failure', async () => {
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-private-error', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '16', sourceMessageId: '116',
      threadId: 'thread-private-error', turnId: 'turn-private-error', nowMs: NOW,
    })
    const draft = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-private-error', brief,
      briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const outbox = new SqliteOutboxRepository(database)
    const legacy: InteractionHandler = { handleInteraction: async () => ({ deliveryJobId: null }) }
    const handler = new ProductDecisionInteractionHandler(
      legacy,
      decisions,
      new ProductDecisionAcceptanceService(decisions, new FailOnceWriter(), () => NOW),
      outbox,
      () => NOW,
    )

    await handler.handleInteraction({
      operationKey: 'callback-private-error', botId: 'bot', inboxUpdateId: 16, updateId: 16,
      response: {
        kind: 'feature_action', feature: 'decision', chatId: '7001', token: draft.token,
        action: 'accept', callbackQueryId: 'cb-private-error', callbackMessageId: 216,
      },
    })

    const rendered = JSON.stringify(outbox.getBySourceKey('callback-private-error:decision-error')?.payload)
    expect(rendered).toContain('Не удалось зафиксировать карточку в Git')
    expect(rendered).not.toContain('owner-token')
    expect(rendered).not.toContain('/srv/private')
  })
})

describe('R1 canonical Git writer', () => {
  test('creates one scoped commit and rediscovers the same acceptance after replay', () => {
    const repository = join(root, 'vpn-infra')
    createRegistry(repository)

    const flow = decisions.createFlow({
      sourceOperationKey: 'source-git', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '77', sourceMessageId: '177',
      threadId: 'thread-git', turnId: 'turn-git', nowMs: NOW,
    })
    const stored = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-git', brief, briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const began = decisions.beginAcceptance({
      token: stored.token, chatId: '7001', operationKey: 'git-accept',
      acceptanceUpdateId: 'telegram:78', acceptanceMessageId: '278',
      acceptanceCallbackQueryId: 'callback:78', nowMs: NOW,
    })
    if (began.flow === null || began.draft === null) throw new Error('acceptance did not start')
    const writer = new GitProductDecisionWriter({
      repositoryPath: repository, push: false, now: () => NOW,
    })
    const first = writer.write(began.flow, began.draft)
    const replay = writer.write(began.flow, began.draft)

    expect(first.decisionId).toBe('PD-CAP-0001')
    expect(replay).toMatchObject({ decisionId: first.decisionId, gitCommit: first.gitCommit })
    expect(git(repository, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(git(repository, ['status', '--porcelain'])).toBe('')
    const card = readFileSync(first.path, 'utf8')
    expect(card).toContain(`brief_sha256: ${productDecisionHash(brief)}`)
    expect(card).toContain('telegram_acceptance_callback_query_id: "callback:78"')
    expect(card).toContain('## Почему\n\n250 — выбранный владельцем безопасный предел')
  })

  test('retries a failed push without creating a second decision or losing first acceptance provenance', () => {
    const repository = join(root, 'push-retry-vpn-infra')
    const remote = join(root, 'remote.git')
    createRegistry(repository)
    git(repository, ['remote', 'add', 'origin', remote])
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-push', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '80', sourceMessageId: '180',
      threadId: 'thread-push', turnId: 'turn-push', nowMs: NOW,
    })
    const draft = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-push', brief,
      briefSha256: productDecisionHash(brief), nowMs: NOW,
    })
    const writer = new GitProductDecisionWriter({ repositoryPath: repository, push: true, now: () => NOW })
    const acceptance = new ProductDecisionAcceptanceService(decisions, writer, () => NOW)
    const failed = acceptance.accept({
      token: draft.token, chatId: '7001', operationKey: 'push-failed',
      acceptanceUpdateId: 'telegram:81', acceptanceMessageId: '281',
      acceptanceCallbackQueryId: 'callback:first',
    })
    expect(failed.outcome).toBe('failed')
    expect(git(repository, ['rev-list', '--count', 'HEAD'])).toBe('2')

    git(root, ['init', '--bare', '-q', remote])
    const retried = acceptance.accept({
      token: draft.token, chatId: '7001', operationKey: 'push-retry',
      acceptanceUpdateId: 'telegram:82', acceptanceMessageId: '282',
      acceptanceCallbackQueryId: 'callback:second',
    })
    expect(retried.outcome).toBe('accepted')
    expect(git(repository, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(git(remote, ['rev-list', '--count', '--all'])).toBe('2')
    const card = readFileSync(join(repository, 'docs/product/capacity/PD-CAP-0001-server-user-slots.md'), 'utf8')
    expect(card).toContain('telegram_acceptance_callback_query_id: "callback:first"')
    expect(card).not.toContain('callback:second')
  })

  test('writes Brand decisions with the BRD sequence into the Brand domain', () => {
    const repository = join(root, 'brand-vpn-infra')
    createRegistry(repository)
    const flow = decisions.createFlow({
      sourceOperationKey: 'source-brand', botId: 'bot', chatId: '7001', projectId: 'razvilka',
      mode: 'fix', sourceUpdateId: '90', sourceMessageId: '190',
      threadId: 'thread-brand', turnId: 'turn-brand', nowMs: NOW,
    })
    const stored = decisions.storeDraft({
      flowId: flow.id, turnId: 'turn-brand', brief: brandBrief,
      briefSha256: productDecisionHash(brandBrief), nowMs: NOW,
    })
    const began = decisions.beginAcceptance({
      token: stored.token, chatId: '7001', operationKey: 'brand-accept',
      acceptanceUpdateId: 'telegram:91', acceptanceMessageId: '291',
      acceptanceCallbackQueryId: 'callback:91', nowMs: NOW,
    })
    if (began.flow === null || began.draft === null) throw new Error('acceptance did not start')

    const result = new GitProductDecisionWriter({ repositoryPath: repository, push: false, now: () => NOW })
      .write(began.flow, began.draft)

    expect(result.decisionId).toBe('PD-BRD-0001')
    expect(result.path).toBe(join(repository, 'docs/product/brand/PD-BRD-0001-public-service-name.md'))
    expect(readFileSync(result.path, 'utf8')).toContain('policy_key: brand.public_service_name')
    expect(readFileSync(join(repository, 'docs/product/brand/README.md'), 'utf8')).toContain('PD-BRD-0001')
  })
})
