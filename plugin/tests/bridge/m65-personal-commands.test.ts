import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import type {
  AgentBackend,
  AgentNativeThread,
  AgentReviewTarget,
  AgentTextTurnInput,
  CommandOperation,
  PersonalAlphaCommandName,
} from '../../src/bridge/contracts.js'
import { PersonalAlphaCommands } from '../../src/bridge/personal-alpha-commands.js'
import { openDurableDatabase } from '../../src/durable/database.js'
import { SqliteAgentSettingsRepository } from '../../src/durable/settings-repository.js'
import { SqliteSessionRepository } from '../../src/durable/session-repository.js'
import { SqliteOutboxRepository } from '../../src/durable/sqlite-repositories.js'

const NOW = 1_800_000_000_000

class M65Backend implements AgentBackend {
  readonly renamed: Array<{ threadId: string; name: string }> = []
  readonly archived: string[] = []
  readonly unarchived: string[] = []
  readonly compacted: string[] = []
  readonly reviews: AgentReviewTarget[] = []
  readonly threads: AgentNativeThread[]

  constructor(cwd: string) {
    this.threads = [this.thread('native-1', cwd, false)]
  }

  private thread(id: string, cwd: string, archived: boolean): AgentNativeThread {
    return {
      id,
      cwd,
      name: id === 'native-1' ? 'Telegram bridge work' : null,
      preview: 'Improve the bridge',
      createdAtSeconds: 1,
      updatedAtSeconds: 2,
      status: 'idle',
      archived,
    }
  }

  async listModels() {
    return [{
      id: 'gpt-main',
      model: 'gpt-main',
      displayName: 'GPT Main',
      isDefault: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    }]
  }

  async runTextTurn(input: AgentTextTurnInput) {
    return { threadId: input.threadId ?? 'native-1', turnId: 'turn-1', finalText: 'done' }
  }

  async interruptTurn(): Promise<void> {}

  async steerTurn(): Promise<void> {}

  async readAccount() {
    return {
      kind: 'chatgpt' as const,
      email: 'owner@example.test',
      planType: 'plus',
      requiresOpenaiAuth: true,
    }
  }

  async startDeviceLogin() {
    return {
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
    }
  }

  async readRateLimits() {
    return [{
      id: 'codex',
      name: 'Codex',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: null,
      planType: 'plus',
      reachedType: null,
    }]
  }

  async readUsage(threadId?: string) {
    return {
      lifetimeTokens: '1234',
      peakDailyTokens: '500',
      currentStreakDays: '3',
      recentDaily: [{ date: '2026-08-29', tokens: '100' }],
      thread: threadId === undefined
        ? null
        : { id: threadId, creditsMicros: '42', usdMicros: '7' },
    }
  }

  async listNativeThreads(input: { cwd: readonly string[]; archived?: boolean; search?: string }) {
    return this.threads.filter((thread) => (
      input.cwd.includes(thread.cwd) &&
      thread.archived === (input.archived ?? false) &&
      (input.search === undefined || thread.id.includes(input.search) ||
        (thread.name ?? '').includes(input.search))
    ))
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    this.renamed.push({ threadId, name })
  }

  async archiveNativeThread(threadId: string): Promise<void> {
    this.archived.push(threadId)
    const thread = this.threads.find((item) => item.id === threadId)
    if (thread !== undefined) thread.archived = true
  }

  async unarchiveNativeThread(threadId: string): Promise<void> {
    this.unarchived.push(threadId)
    const thread = this.threads.find((item) => item.id === threadId)
    if (thread !== undefined) thread.archived = false
  }

  async forkNativeThread(threadId: string, cwd: string): Promise<string> {
    const id = `${threadId}-fork`
    this.threads.push(this.thread(id, cwd, false))
    return id
  }

  async compactThread(threadId: string): Promise<void> {
    this.compacted.push(threadId)
  }

  getLatestDiff(threadId: string) {
    return {
      threadId,
      turnId: 'turn-diff',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+const value = 1\n',
      updatedAtMs: NOW,
    }
  }

  async runReview(input: {
    operationKey: string
    threadId: string
    target: AgentReviewTarget
  }) {
    this.reviews.push(input.target)
    return { threadId: input.threadId, turnId: 'turn-review', finalText: 'No findings.' }
  }
}

let root: string
let project: string
let database: Database
let backend: M65Backend
let settings: SqliteAgentSettingsRepository
let commands: PersonalAlphaCommands

function command(name: PersonalAlphaCommandName, args = ''): CommandOperation {
  return {
    operationKey: `telegram:primary:command:${name}:${args}`,
    botId: 'primary',
    inboxUpdateId: 1,
    updateId: 1,
    command: { chatId: '7001', projectId: 'workspace', name, args },
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-m65-commands-'))
  project = join(root, 'workspace')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# private project\n')
  database = openDurableDatabase(join(root, 'state.sqlite3'))
  backend = new M65Backend(project)
  settings = new SqliteAgentSettingsRepository(database)
  commands = new PersonalAlphaCommands(
    new SqliteSessionRepository(database),
    backend,
    new SqliteOutboxRepository(database),
    settings,
    {
      now: () => NOW,
      projects: [{ id: 'workspace', cwd: project }],
      defaultProjectId: 'workspace',
      bridgeVersion: '1.0.0-test',
      codexVersion: '0.149.1',
    },
  )
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('M6.5 personal commands', () => {
  test('renders account, version and inline settings controls', async () => {
    expect((await commands.handleCommand(command('auth'))).text).toContain('owner@example.test')
    expect((await commands.handleCommand(command('limits'))).text).toContain('25.0%')
    expect((await commands.handleCommand(command('usage'))).text).toContain('Lifetime tokens: 1234')
    expect((await commands.handleCommand(command('version'))).text).toBe(
      'codex-tg-wire 1.0.0-test\nCodex CLI 0.149.1',
    )
    const login = await commands.handleCommand(command('login'))
    expect(login.text).toContain('ABCD-EFGH')
    expect(login.buttons?.[0]?.[0]).toEqual({
      text: 'Открыть страницу входа',
      url: 'https://auth.openai.com/device',
    })
    const panel = await commands.handleCommand(command('settings'))
    expect(panel.buttons?.flat().map((button) => button.text)).toEqual([
      'Model', 'Effort', 'Sandbox', 'Approval', 'Project', 'Guided Plan',
    ])
    expect((await commands.handleCommand(command('plan', 'on'))).text).toContain('on')
    expect(settings.getProjectSettings('primary', '7001', 'workspace')?.guidedPlanEnabled).toBeTrue()
  })

  test('discovers, attaches and hands native sessions back to local Codex', async () => {
    expect((await commands.handleCommand(command('sessions'))).text).toContain('native-1')
    expect((await commands.handleCommand(command('attach', 'native-1'))).text).toContain('подключён')
    const handback = (await commands.handleCommand(command('handback'))).text
    expect(handback).toContain(`cd -- '${project}' && codex resume 'native-1'`)
    expect((await commands.handleCommand(command('rename', 'native-1 Better title'))).text).toContain(
      'переименован',
    )
    expect(backend.renamed).toEqual([{ threadId: 'native-1', name: 'Better title' }])

    expect((await commands.handleCommand(command('archive', 'native-1'))).text).toContain('архивирован')
    expect(backend.archived).toEqual(['native-1'])
    expect((await commands.handleCommand(command('sessions', 'archived'))).text).toContain('native-1')
    expect((await commands.handleCommand(command('unarchive', 'native-1'))).text).toContain(
      'разархивирован',
    )
    expect((await commands.handleCommand(command('fork', 'native-1'))).text).toContain(
      'native-1-fork',
    )
    expect((await commands.handleCommand(command('compact'))).text).toContain('запущен')
    expect(backend.compacted).toEqual(['native-1-fork'])
  })

  test('provides root-confined file, diff and native review inspection', async () => {
    await commands.handleCommand(command('attach', 'native-1'))
    expect((await commands.handleCommand(command('file', 'README.md'))).text).toContain(
      '# private project',
    )
    expect((await commands.handleCommand(command('file', '../outside.txt'))).text).not.toContain(root)
    expect((await commands.handleCommand(command('diff', 'src/a.ts'))).text).toContain(
      'diff --git a/src/a.ts',
    )
    expect((await commands.handleCommand(command('review', 'base main'))).text).toBe('No findings.')
    expect(backend.reviews).toEqual([{ type: 'baseBranch', branch: 'main' }])
  })
})
