import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import compatibility from '../codex-app-server.compatibility.json'
import pkg from '../package.json'

const ROOT = join(import.meta.dir, '..')
const REPOSITORY_ROOT = join(ROOT, '..')

async function text(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text()
}

describe('v1 deployment packaging', () => {
  test('pins one Codex CLI and Bun version across Docker inputs', async () => {
    const dockerfile = await text('Dockerfile')
    const compose = await text('deploy/docker/compose.yaml')
    const dockerEnvironment = await text('deploy/docker/.env.example')
    const bunVersion = pkg.packageManager.replace(/^bun@/, '')

    expect(pkg.dependencies['@openai/codex']).toBe(compatibility.codexCliVersion)
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
    const dockerWrapper = await Bun.file(join(REPOSITORY_ROOT, 'docker.sh')).text()

    expect(dockerfile).toContain('ARG CODEX_TG_WIRE_UID=10001')
    expect(dockerfile).toContain('ARG CODEX_TG_WIRE_GID=10001')
    expect(dockerfile).toContain('USER ${CODEX_TG_WIRE_UID}:${CODEX_TG_WIRE_GID}')
    expect(dockerfile).toContain('FROM base AS runtime')
    expect(compose).toContain('user: "${CODEX_TG_WIRE_UID:?')
    expect(compose).toContain('read_only: true')
    expect(compose).toContain('no-new-privileges:true')
    expect(compose).toContain('cap_drop:')
    expect(compose).toContain('source: ${CODEX_TG_WIRE_PROJECT_PATH:?')
    expect(compose).toContain('target: ${CODEX_TG_WIRE_PROJECT_PATH:?')
    expect(ignore).toContain('bridge.config.json')
    expect(ignore).toContain('.env')
    expect(compose).toContain('DASHI_TELEGRAM_BOT_TOKEN_FILE: /etc/codex-tg-wire/telegram-token')
    expect(compose).toContain('target: /var/lib/codex-tg-wire')
    expect(compose).toContain('CODEX_TG_WIRE_BOOTSTRAP_FILE: /etc/codex-tg-wire/bootstrap-state.json')
    expect(compose).toContain('target: /etc/codex-tg-wire\n        # Bot-first bootstrap')
    expect(compose).not.toContain('DASHI_BRIDGE_IMAGE')
    expect(dockerWrapper).not.toContain('--token VALUE')
    expect(dockerWrapper).toContain('--token-file PATH')
    expect(dockerWrapper).toContain('--groq-key-file PATH')
  })

  test('ships profile-gated setup and official Codex login helpers', async () => {
    const dockerfile = await text('Dockerfile')
    const compose = await text('deploy/docker/compose.yaml')
    const loginEntrypoint = await text('docker/codex-login-entrypoint.sh')
    const dockerWrapper = await Bun.file(join(REPOSITORY_ROOT, 'docker.sh')).text()

    expect(compose).toContain('setup:')
    expect(compose).toContain('codex-login:')
    expect(compose.match(/profiles: \["setup"\]/g)?.length).toBe(2)
    expect(compose).toContain('target: login')
    expect(compose).toContain('127.0.0.1:1455:1456')
    expect(compose).toContain('source: ${CODEX_TG_WIRE_CODEX_HOME:?')
    expect(dockerfile).toContain('FROM base AS login')
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends socat')
    expect(loginEntrypoint).toContain('TCP:127.0.0.1:1455')
    expect(dockerWrapper).toContain('login --device-auth')
    expect(dockerWrapper).toContain('login [--browser]')
    expect(dockerWrapper).toContain('default host installation remains ./install.sh')
    expect(dockerWrapper).toContain('--groq-credential-path /var/lib/codex-tg-wire/credentials/groq-api-key')
  })

  test('builds optional multi-architecture GHCR images only from the Docker workflow', async () => {
    const workflow = await Bun.file(join(REPOSITORY_ROOT, '.github/workflows/docker.yml')).text()

    expect(workflow).toContain('platforms: linux/amd64,linux/arm64')
    expect(workflow).toContain('ghcr.io/${{ github.repository }}')
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')")
    expect(workflow).toContain("push: ${{ startsWith(github.ref, 'refs/tags/v') }}")
    expect(workflow).toContain('target: runtime')
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
