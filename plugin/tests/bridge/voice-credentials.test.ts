import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GroqCredentialManager } from '../../src/bridge/voice-credentials.js'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('GroqCredentialManager', () => {
  test('validates remotely and writes an atomic owner-only credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'groq-credential-'))
    roots.push(root)
    const config = join(root, 'config')
    mkdirSync(config, { mode: 0o700 })
    const path = join(config, 'groq-api-key')
    let authorization = ''
    const manager = new GroqCredentialManager(path, {
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://api.groq.com/openai/v1/models')
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return Promise.resolve(new Response('{}'))
      }) as unknown as typeof fetch,
    })
    const key = 'gsk_1234567890abcdefghijklmnop'

    expect(manager.isConfigured()).toBeFalse()
    await manager.install(key)
    expect(manager.isConfigured()).toBeTrue()
    expect(manager.read()).toBe(key)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(authorization).toBe(`Bearer ${key}`)
  })

  test('does not persist malformed or rejected keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'groq-credential-'))
    roots.push(root)
    const path = join(root, 'groq-api-key')
    const manager = new GroqCredentialManager(path, {
      fetchImpl: (() => Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch,
    })

    await expect(manager.install('not-a-key')).rejects.toThrow('invalid format')
    await expect(manager.install('gsk_1234567890abcdefghijklmnop')).rejects.toThrow('rejected')
    expect(manager.isConfigured()).toBeFalse()
  })
})
