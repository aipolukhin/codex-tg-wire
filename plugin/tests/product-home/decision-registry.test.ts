import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ProductDecisionRegistry } from '../../src/product-home/decision-registry.js'

const roots: string[] = []
const NOW_MS = Date.UTC(2026, 8, 21, 12, 0, 0)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function card(input: {
  id: string
  policyKey?: string
  decidedAt: string
  supersedes?: string | null
  reviewAt?: string | null
  title?: string
  affected?: string
  implementation?: string
}): string {
  return `---
id: ${input.id}
policy_key: ${input.policyKey ?? 'capacity.server_slots'}
domain: capacity
status: accepted
brief_version: 2
brief_sha256: ${'a'.repeat(64)}
decided_at: ${input.decidedAt}
decided_by: owner
supersedes: ${input.supersedes ?? 'null'}
review_at: ${input.reviewAt ?? 'null'}
source:
  telegram_update_id: "tg:update:1"
  telegram_message_id: "tg:message:1"
  telegram_acceptance_update_id: "tg:update:2"
  telegram_acceptance_message_id: "tg:message:2"
  telegram_acceptance_callback_query_id: "tg:callback:1"
  codex_thread_id: "thread:1"
  codex_turn_id: "turn:1"
---

# ${input.title ?? 'Лимит слотов'}

## Решение

Не более 250 подписчиков на service node.

## Определения и границы

- Подписчик занимает один слот.

## Почему

Предварительный безопасный предел.

## Альтернативы

- Не вводить предел.

## Основания и допущения

- Замеров пока нет.

## Что затронуто

- ${input.affected ?? 'placement'}

## Как проверим

Проверим метрики после запуска.

## Реализация

- ${input.implementation ?? 'Не реализовано.'}
`
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'product-home-registry-'))
  roots.push(root)
  await mkdir(join(root, 'docs', 'product', 'capacity'), { recursive: true })
  return root
}

describe('ProductDecisionRegistry', () => {
  test('builds current, superseded and review views from Git cards', async () => {
    const root = await repository()
    await writeFile(join(root, 'docs', 'product', 'capacity', 'PD-CAP-0001-old.md'), card({
      id: 'PD-CAP-0001',
      decidedAt: '2026-08-31T00:00:00Z',
      reviewAt: '2026-09-01T00:00:00Z',
    }))
    await writeFile(join(root, 'docs', 'product', 'capacity', 'PD-CAP-0002-current.md'), card({
      id: 'PD-CAP-0002',
      decidedAt: '2026-09-20T00:00:00Z',
      supersedes: 'PD-CAP-0001',
      reviewAt: '2026-09-21T00:00:00Z',
      affected: 'операторская панель',
      implementation: 'Статус пока неизвестен.',
    }))

    const registry = new ProductDecisionRegistry({ repositoryPath: root, nowMs: () => NOW_MS })
    const snapshot = await registry.snapshot()
    expect(snapshot.stats).toEqual({ active: 1, reviewDue: 1, superseded: 1 })
    expect(snapshot.decisions.map((decision) => decision.id)).toEqual([
      'PD-CAP-0002',
      'PD-CAP-0001',
    ])
    expect(snapshot.decisions[0]).toMatchObject({
      lifecycle: 'active',
      reviewDue: true,
      implementationStatus: 'unknown',
      history: ['PD-CAP-0001', 'PD-CAP-0002'],
    })
    expect(snapshot.decisions[1]).toMatchObject({
      lifecycle: 'superseded',
      reviewDue: false,
      supersededBy: 'PD-CAP-0002',
      implementationStatus: 'not_implemented',
    })
  })

  test('searches text, id, domain and affected systems', async () => {
    const root = await repository()
    await writeFile(join(root, 'docs', 'product', 'capacity', 'PD-CAP-0001-slots.md'), card({
      id: 'PD-CAP-0001',
      decidedAt: '2026-09-01T00:00:00Z',
      affected: 'операторская панель',
    }))
    const registry = new ProductDecisionRegistry({ repositoryPath: root })
    expect((await registry.list({ query: '250' })).decisions).toHaveLength(1)
    expect((await registry.list({ query: 'PD-CAP-0001' })).decisions).toHaveLength(1)
    expect((await registry.list({ query: 'capacity' })).decisions).toHaveLength(1)
    expect((await registry.list({ query: 'ОПЕРАТОРСКАЯ' })).decisions).toHaveLength(1)
    expect((await registry.list({ query: 'возврат' })).decisions).toHaveLength(0)
  })

  test('returns an empty six-domain home when Git has no accepted cards', async () => {
    const root = await repository()
    const registry = new ProductDecisionRegistry({ repositoryPath: root })
    const snapshot = await registry.snapshot()
    expect(snapshot.decisions).toEqual([])
    expect(snapshot.domains).toHaveLength(6)
    expect(snapshot.stats).toEqual({ active: 0, reviewDue: 0, superseded: 0 })
  })
})
