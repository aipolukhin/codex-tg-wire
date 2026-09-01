import { createHash } from 'node:crypto'

import type { TextTurnResult } from './contracts.js'

export type ProductDecisionMode = 'research' | 'fix' | 'change'

export interface ProductDecisionBrief {
  schema: 1
  domain: 'capacity'
  policyKey: string
  slug: string
  title: string
  supersedes: string | null
  decision: string
  boundaries: string[]
  reason: string
  alternatives: string[]
  evidence: string[]
  affected: string[]
  verification: string
  reviewAt: string | null
  implementation: string[]
}

export interface ParsedProductDecisionResult {
  visibleText: string
  brief: ProductDecisionBrief | null
  error: string | null
}

const BRIEF_START = '<product-decision-brief>'
const BRIEF_END = '</product-decision-brief>'
const POLICY_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DECISION_ID = /^PD-CAP-\d{4}$/
const PLACEHOLDER = /<[^>\n]+>|\b(?:TODO|TBD|FIXME)\b|\?\?\?/iu
const MODE = /^(Исследуем|Фиксируем|Меняем)\s*:\s*/iu
const ACCEPT = /^Принимаю\s+v(\d+)\.?$/iu
const MAX_SCALAR = 4_000
const MAX_LIST = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanScalar(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.trim().replace(/\r\n?/g, '\n')
  if (normalized.length === 0 || normalized.length > MAX_SCALAR) {
    throw new TypeError(`${field} must contain 1-${MAX_SCALAR} characters`)
  }
  if (PLACEHOLDER.test(normalized)) throw new TypeError(`${field} contains a placeholder`)
  return normalized
}

function cleanList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    throw new TypeError(`${field} must contain 1-${MAX_LIST} items`)
  }
  return value.map((item, index) => cleanScalar(item, `${field}[${index}]`))
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  const timestamp = cleanScalar(value, 'reviewAt')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    throw new TypeError('reviewAt must be null or an RFC3339 UTC timestamp')
  }
  if (Number.isNaN(Date.parse(timestamp))) throw new TypeError('reviewAt is not a valid timestamp')
  return timestamp
}

export function parseProductDecisionBrief(value: unknown): ProductDecisionBrief {
  if (!isRecord(value)) throw new TypeError('brief must be an object')
  const expected = new Set([
    'schema', 'domain', 'policyKey', 'slug', 'title', 'supersedes', 'decision',
    'boundaries', 'reason', 'alternatives', 'evidence', 'affected', 'verification',
    'reviewAt', 'implementation',
  ])
  const unknown = Object.keys(value).filter((key) => !expected.has(key))
  const missing = [...expected].filter((key) => !(key in value))
  if (unknown.length > 0) throw new TypeError(`unknown brief fields: ${unknown.join(', ')}`)
  if (missing.length > 0) throw new TypeError(`missing brief fields: ${missing.join(', ')}`)
  if (value.schema !== 1) throw new TypeError('schema must equal 1')
  if (value.domain !== 'capacity') throw new TypeError('R1 supports only the capacity domain')
  const policyKey = cleanScalar(value.policyKey, 'policyKey')
  if (!POLICY_KEY.test(policyKey) || !policyKey.startsWith('capacity.')) {
    throw new TypeError('policyKey must be a dotted capacity identifier')
  }
  const slug = cleanScalar(value.slug, 'slug')
  if (!SLUG.test(slug)) throw new TypeError('slug must use lowercase ASCII words')
  let supersedes: string | null = null
  if (value.supersedes !== null) {
    supersedes = cleanScalar(value.supersedes, 'supersedes')
    if (!DECISION_ID.test(supersedes)) throw new TypeError('supersedes must be a Capacity decision id')
  }
  return {
    schema: 1,
    domain: 'capacity',
    policyKey,
    slug,
    title: cleanScalar(value.title, 'title'),
    supersedes,
    decision: cleanScalar(value.decision, 'decision'),
    boundaries: cleanList(value.boundaries, 'boundaries'),
    reason: cleanScalar(value.reason, 'reason'),
    alternatives: cleanList(value.alternatives, 'alternatives'),
    evidence: cleanList(value.evidence, 'evidence'),
    affected: cleanList(value.affected, 'affected'),
    verification: cleanScalar(value.verification, 'verification'),
    reviewAt: nullableTimestamp(value.reviewAt),
    implementation: cleanList(value.implementation, 'implementation'),
  }
}

export function productDecisionMode(text: string): ProductDecisionMode | null {
  const match = text.trim().match(MODE)
  const label = match?.[1]?.toLocaleLowerCase('ru-RU')
  if (label === 'исследуем') return 'research'
  if (label === 'фиксируем') return 'fix'
  if (label === 'меняем') return 'change'
  return null
}

export function acceptedProductDecisionVersion(text: string): number | null {
  const match = text.trim().match(ACCEPT)
  if (match?.[1] === undefined) return null
  const version = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(version) && version > 0 ? version : null
}

export function parseProductDecisionResult(text: string): ParsedProductDecisionResult {
  const start = text.indexOf(BRIEF_START)
  const end = text.indexOf(BRIEF_END)
  if (start < 0 && end < 0) return { visibleText: text, brief: null, error: null }
  if (start < 0 || end < start || text.indexOf(BRIEF_START, start + BRIEF_START.length) >= 0) {
    return { visibleText: text.replaceAll(BRIEF_START, '').replaceAll(BRIEF_END, '').trim(), brief: null, error: 'Некорректный служебный блок карточки' }
  }
  const raw = text.slice(start + BRIEF_START.length, end).trim()
  const visibleText = `${text.slice(0, start)}${text.slice(end + BRIEF_END.length)}`.trim()
  try {
    return {
      visibleText,
      brief: parseProductDecisionBrief(JSON.parse(raw) as unknown),
      error: null,
    }
  } catch (error) {
    return {
      visibleText,
      brief: null,
      error: error instanceof Error ? error.message : 'Карточка не прошла проверку',
    }
  }
}

function bullets(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join('\n')
}

/** The exact human-readable brief whose hash the owner accepts. */
export function renderProductDecisionBrief(brief: ProductDecisionBrief): string {
  return [
    'Рекомендация',
    brief.title,
    '',
    'Точная формулировка',
    brief.decision,
    '',
    'Определения и границы',
    bullets(brief.boundaries),
    '',
    'Почему',
    brief.reason,
    '',
    'Альтернативы',
    bullets(brief.alternatives),
    '',
    'Основания и допущения',
    bullets(brief.evidence),
    '',
    'Затронуто',
    bullets(brief.affected),
    '',
    'Проверка',
    brief.verification,
    '',
    `Заменяет: ${brief.supersedes ?? 'нет'}`,
    `Review: ${brief.reviewAt ?? 'без даты'}`,
  ].join('\n')
}

export function productDecisionHash(brief: ProductDecisionBrief): string {
  return createHash('sha256').update(renderProductDecisionBrief(brief), 'utf8').digest('hex')
}

export function productDecisionButtons(
  token: string,
  version: number,
): NonNullable<TextTurnResult['buttons']> {
  return [
    [{ text: `✅ Принять и зафиксировать v${version}`, callbackData: `dx:d:${token}:accept` }],
    [
      { text: '✏️ Изменить', callbackData: `dx:d:${token}:edit` },
      { text: '📊 Нужны данные', callbackData: `dx:d:${token}:data` },
    ],
    [{ text: '❌ Отклонить', callbackData: `dx:d:${token}:reject` }],
  ]
}

export function renderProductDecisionCard(input: {
  brief: ProductDecisionBrief
  version: number
  hash: string
}): string {
  return [
    `Новая карточка Capacity · версия ${input.version}`,
    `SHA-256: ${input.hash}`,
    '',
    renderProductDecisionBrief(input.brief),
    '',
    'После принятия карточка будет отправлена в Git. Код и работающий сервис не изменятся.',
  ].join('\n')
}

export function productDecisionAgentInstruction(input: {
  mode: ProductDecisionMode
  version: number
  currentBrief: ProductDecisionBrief | null
  ownerText: string
}): string {
  const mode = input.mode === 'research' ? 'Исследуем' : input.mode === 'fix' ? 'Фиксируем' : 'Меняем'
  const current = input.currentBrief === null
    ? 'Нет предыдущей версии карточки.'
    : `Текущая версия карточки:\n${JSON.stringify(input.currentBrief, null, 2)}`
  return [
    'PRODUCT DECISION R1 — READ-ONLY DISCUSSION.',
    `Режим: ${mode}. Следующая версия карточки: ${input.version}.`,
    'Не изменяй файлы, Git, runtime или внешние системы до отдельного принятия карточки владельцем.',
    'Сам изучи доступный контекст. Сначала предложи целостное понимание фразой «Я правильно понял, что …?». Не задавай анкету из терминов.',
    'Если остаётся одна существенная неоднозначность, задай один конкретный вопрос и объясни, что изменит ответ.',
    'Не придумывай причину или evidence: используй буквальное «Причина не зафиксирована.» или «Данных нет.» только когда владелец это подтвердил.',
    input.mode === 'change'
      ? 'Для режима Меняем найди действующую карточку и укажи её точный ID в supersedes.'
      : 'Для новой карточки supersedes должен быть null.',
    'Когда смысл, границы и причина подтверждены и карточка готова к принятию, добавь ровно один служебный блок в конец ответа:',
    BRIEF_START,
    JSON.stringify({
      schema: 1,
      domain: 'capacity',
      policyKey: 'capacity.server_user_slots',
      slug: 'server-user-slots',
      title: 'Короткое название',
      supersedes: null,
      decision: 'Точная формулировка решения и поведение на границе.',
      boundaries: ['Определение и граница действия.'],
      reason: 'Подтверждённая причина или буквальная неизвестность.',
      alternatives: ['Вариант и почему не выбран.'],
      evidence: ['Факт, ссылка или явное допущение.'],
      affected: ['Система или продуктовая поверхность.'],
      verification: 'Проверяемый сигнал результата.',
      reviewAt: null,
      implementation: ['Не реализовано.'],
    }, null, 2),
    BRIEF_END,
    'Не показывай служебный блок раньше готовности. Вне блока отвечай владельцу обычным русским языком.',
    current,
    `СООБЩЕНИЕ ВЛАДЕЛЬЦА:\n${input.ownerText}`,
  ].join('\n\n')
}
