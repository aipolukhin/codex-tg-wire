import { createHmac } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  ProductHomeAuthError,
  telegramInitDataFromRequest,
  verifyTelegramInitData,
} from '../../src/product-home/auth.js'

const TOKEN = '123456789:test-token'
const NOW_MS = Date.UTC(2026, 8, 1, 12, 0, 0)

function signedInitData(input: {
  token?: string
  userId?: number
  authDate?: number
  extra?: Record<string, string>
} = {}): string {
  const values = new Map<string, string>([
    ['auth_date', String(input.authDate ?? Math.floor(NOW_MS / 1_000))],
    ['query_id', 'AAE-test-query'],
    ['user', JSON.stringify({ id: input.userId ?? 7001, first_name: 'Owner' })],
    ...Object.entries(input.extra ?? {}),
  ])
  const check = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(input.token ?? TOKEN).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams([...values, ['hash', hash]]).toString()
}

describe('Product Home Telegram initData authentication', () => {
  test('accepts a fresh signed owner payload', () => {
    expect(verifyTelegramInitData(signedInitData(), {
      botToken: TOKEN,
      allowedUserIds: ['7001'],
      maxAgeSeconds: 3_600,
      nowMs: NOW_MS,
    })).toEqual({ userId: '7001', authDate: Math.floor(NOW_MS / 1_000), queryId: 'AAE-test-query' })
  })

  test('rejects a bad signature, stale payload and non-owner', () => {
    const options = {
      botToken: TOKEN,
      allowedUserIds: ['7001'],
      maxAgeSeconds: 3_600,
      nowMs: NOW_MS,
    }
    expect(() => verifyTelegramInitData(signedInitData({ token: 'wrong' }), options))
      .toThrow(ProductHomeAuthError)
    expect(() => verifyTelegramInitData(signedInitData({
      authDate: Math.floor(NOW_MS / 1_000) - 3_601,
    }), options)).toThrow('expired')
    expect(() => verifyTelegramInitData(signedInitData({ userId: 7002 }), options))
      .toThrow('not allowed')
  })

  test('rejects duplicate fields even when the first signature is valid', () => {
    expect(() => verifyTelegramInitData(`${signedInitData()}&auth_date=1`, {
      botToken: TOKEN,
      allowedUserIds: ['7001'],
      maxAgeSeconds: 3_600,
      nowMs: NOW_MS,
    })).toThrow('duplicate')
  })

  test('reads only the tma Authorization scheme', () => {
    const raw = signedInitData()
    expect(telegramInitDataFromRequest(new Request('https://example.test', {
      headers: { authorization: `tma ${raw}` },
    }))).toBe(raw)
    expect(() => telegramInitDataFromRequest(new Request('https://example.test')))
      .toThrow(ProductHomeAuthError)
    expect(() => telegramInitDataFromRequest(new Request('https://example.test', {
      headers: { authorization: `Bearer ${raw}` },
    }))).toThrow(ProductHomeAuthError)
  })
})
