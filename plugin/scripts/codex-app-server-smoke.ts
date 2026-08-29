#!/usr/bin/env bun

import compatibility from '../codex-app-server.compatibility.json'
import { CodexAppServerClient } from '../src/codex/app-server-client.js'

const client = CodexAppServerClient.spawn({
  onStderr: (chunk) => process.stderr.write(chunk),
  requestTimeoutMs: 15_000,
})

try {
  const initialized = await client.initialize({
    clientInfo: {
      name: 'dashi_codex_bridge',
      title: 'codex-tg-wire',
      version: compatibility.bridgeVersion,
    },
    capabilities: null,
  })
  const models = await client.listModels({ limit: 100, includeHidden: false })
  const defaults = models.data.filter((model) => model.isDefault).map((model) => model.id)

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        userAgent: initialized.userAgent,
        platform: `${initialized.platformFamily}/${initialized.platformOs}`,
        visibleModels: models.data.length,
        defaultModels: defaults,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await client.close()
}
