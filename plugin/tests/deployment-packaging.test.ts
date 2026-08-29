import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import compatibility from '../codex-app-server.compatibility.json'
import pkg from '../package.json'

const ROOT = join(import.meta.dir, '..')

async function text(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text()
}

describe('v1 deployment packaging', () => {
  test('pins one Codex CLI and Bun version across Docker inputs', async () => {
    const dockerfile = await text('Dockerfile')
    const compose = await text('deploy/docker/compose.yaml')
    const dockerEnvironment = await text('deploy/docker/.env.example')
    const bunVersion = pkg.packageManager.replace(/^bun@/, '')

    expect(dockerfile).toContain(`ARG CODEX_CLI_VERSION=${compatibility.codexCliVersion}`)
    expect(compose).toContain(`CODEX_CLI_VERSION: \${CODEX_CLI_VERSION:-${compatibility.codexCliVersion}}`)
    expect(dockerEnvironment).toContain(`CODEX_CLI_VERSION=${compatibility.codexCliVersion}`)
    expect(dockerfile).toContain(`ARG BUN_VERSION=${bunVersion}`)
    expect(compose).toContain(`BUN_VERSION: \${BUN_VERSION:-${bunVersion}}`)
    expect(dockerEnvironment).toContain(`BUN_VERSION=${bunVersion}`)
  })

  test('keeps the container non-root, read-only and secret-free by default', async () => {
    const dockerfile = await text('Dockerfile')
    const compose = await text('deploy/docker/compose.yaml')
    const ignore = await text('.dockerignore')
    const bridgeEnvironment = await text('deploy/docker/bridge.env.example')

    expect(dockerfile).toContain('ARG DASHI_UID=10001')
    expect(dockerfile).toContain('ARG DASHI_GID=10001')
    expect(dockerfile).toContain('USER ${DASHI_UID}:${DASHI_GID}')
    expect(compose).toContain('user: "${DASHI_UID:-10001}:${DASHI_GID:-10001}"')
    expect(compose).toContain('read_only: true')
    expect(compose).toContain('no-new-privileges:true')
    expect(compose).toContain('cap_drop:')
    expect(compose).toContain('source: ${DASHI_PROJECT_PATH:?')
    expect(ignore).toContain('bridge.config.json')
    expect(ignore).toContain('.env')
    expect(compose).toContain('DASHI_TELEGRAM_BOT_TOKEN_FILE: /run/secrets/telegram-token')
    expect(compose).toContain('DASHI_TELEGRAM_TOKEN_FILE:-./telegram-token')
    expect(bridgeEnvironment).not.toContain('DASHI_TELEGRAM_BOT_TOKEN=')
  })

  test('ships a notify/watchdog systemd unit with private state', async () => {
    const unit = await text('deploy/systemd/dashi-codex-bridge.service')

    expect(unit).toContain('Type=notify')
    expect(unit).toContain('LoadCredential=telegram-token:')
    expect(unit).toContain('WatchdogSec=180s')
    expect(unit).toContain('StateDirectory=dashi-codex-bridge')
    expect(unit).toContain('ConfigurationDirectory=dashi-codex-bridge')
    expect(unit).toContain('UMask=0077')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('ProtectSystem=full')
    expect(unit).toContain('ProtectHome=true')
    expect(unit).not.toContain('<service-user>')
  })
})
