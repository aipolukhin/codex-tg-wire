import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FinalArtifactDelivery } from '../../src/bridge/contracts.js'
import {
  GitWorkspaceControl,
  sanitizedGitEnvironment,
} from '../../src/bridge/git-workspace-control.js'

const NOW = 1_800_000_000_000

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let root: string
let workspace: string
let remote: string
let control: GitWorkspaceControl

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-git-control-'))
  workspace = join(root, 'workspace')
  remote = join(root, 'remote.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote])
  execFileSync('git', ['init', '--initial-branch=main', workspace])
  git(workspace, ['config', 'user.name', 'Codex Test'])
  git(workspace, ['config', 'user.email', 'codex@example.test'])
  writeFileSync(join(workspace, 'README.md'), 'initial\n')
  git(workspace, ['add', 'README.md'])
  git(workspace, ['commit', '-m', 'initial'])
  git(workspace, ['remote', 'add', 'origin', remote])
  git(workspace, ['push', '--set-upstream', 'origin', 'main'])
  control = new GitWorkspaceControl([{ id: 'workspace', cwd: workspace }])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function completionInput(): FinalArtifactDelivery {
  return {
    update: {
      id: 1,
      botId: 'primary',
      updateId: 7,
      chatId: '7001',
      routingClass: 'MESSAGE',
      payload: {},
      state: 'LEASED',
      attemptCount: 1,
      availableAtMs: NOW,
      leaseOwner: 'worker',
      leaseExpiresAtMs: NOW + 60_000,
      receivedAtMs: NOW,
      processedAtMs: null,
      lastError: null,
    },
    message: { chatId: '7001', projectId: 'workspace', text: 'change it' },
    result: { threadId: 'thread-1', turnId: 'turn-1', finalText: 'done' },
    sourceKey: 'telegram:primary:7:turn:completion',
    dependsOnSourceKey: 'telegram:primary:7:turn:final',
    nowMs: NOW,
  }
}

function callback(delivery: { payload: unknown }, action: string): string {
  const keyboard = (delivery.payload as {
    options: { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
  }).options.reply_markup.inline_keyboard
  const button = keyboard.flat().find((candidate) => candidate.callback_data.endsWith(`:${action}`))
  if (button === undefined) throw new Error(`missing ${action} button`)
  return button.callback_data
}

function callbackParts(value: string): { token: string; action: string } {
  const match = value.match(/^dx:g:([a-f0-9]{12}):(\d+):(.+)$/)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error('invalid callback')
  }
  return { token: match[1], action: `${match[2]}:${match[3]}` }
}

describe('GitWorkspaceControl', () => {
  test('never forwards bridge or model credentials to Git subprocesses', () => {
    expect(sanitizedGitEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/test',
      SSH_AUTH_SOCK: '/run/agent.sock',
      TELEGRAM_BOT_TOKEN: 'bot-secret',
      OPENAI_API_KEY: 'model-secret',
      GIT_ASKPASS: '/tmp/untrusted-helper',
    })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/test',
      SSH_AUTH_SOCK: '/run/agent.sock',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    })
  })

  test('builds an ordered durable card with exact workspace counts and all actions', async () => {
    writeFileSync(join(workspace, 'README.md'), 'changed\n')
    writeFileSync(join(workspace, 'new.txt'), 'new\n')

    const deliveries = await control.buildTurnCompletionDeliveries(completionInput())
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      sourceKey: 'telegram:primary:7:turn:completion',
      dependsOnSourceKey: 'telegram:primary:7:turn:final',
      kind: 'send_text',
      payload: { chatId: '7001' },
    })
    expect((deliveries[0]?.payload as { text: string }).text).toContain(
      'От HEAD: 2 незакоммиченных файлов',
    )
    const callbacks = ['commit', 'push', 'commit-push'].map((action) =>
      callback(deliveries[0]!, action))
    expect(callbacks.every((value) => value.length < 64)).toBeTrue()
    expect((deliveries[0]?.payload as {
      options: { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }
    }).options.reply_markup.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'Commit changes',
      'Push',
      'Commit & push',
    ])
  })

  test('commits and pushes through snapshot-guarded idempotent actions', async () => {
    writeFileSync(join(workspace, 'README.md'), 'changed once\n')
    const card = (await control.buildTurnCompletionDeliveries(completionInput()))[0]!
    const commit = callbackParts(callback(card, 'commit'))
    const committed = await control.handleAction(commit.token, commit.action)
    expect(committed.text).toContain('Изменения закоммичены')
    expect(git(workspace, ['status', '--porcelain'])).toBe('')
    expect(git(workspace, ['rev-list', '--count', '@{upstream}..HEAD']).trim()).toBe('1')

    const stale = await control.handleAction(commit.token, commit.action)
    expect(stale.text).toContain('Карточка устарела')
    expect(git(workspace, ['rev-list', '--count', '@{upstream}..HEAD']).trim()).toBe('1')

    const pushButton = stale.buttons.flat().find((button) =>
      'callbackData' in button && button.callbackData.endsWith(':push'))
    if (pushButton === undefined || !('callbackData' in pushButton)) throw new Error('missing push')
    const push = callbackParts(pushButton.callbackData)
    const pushed = await control.handleAction(push.token, push.action)
    expect(pushed.text).toContain('Коммиты запушены')
    expect(git(workspace, ['rev-list', '--count', '@{upstream}..HEAD']).trim()).toBe('0')

    writeFileSync(join(workspace, 'new.txt'), 'second change\n')
    const second = (await control.buildTurnCompletionDeliveries(completionInput()))[0]!
    const both = callbackParts(callback(second, 'commit-push'))
    const completed = await control.handleAction(both.token, both.action)
    expect(completed.text).toContain('закоммичены и запушены')
    expect(git(workspace, ['status', '--porcelain'])).toBe('')
    expect(git(workspace, ['rev-parse', 'HEAD']).trim()).toBe(
      git(workspace, ['rev-parse', '@{upstream}']).trim(),
    )
  })

  test('ignores non-git projects instead of blocking the final response', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const plainControl = new GitWorkspaceControl([{ id: 'workspace', cwd: plain }])
    expect(await plainControl.buildTurnCompletionDeliveries(completionInput())).toEqual([])
  })
})
