import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..')
const INSTALLER = join(REPOSITORY_ROOT, 'install.sh')

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function executable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 })
  chmodSync(path, 0o700)
}

describe('one-command user installer', () => {
  test('creates a private, restart-safe user service without leaking the token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-tg-wire-installer-'))
    roots.push(root)
    const home = join(root, 'home with space')
    const configRoot = join(root, 'config with space')
    const dataRoot = join(root, 'data with space')
    const configDirectory = join(configRoot, 'codex-tg-wire')
    const stateDirectory = join(dataRoot, 'codex-tg-wire')
    const project = join(root, 'project with space')
    const fakeBin = join(root, 'fake-bin')
    const systemctlLog = join(root, 'systemctl.log')
    const tokenSource = join(root, 'telegram-token-source')
    const groqSource = join(root, 'groq-key-source')
    const codex = join(fakeBin, 'codex')
    const bunInstaller = join(root, 'bun-install.sh')
    const bunInstall = join(home, '.bun')
    const token = '123456789:test-secret-token'
    const groqKey = 'gsk_test-private-voice-key'
    for (const directory of [home, project, fakeBin]) mkdirSync(directory, { recursive: true })
    writeFileSync(tokenSource, `${token}\n`, { mode: 0o600 })
    writeFileSync(groqSource, `${groqKey}\n`, { mode: 0o600 })
    executable(codex, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'codex-cli 0.149.1\\n'
  exit 0
fi
if [ "\${1:-}" = "login" ] && [ "\${2:-}" = "status" ]; then
  printf 'Logged in using test credentials\\n'
  exit 0
fi
exit 2
`)
    executable(bunInstaller, `#!/bin/sh
set -eu
mkdir -p "$BUN_INSTALL/bin"
ln -sf "$REAL_BUN" "$BUN_INSTALL/bin/bun"
printf '%s\\n' "\${1:-}" > "$BUN_INSTALL/requested-version"
`)
    executable(join(fakeBin, 'curl'), `#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[ -n "$output" ]
cp "$FAKE_BUN_INSTALLER" "$output"
`)
    executable(join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
`)

    const environment = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      CODEX_BINARY_PATH: codex,
      BUN_INSTALL: bunInstall,
      REAL_BUN: process.execPath,
      FAKE_BUN_INSTALLER: bunInstaller,
      SYSTEMCTL_LOG: systemctlLog,
      PATH: `${fakeBin}:/usr/bin:/bin`,
    }
    const command = [
      'bash',
      INSTALLER,
      '--project', project,
      '--telegram-user', '123456789',
      '--telegram-chat', '-1001234567890',
      '--token-file', tokenSource,
      '--groq-key-file', groqSource,
      '--state-dir', stateDirectory,
      '--config-dir', configDirectory,
      '--skip-deps',
      '--offline',
      '--no-start',
    ]
    const first = Bun.spawnSync({ cmd: command, cwd: root, env: environment })
    const stdout = first.stdout.toString()
    const stderr = first.stderr.toString()
    expect(first.exitCode, `${stdout}\n${stderr}`).toBe(0)

    const configPath = join(configDirectory, 'bridge.config.json')
    const credentialPath = join(configDirectory, 'telegram-token')
    const groqCredentialPath = join(configDirectory, 'groq-api-key')
    const unitPath = join(configRoot, 'systemd/user/codex-tg-wire.service')
    const config = JSON.parse(await Bun.file(configPath).text()) as {
      stateDatabase: string
      projects: Array<{ cwd: string; sandboxMode: string }>
      telegram: { allowedUserIds: string[]; allowedChatIds: string[] }
      codex: { approvalPolicy: string; sandboxMode: string }
      voice: { provider: string }
    }
    expect(config.stateDatabase).toBe(join(stateDirectory, 'bridge.sqlite3'))
    expect(config.projects[0]?.cwd).toBe(project)
    expect(config.projects[0]?.sandboxMode).toBe('danger-full-access')
    expect(config.codex).toMatchObject({
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    })
    expect(config.voice.provider).toBe('groq')
    expect(config.telegram.allowedUserIds).toEqual(['123456789'])
    expect(config.telegram.allowedChatIds).toEqual(['-1001234567890'])
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600)
    expect(statSync(groqCredentialPath).mode & 0o777).toBe(0o600)
    expect(statSync(unitPath).mode & 0o777).toBe(0o600)
    expect((await Bun.file(credentialPath).text()).trim()).toBe(token)
    expect((await Bun.file(groqCredentialPath).text()).trim()).toBe(groqKey)

    const unit = await Bun.file(unitPath).text()
    expect(unit).toContain(`WorkingDirectory="${join(REPOSITORY_ROOT, 'plugin')}"`)
    expect(unit).toContain(`Environment="CODEX_BINARY_PATH=${codex}"`)
    expect(unit).toContain(`ExecStart="${join(bunInstall, 'bin/bun')}" run start:codex`)
    expect(unit).toContain(`Environment="DASHI_CODEX_BRIDGE_CONFIG=${configPath}"`)
    expect(unit).toContain(`Environment="GROQ_API_KEY_FILE=${groqCredentialPath}"`)
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).not.toContain(token)
    expect(unit).not.toContain(groqKey)
    expect(unit).not.toContain('User=dashi')
    expect(unit).not.toContain('ProtectHome=true')
    expect(unit).not.toContain('/srv/')
    expect(stdout).toContain('CODEX · TG · WIRE')
    expect(stdout).toContain(`Installing pinned Bun 1.4.0 in ${bunInstall}`)
    expect(stdout).toContain('Шаг 4 из 4')
    expect(stdout).toContain('YOLO: approvalPolicy=never · sandbox=danger-full-access')
    expect(stdout).not.toContain(token)
    expect(stdout).not.toContain(groqKey)
    expect(stderr).not.toContain(token)
    expect(stderr).not.toContain(groqKey)
    expect(await Bun.file(join(bunInstall, 'requested-version')).text()).toBe('bun-v1.4.0\n')
    const frameLines = stdout.split('\n').filter((line) => /^[╭│╰]/u.test(line))
    expect(new Set(frameLines.map((line) => [...line].length))).toEqual(new Set([46]))

    const systemctlCalls = await Bun.file(systemctlLog).text()
    expect(systemctlCalls).toContain('--user show-environment')
    expect(systemctlCalls).toContain('--user daemon-reload')
    expect(systemctlCalls).toContain('--user enable codex-tg-wire.service')
    expect(systemctlCalls).not.toContain('restart')

    const second = Bun.spawnSync({
      cmd: [
        'bash', INSTALLER,
        '--config-dir', configDirectory,
        '--state-dir', stateDirectory,
        '--skip-deps', '--offline', '--no-start',
      ],
      cwd: root,
      env: environment,
    })
    expect(second.exitCode, `${second.stdout.toString()}\n${second.stderr.toString()}`).toBe(0)
    expect(second.stdout.toString()).toContain('Keeping the existing bridge configuration')
    expect((await Bun.file(credentialPath).text()).trim()).toBe(token)
    expect((await Bun.file(groqCredentialPath).text()).trim()).toBe(groqKey)

    const uninstall = Bun.spawnSync({
      cmd: [
        'bash', INSTALLER, '--uninstall',
        '--config-dir', configDirectory,
        '--state-dir', stateDirectory,
      ],
      cwd: root,
      env: environment,
    })
    expect(uninstall.exitCode, uninstall.stderr.toString()).toBe(0)
    await expect(Bun.file(unitPath).exists()).resolves.toBeFalse()
    await expect(Bun.file(configPath).exists()).resolves.toBeTrue()
    await expect(Bun.file(credentialPath).exists()).resolves.toBeTrue()
    expect(await Bun.file(systemctlLog).text()).toContain(
      '--user disable --now codex-tg-wire.service',
    )
  })

  test('starts token-only bot-first onboarding without asking for project or Telegram ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-tg-wire-bot-first-'))
    roots.push(root)
    const home = join(root, 'home')
    const configRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    const configDirectory = join(configRoot, 'codex-tg-wire')
    const stateDirectory = join(dataRoot, 'codex-tg-wire')
    const fakeBin = join(root, 'fake-bin')
    const tokenSource = join(root, 'telegram-token-source')
    const systemctlLog = join(root, 'systemctl.log')
    const codex = join(fakeBin, 'codex')
    const fakeBootstrap = join(root, 'fake-bootstrap')
    const token = '123456789:test-secret-token'
    mkdirSync(home, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(tokenSource, `${token}\n`, { mode: 0o600 })
    executable(codex, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf 'codex-cli 0.149.1\\n'; exit 0; fi
if [ "\${1:-}" = "login" ] && [ "\${2:-}" = "status" ]; then exit 0; fi
exit 2
`)
    executable(join(fakeBin, 'bun'), `#!/bin/bash
set -eu
if [[ "\${1:-}" == "--version" ]]; then printf '1.4.0\\n'; exit 0; fi
if [[ "\${1:-}" == *codex-bridge-bootstrap-init.ts ]]; then shift; exec "$FAKE_BOOTSTRAP" "$@"; fi
exec "$REAL_BUN" "$@"
`)
    executable(fakeBootstrap, `#!/bin/bash
set -eu
config=''
state=''
project=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-dir) config="$2"; shift 2 ;;
    --state-dir) state="$2"; shift 2 ;;
    --default-project) project="$2"; shift 2 ;;
    --deployment|--profile) shift 2 ;;
    *) exit 2 ;;
  esac
done
mkdir -p "$config" "$state"
token_value="$(command cat)"
printf '%s\\n' "$token_value" > "$config/telegram-token"
: > "$config/groq-api-key"
printf 'DASHI_CODEX_BRIDGE_CONFIG="%s/bridge.config.json"\\n' "$config" > "$config/bridge.env"
printf '{"botUsername":"codex_wire_test_bot","nonce":"owner_nonce_1234567890"}\\n' > "$config/bootstrap-state.json"
chmod 600 "$config/telegram-token" "$config/groq-api-key" "$config/bridge.env" "$config/bootstrap-state.json"
printf 'https://t.me/codex_wire_test_bot?start=owner_nonce_1234567890\\n'
`)
    executable(join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
`)
    const command = [
      'bash', INSTALLER,
      '--token-file', tokenSource,
      '--config-dir', configDirectory,
      '--state-dir', stateDirectory,
      '--skip-deps', '--offline', '--no-start',
    ]
    const result = Bun.spawnSync({
      cmd: command,
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configRoot,
        XDG_DATA_HOME: dataRoot,
        CODEX_BINARY_PATH: codex,
        SYSTEMCTL_LOG: systemctlLog,
        FAKE_BOOTSTRAP: fakeBootstrap,
        REAL_BUN: process.execPath,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        TERM: 'dumb',
      },
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0)
    await expect(Bun.file(join(configDirectory, 'bridge.config.json')).exists()).resolves.toBeFalse()
    await expect(Bun.file(join(configDirectory, 'bootstrap-state.json')).exists()).resolves.toBeTrue()
    expect((await Bun.file(join(configDirectory, 'telegram-token')).text()).trim()).toBe(token)
    expect(stdout).toContain('Bot token проверен')
    expect(stdout).toContain('https://t.me/codex_wire_test_bot?start=owner_nonce_1234567890')
    expect(stdout).not.toContain(token)
    expect(stderr).not.toContain(token)
    const unit = await Bun.file(join(configRoot, 'systemd/user/codex-tg-wire.service')).text()
    expect(unit).toContain(`Environment="CODEX_TG_WIRE_BOOTSTRAP_FILE=${join(configDirectory, 'bootstrap-state.json')}"`)
  })
})
