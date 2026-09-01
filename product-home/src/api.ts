import { retrieveRawInitData } from '@tma.js/sdk-react'

import type { DecisionDetail, DecisionsResponse } from '@/types.ts'

const apiRoot = new URL('api/v1/', new URL(import.meta.env.BASE_URL, window.location.origin)).toString()

function telegramAuthorization(): string {
  const raw = retrieveRawInitData()
  if (raw === undefined || raw.length === 0) {
    throw new Error('Открой Product Home кнопкой в Telegram.')
  }
  return `tma ${raw}`
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, apiRoot), {
    headers: { Authorization: telegramAuthorization() },
    cache: 'no-store',
  })
  if (response.status === 401) throw new Error('Сессия Telegram истекла. Закрой и открой Product Home снова.')
  if (!response.ok) throw new Error('Product Home сейчас недоступен. Принятые карточки остаются в Git.')
  return await response.json() as T
}

export function loadDecisions(input: {
  query?: string
  domain?: string
  view?: 'all' | 'active' | 'review' | 'superseded' | 'implementation'
} = {}): Promise<DecisionsResponse> {
  const search = new URLSearchParams()
  if (input.query?.trim()) search.set('query', input.query.trim())
  if (input.domain) search.set('domain', input.domain)
  if (input.view && input.view !== 'all') search.set('view', input.view)
  const suffix = search.size === 0 ? '' : `?${search.toString()}`
  return request<DecisionsResponse>(`decisions${suffix}`)
}

export async function loadDecision(id: string): Promise<DecisionDetail> {
  const body = await request<{ decision: DecisionDetail }>(`decisions/${encodeURIComponent(id)}`)
  return body.decision
}
