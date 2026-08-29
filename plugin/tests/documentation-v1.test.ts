import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

async function document(name: string): Promise<string> {
  return Bun.file(join(ROOT, 'docs', name)).text()
}

describe('v1 operator documentation', () => {
  test('covers both supported installs and the restart acceptance flow', async () => {
    const installation = await document('codex-installation.md')
    expect(installation).toContain('## systemd installation')
    expect(installation).toContain('## Docker Compose installation')
    expect(installation).toContain('LoadCredential')
    expect(installation).toContain('codex login --device-auth')
    expect(installation).toContain('## First-run and restart acceptance')
    expect(installation).toContain('confirm `/status` still reports the same thread')
    expect(installation).not.toContain('DASHI_TELEGRAM_BOT_TOKEN=')
  })

  test('requires a backup before upgrade and a database restore for safe rollback', async () => {
    const upgrade = await document('codex-upgrade.md')
    const backup = upgrade.indexOf('backup:codex')
    const stop = upgrade.indexOf('systemctl stop')
    expect(backup).toBeGreaterThan(0)
    expect(stop).toBeGreaterThan(backup)
    expect(upgrade).toContain('--no-activate')
    expect(upgrade).toContain('activate --prefix')
    expect(upgrade).toContain('rollback --prefix')
    expect(upgrade).toContain('restore:codex')
    expect(upgrade).toContain('`docker compose down -v` is destructive')
  })

  test('states honest delivery and trust boundaries', async () => {
    const security = await document('codex-security.md')
    expect(security).toContain('does not claim end-to-end exactly-once delivery')
    expect(security).toContain('becomes `AMBIGUOUS` and never auto-retries')
    expect(security).toContain('Public bots')
    expect(security).toContain('M5 72-hour live Telegram/Codex canary')
    expect(security).toContain('Checksums detect corruption; publisher authentication requires a release signature')
  })

  test('explains why the daemon is not packaged as a Codex plugin', async () => {
    const installation = await document('codex-installation.md')
    expect(installation).toContain('## Why v1 is not a `.codex-plugin`')
    expect(installation).toContain('always-on daemon with SQLite, Telegram polling')
    expect(installation).toContain('one standalone runtime')
  })
})
