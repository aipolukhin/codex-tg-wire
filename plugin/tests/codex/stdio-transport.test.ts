import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServerClient } from '../../src/codex/app-server-client.js'

const FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-app-server.mjs', import.meta.url),
)

describe('StdioAppServerTransport', () => {
  test('talks JSONL to a real subprocess and closes it', async () => {
    const client = CodexAppServerClient.spawn({
      command: process.execPath,
      args: [FIXTURE],
      requestTimeoutMs: 2_000,
    })
    const notifications: string[] = []
    client.onNotification((event) => {
      notifications.push(event.method)
    })

    const initialized = await client.initialize({
      clientInfo: {
        name: 'dashi_codex_bridge_test',
        title: 'Dashi Codex Bridge Test',
        version: '0.1.0',
      },
      capabilities: null,
    })
    const models = await client.listModels()

    expect(initialized.userAgent).toBe('fake-app-server/1')
    expect(models.data.map((model) => model.id)).toEqual(['fake-model'])
    expect(notifications).toEqual(['server/ready'])

    await client.close()
    expect(client.closed).toBe(true)
  })
})
