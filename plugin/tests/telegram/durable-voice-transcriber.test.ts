import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentLocalAttachment } from '../../src/bridge/contracts.js'
import { GroqVoiceTranscriber } from '../../src/telegram/durable-voice-transcriber.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function audio(): AgentLocalAttachment {
  const root = mkdtempSync(join(tmpdir(), 'dashi-voice-'))
  roots.push(root)
  const path = join(root, 'voice.oga')
  const bytes = new TextEncoder().encode('OggSvoice-data')
  writeFileSync(path, bytes, { mode: 0o600 })
  return {
    kind: 'audio', path, fileName: 'voice.oga', mimeType: 'audio/ogg', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

describe('GroqVoiceTranscriber', () => {
  test('uploads only a hash-verified stable path and normalizes the Telegram extension', async () => {
    const attachment = audio()
    const requests: Array<{ url: string; auth: string; fileName: string }> = []
    const transcriber = new GroqVoiceTranscriber({
      apiKey: 'secret-groq-key',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData
        const file = form.get('file') as File
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization') ?? '',
          fileName: file.name,
        })
        return new Response('  готово\u0000  ', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await transcriber.transcribe(attachment)).toEqual({ status: 'ok', transcript: 'готово' })
    expect(requests).toEqual([{
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      auth: 'Bearer secret-groq-key',
      fileName: 'voice.ogg',
    }])
  })

  test('refuses a changed file before any provider request and never returns provider secrets', async () => {
    const attachment = audio()
    writeFileSync(attachment.path, 'OggStamper-data', { mode: 0o600 })
    let requests = 0
    const transcriber = new GroqVoiceTranscriber({
      apiKey: 'secret-groq-key',
      fetchImpl: (async () => {
        requests += 1
        return new Response('secret-groq-key', { status: 500 })
      }) as unknown as typeof fetch,
    })
    expect(await transcriber.transcribe(attachment)).toEqual({ status: 'failed' })
    expect(requests).toBe(0)
  })

  test('requires an HTTPS provider endpoint', () => {
    expect(() => new GroqVoiceTranscriber({ apiKey: 'key', apiRoot: 'http://localhost/v1' }))
      .toThrow('HTTPS')
  })
})
