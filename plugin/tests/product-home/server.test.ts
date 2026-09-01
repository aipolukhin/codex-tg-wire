import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { ProductHomeApplication } from '../../src/product-home/server.js'

const TOKEN = '123456789:test-token'
const NOW_MS = Date.UTC(2026, 8, 1, 12, 0, 0)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function signedInitData(): string {
  const values = new Map<string, string>([
    ['auth_date', String(Math.floor(NOW_MS / 1_000))],
    ['query_id', 'AAE-test'],
    ['user', JSON.stringify({ id: 7001 })],
  ])
  const check = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest()
  values.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return new URLSearchParams([...values]).toString()
}

async function fixture(): Promise<ProductHomeApplication> {
  const root = await mkdtemp(join(tmpdir(), 'product-home-server-'))
  roots.push(root)
  const staticDirectory = join(root, 'dist')
  const capacity = join(root, 'repository', 'docs', 'product', 'capacity')
  await mkdir(staticDirectory, { recursive: true })
  await mkdir(capacity, { recursive: true })
  await writeFile(join(staticDirectory, 'index.html'), '<!doctype html><title>Product Home</title>')
  await writeFile(join(capacity, 'PD-CAP-0001-slots.md'), `---
id: PD-CAP-0001
policy_key: capacity.server_slots
domain: capacity
status: accepted
brief_version: 1
brief_sha256: ${'b'.repeat(64)}
decided_at: 2026-09-01T10:00:00Z
decided_by: owner
supersedes: null
review_at: null
source:
  telegram_update_id: "tg:update:1"
  telegram_message_id: "tg:message:1"
  telegram_acceptance_update_id: "tg:update:2"
  telegram_acceptance_message_id: "tg:message:2"
  telegram_acceptance_callback_query_id: "tg:callback:1"
  codex_thread_id: "thread:1"
  codex_turn_id: "turn:1"
---
# Лимит слотов
## Решение
Не более 250 подписчиков.
## Определения и границы
- Один подписчик — один слот.
## Почему
Безопасный предел.
## Альтернативы
- Без лимита.
## Основания и допущения
- Явное допущение.
## Что затронуто
- placement
## Как проверим
По метрикам.
## Реализация
- Не реализовано.
`)
  return new ProductHomeApplication({
    host: '127.0.0.1',
    port: 8788,
    publicUrl: 'https://example.test/product-home/',
    staticDirectory,
    repositoryPath: join(root, 'repository'),
    telegramToken: TOKEN,
    allowedUserIds: ['7001'],
    initDataMaxAgeSeconds: 3_600,
    nowMs: () => NOW_MS,
  })
}

describe('ProductHomeApplication', () => {
  test('serves only the shell without Telegram authorization', async () => {
    const application = await fixture()
    const shell = await application.handle(new Request('https://example.test/product-home/'))
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('Product Home')
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'")

    const api = await application.handle(new Request(
      'https://example.test/product-home/api/v1/decisions',
    ))
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ error: 'unauthorized' })
  })

  test('returns summaries and owner-only provenance after validation', async () => {
    const application = await fixture()
    const headers = { authorization: `tma ${signedInitData()}` }
    const list = await application.handle(new Request(
      'https://example.test/product-home/api/v1/decisions?query=250',
      { headers },
    ))
    expect(list.status).toBe(200)
    const listBody = await list.json() as Record<string, unknown>
    expect(listBody.total).toBe(1)
    expect(JSON.stringify(listBody)).not.toContain('telegramUpdateId')

    const detail = await application.handle(new Request(
      'https://example.test/product-home/api/v1/decisions/PD-CAP-0001',
      { headers },
    ))
    expect(detail.status).toBe(200)
    const detailBody = await detail.json() as { decision: { source: { telegramUpdateId: string } } }
    expect(detailBody.decision.source.telegramUpdateId).toBe('tg:update:1')
  })

  test('does not expose files outside the static build', async () => {
    const application = await fixture()
    const response = await application.handle(new Request(
      'https://example.test/product-home/%2e%2e/repository/docs/product/capacity/PD-CAP-0001-slots.md',
    ))
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('250')
  })
})
