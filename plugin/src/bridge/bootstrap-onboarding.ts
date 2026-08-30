import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { isAbsolute, parse, resolve } from 'node:path'

import { Bot } from 'grammy'
import type { Update } from 'grammy/types'

import {
  BridgeBootstrapStateRepository,
  type BridgeBootstrapState,
} from './bootstrap-installation.js'
import { finalizeBridgeBootstrap } from './installation.js'
import { CommandSystemdNotifier } from './health.js'
import { openDurableDatabase } from '../durable/database.js'
import { SqlitePollCursorRepository } from '../durable/poll-cursor-repository.js'

export interface BootstrapOnboardingLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
}

export interface BootstrapTelegramApi {
  sendMessage(
    chatId: string,
    text: string,
    options?: { reply_markup?: { inline_keyboard: BootstrapKeyboard } },
  ): Promise<{ message_id: number }>
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<true>
}

export interface BootstrapOnboardingControllerOptions {
  homeDirectory?: string
  finalize?: (state: BridgeBootstrapState, profile: 'yolo' | 'safe') => void
  handoffCursor?: (state: BridgeBootstrapState) => void
}

type BootstrapButton =
  | { text: string; callback_data: string; url?: never }
  | { text: string; url: string; callback_data?: never }
type BootstrapKeyboard = BootstrapButton[][]

interface BootstrapMessage {
  message_id?: number
  text?: string
  chat?: { id?: number; type?: string }
  from?: { id?: number; is_bot?: boolean }
}

interface BootstrapCallback {
  id?: string
  data?: string
  from?: { id?: number; is_bot?: boolean }
  message?: { message_id?: number; chat?: { id?: number; type?: string } }
}

function asUpdate(value: unknown): {
  updateId: number
  message?: BootstrapMessage
  callback?: BootstrapCallback
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const update = value as { update_id?: unknown; message?: unknown; callback_query?: unknown }
  if (!Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) return null
  return {
    updateId: update.update_id as number,
    ...(typeof update.message === 'object' && update.message !== null
      ? { message: update.message as BootstrapMessage }
      : {}),
    ...(typeof update.callback_query === 'object' && update.callback_query !== null
      ? { callback: update.callback_query as BootstrapCallback }
      : {}),
  }
}

function projectError(path: string): string | null {
  if (!isAbsolute(path)) return 'Нужен абсолютный путь, например /home/me/project или ~/project.'
  const normalized = resolve(path)
  if (normalized === parse(normalized).root) return 'Корень файловой системы нельзя выбрать как проект.'
  if (path.includes('\n') || path.includes('\r') || path.includes('\0')) return 'Путь содержит недопустимые символы.'
  if (!existsSync(normalized)) return null
  const stat = lstatSync(normalized)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'Путь должен указывать на настоящую папку, не symlink.'
  return null
}

export class BootstrapOnboardingController {
  private readonly homeDirectory: string
  private readonly finalize: (state: BridgeBootstrapState, profile: 'yolo' | 'safe') => void
  private readonly handoffCursor: (state: BridgeBootstrapState) => void

  constructor(
    private readonly states: BridgeBootstrapStateRepository,
    private readonly api: BootstrapTelegramApi,
    options: BootstrapOnboardingControllerOptions = {},
  ) {
    this.homeDirectory = options.homeDirectory ?? process.env.HOME ?? ''
    this.finalize = options.finalize ?? ((state, profile) => {
      if (state.ownerUserId === null || state.ownerChatId === null || state.selectedProjectPath === null) {
        throw new Error('bootstrap is missing owner or project state')
      }
      finalizeBridgeBootstrap({
        configDirectory: state.configDirectory,
        stateDirectory: state.stateDirectory,
        projectPath: state.selectedProjectPath,
        telegramUserId: state.ownerUserId,
        telegramChatId: state.ownerChatId,
        executionProfile: profile,
        voiceProvider: 'groq',
        groqCredentialPath: state.groqCredentialPath,
      })
    })
    this.handoffCursor = options.handoffCursor ?? ((state) => {
      if (state.nextUpdateId === null) throw new Error('bootstrap polling cursor is missing')
      const database = openDurableDatabase(resolve(state.stateDirectory, 'bridge.sqlite3'))
      try {
        new SqlitePollCursorRepository(database).advance(
          state.botId,
          state.nextUpdateId,
          Date.now(),
        )
      } finally {
        database.close()
      }
    })
  }

  async resume(): Promise<boolean> {
    const state = this.states.load()
    if (state.status === 'complete') return true
    if (state.status === 'finalizing') {
      if (existsSync(`${state.configDirectory}/bridge.config.json`)) {
        this.handoffCursor(state)
        await this.sendCompletion(state)
        this.states.update((current) => ({ ...current, status: 'complete' }))
        return true
      }
      this.states.update((current) => ({ ...current, status: 'choose_profile' }))
    }
    return false
  }

  async handleUpdate(raw: unknown): Promise<boolean> {
    const update = asUpdate(raw)
    if (update === null) return false
    let state = this.states.load()
    if (state.status === 'complete') return true

    if (state.status === 'awaiting_owner') {
      const message = update.message
      const expected = `/start ${state.nonce}`
      if (message === undefined) return false
      const invalidPrivateSender =
        message.chat?.type !== 'private' ||
        message.from?.is_bot === true ||
        !Number.isSafeInteger(message.from?.id) ||
        !Number.isSafeInteger(message.chat?.id) ||
        (message.from?.id ?? 0) <= 0 ||
        (message.chat?.id ?? 0) <= 0
      if (invalidPrivateSender) {
        return false
      }
      if (message.text === '/start') {
        await this.api.sendMessage(String(message.chat?.id), [
          '🔐 Бот ещё не активирован.',
          '',
          'Открой ссылку «Активация бота» из установщика — она безопасно привяжет этот Telegram-аккаунт как владельца.',
        ].join('\n'))
        return false
      }
      if (message.text !== expected) return false
      state = this.states.update((current) => ({
        ...current,
        status: 'choose_project',
        ownerUserId: String(message.from?.id),
        ownerChatId: String(message.chat?.id),
      }))
      await this.sendProjectPrompt(state, true)
      return false
    }

    if (!this.isOwnerUpdate(state, update)) return false
    if (update.message?.text?.startsWith('/start') === true) {
      await this.sendCurrentPrompt(state)
      return false
    }
    if (update.callback !== undefined) {
      const callbackId = update.callback.id
      if (typeof callbackId !== 'string') return false
      try {
        const complete = await this.handleCallback(state, update.callback, update.updateId)
        await this.api.answerCallbackQuery(callbackId)
        return complete
      } catch (error) {
        await this.api.answerCallbackQuery(callbackId, { text: 'Не удалось применить выбор' })
        throw error
      }
    }
    if (state.status === 'awaiting_custom_project' && typeof update.message?.text === 'string') {
      await this.handleCustomProject(state, update.message.text, update.updateId)
    }
    return false
  }

  private isOwnerUpdate(
    state: BridgeBootstrapState,
    update: ReturnType<typeof asUpdate> & {},
  ): boolean {
    const messageUser = update.message?.from?.id
    const messageChat = update.message?.chat?.id
    const callbackUser = update.callback?.from?.id
    const callbackChat = update.callback?.message?.chat?.id
    const userId = messageUser ?? callbackUser
    const chatId = messageChat ?? callbackChat
    const chatType = update.message?.chat?.type ?? update.callback?.message?.chat?.type
    const isBot = update.message?.from?.is_bot ?? update.callback?.from?.is_bot
    return chatType === 'private' && isBot !== true &&
      String(userId) === state.ownerUserId && String(chatId) === state.ownerChatId
  }

  private async handleCallback(
    state: BridgeBootstrapState,
    callback: BootstrapCallback,
    updateId: number,
  ): Promise<boolean> {
    const action = callback.data
    if (action === 'boot:project:default' && state.status === 'choose_project') {
      await this.useProject(state, state.defaultProjectPath, true, updateId)
      return false
    }
    if (
      action === 'boot:project:custom' &&
      state.status === 'choose_project' &&
      state.allowCustomProject
    ) {
      const next = this.states.update((current) => ({
        ...current,
        status: 'awaiting_custom_project',
      }))
      await this.api.sendMessage(next.ownerChatId as string, [
        '📂 Пришли абсолютный путь к проекту одним сообщением.',
        '',
        'Можно использовать ~/project. Если папки ещё нет, я предложу создать её.',
      ].join('\n'))
      return false
    }
    if (action === 'boot:create:yes' && state.status === 'confirm_create') {
      if (state.pendingProjectPath === null) throw new Error('pending project path is missing')
      await this.useProject(state, state.pendingProjectPath, true, updateId)
      return false
    }
    if (action === 'boot:create:no' && state.status === 'confirm_create') {
      const next = this.states.update((current) => ({
        ...current,
        status: 'choose_project',
        pendingProjectPath: null,
      }))
      await this.sendProjectPrompt(next, false)
      return false
    }
    if (action === 'boot:profile:yolo' && state.status === 'choose_profile') {
      await this.finish('yolo', updateId)
      return true
    }
    if (action === 'boot:profile:safe' && state.status === 'choose_profile') {
      await this.finish('safe', updateId)
      return true
    }
    return false
  }

  private async handleCustomProject(
    state: BridgeBootstrapState,
    rawPath: string,
    updateId: number,
  ): Promise<void> {
    const trimmed = rawPath.trim()
    const expanded = trimmed === '~'
      ? this.homeDirectory
      : trimmed.startsWith('~/')
        ? resolve(this.homeDirectory, trimmed.slice(2))
        : trimmed
    const error = projectError(expanded)
    if (error !== null) {
      await this.api.sendMessage(state.ownerChatId as string, `❌ ${error}\n\nПришли другой путь.`)
      return
    }
    const path = resolve(expanded)
    if (existsSync(path)) {
      await this.useProject(state, path, false, updateId)
      return
    }
    const next = this.states.update((current) => ({
      ...current,
      status: 'confirm_create',
      pendingProjectPath: path,
    }))
    await this.api.sendMessage(next.ownerChatId as string, `Папки ещё нет:\n${path}\n\nСоздать её?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Создать папку', callback_data: 'boot:create:yes' }],
          [{ text: '↩️ Выбрать другой путь', callback_data: 'boot:create:no' }],
        ],
      },
    })
  }

  private async useProject(
    state: BridgeBootstrapState,
    path: string,
    create: boolean,
    updateId: number,
  ): Promise<void> {
    const error = projectError(path)
    if (error !== null) {
      await this.api.sendMessage(state.ownerChatId as string, `❌ ${error}`)
      return
    }
    if (!existsSync(path)) {
      if (!create) throw new Error('project directory is missing')
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('project path is not a real directory')
    const next = this.states.update((current) => ({
      ...current,
      status: 'choose_profile',
      selectedProjectPath: resolve(path),
      pendingProjectPath: null,
    }))
    if (next.executionProfile === null) await this.sendProfilePrompt(next)
    else await this.finish(next.executionProfile, updateId)
  }

  private async finish(profile: 'yolo' | 'safe', updateId: number): Promise<void> {
    const finalizing = this.states.update((current) => ({
      ...current,
      status: 'finalizing',
      executionProfile: profile,
      nextUpdateId: Math.max(current.nextUpdateId ?? 0, updateId + 1),
    }))
    this.finalize(finalizing, profile)
    this.handoffCursor(finalizing)
    await this.sendCompletion(finalizing)
    this.states.update((current) => ({ ...current, status: 'complete' }))
  }

  private async sendCurrentPrompt(state: BridgeBootstrapState): Promise<void> {
    switch (state.status) {
      case 'choose_project': await this.sendProjectPrompt(state, false); return
      case 'awaiting_custom_project':
        await this.api.sendMessage(state.ownerChatId as string, 'Пришли абсолютный путь к проекту одним сообщением.')
        return
      case 'confirm_create':
        await this.api.sendMessage(state.ownerChatId as string, `Создать папку ${state.pendingProjectPath ?? ''}?`, {
          reply_markup: { inline_keyboard: [
            [{ text: '✅ Создать', callback_data: 'boot:create:yes' }],
            [{ text: '↩️ Другой путь', callback_data: 'boot:create:no' }],
          ] },
        })
        return
      case 'choose_profile': await this.sendProfilePrompt(state); return
      case 'finalizing':
        await this.api.sendMessage(state.ownerChatId as string, '⏳ Завершаю конфигурацию и запускаю bridge…')
        return
      case 'complete': await this.sendCompletion(state); return
      case 'awaiting_owner': return
    }
  }

  private async sendProjectPrompt(state: BridgeBootstrapState, claimed: boolean): Promise<void> {
    const buttons: BootstrapKeyboard = [
      [{
        text: `${existsSync(state.defaultProjectPath) ? '📁 Использовать' : '📁 Создать'} ${state.defaultProjectPath}`,
        callback_data: 'boot:project:default',
      }],
      ...(state.allowCustomProject
        ? [[{ text: '📂 Указать другую папку', callback_data: 'boot:project:custom' }]]
        : []),
    ]
    await this.api.sendMessage(state.ownerChatId as string, [
      ...(claimed ? ['✅ Бот активирован и привязан к этому Telegram-аккаунту.', ''] : []),
      '1/3 · Рабочая папка Codex',
      '',
      state.deployment === 'docker'
        ? 'Docker может использовать только папку, смонтированную установщиком.'
        : 'Выбери стандартный workspace или укажи абсолютный путь к существующему проекту.',
    ].join('\n'), { reply_markup: { inline_keyboard: buttons } })
  }

  private async sendProfilePrompt(state: BridgeBootstrapState): Promise<void> {
    await this.api.sendMessage(state.ownerChatId as string, [
      '2/3 · Режим доступа Codex',
      '',
      '🚀 YOLO — без постоянных approvals, полный доступ от имени текущего Linux user.',
      '🛡 Safe — workspace-write, опасные действия требуют подтверждения.',
      '',
      `Проект: ${state.selectedProjectPath ?? 'не выбран'}`,
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [{ text: '🚀 YOLO · recommended', callback_data: 'boot:profile:yolo' }],
        [{ text: '🛡 Safe', callback_data: 'boot:profile:safe' }],
      ] },
    })
  }

  private async sendCompletion(state: BridgeBootstrapState): Promise<void> {
    const continueUrl = `https://t.me/${state.botUsername}?start=ready`
    await this.api.sendMessage(state.ownerChatId as string, [
      '✅ 3/3 · Базовая настройка готова',
      '',
      `Project: ${state.selectedProjectPath ?? '—'}`,
      `Mode: ${state.executionProfile === 'safe' ? 'Safe' : 'YOLO'}`,
      '',
      'Bridge сейчас перезапустится. Нажми кнопку ниже — дальше проверим Codex и подключим voice.',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[
        { text: '🚀 Продолжить в боте', url: continueUrl },
      ]] },
    })
  }
}

export interface BotFirstBootstrapServiceOptions {
  token: string
  bootstrapPath: string
  apiRoot?: string
  signal?: AbortSignal
  logger?: BootstrapOnboardingLogger
}

export class BotFirstBootstrapService {
  private readonly abort = new AbortController()
  private readonly runPromise: Promise<void>
  private readonly notifier = new CommandSystemdNotifier()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private healthServer: ReturnType<typeof Bun.serve> | null = null
  private completed = false

  constructor(
    private readonly bot: Bot,
    private readonly states: BridgeBootstrapStateRepository,
    private readonly controller: BootstrapOnboardingController,
    private readonly deployment: 'host' | 'docker',
    private readonly logger?: BootstrapOnboardingLogger,
  ) {
    this.runPromise = this.run()
  }

  static async start(options: BotFirstBootstrapServiceOptions): Promise<BotFirstBootstrapService> {
    const states = new BridgeBootstrapStateRepository(options.bootstrapPath)
    const state = states.load()
    const bot = new Bot(options.token, {
      ...(options.apiRoot === undefined ? {} : { client: { apiRoot: options.apiRoot } }),
    })
    await bot.init(options.signal)
    if (String(bot.botInfo.id) !== state.botId || bot.botInfo.username !== state.botUsername) {
      throw new Error('bootstrap bot identity does not match the stored installation')
    }
    const telegramApi: BootstrapTelegramApi = {
      sendMessage: (chatId, text, sendOptions) => bot.api.sendMessage(chatId, text, sendOptions),
      answerCallbackQuery: (callbackQueryId, answerOptions) =>
        bot.api.answerCallbackQuery(callbackQueryId, answerOptions),
    }
    const controller = new BootstrapOnboardingController(states, telegramApi)
    const service = new BotFirstBootstrapService(bot, states, controller, state.deployment, options.logger)
    options.signal?.addEventListener('abort', () => service.abort.abort(), { once: true })
    service.startHealthServer()
    await service.notifyReady()
    return service
  }

  wait(): Promise<void> {
    return this.runPromise
  }

  async stop(): Promise<void> {
    this.abort.abort()
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
    this.healthServer?.stop(true)
    this.healthServer = null
    await this.runPromise.catch(() => undefined)
    if (process.env.NOTIFY_SOCKET) await this.notifier.notify(['--stopping'])
  }

  isComplete(): boolean {
    return this.completed
  }

  private async run(): Promise<void> {
    if (await this.controller.resume()) {
      this.completed = true
      return
    }
    while (!this.abort.signal.aborted) {
      const state = this.states.load()
      const updates = await this.bot.api.getUpdates({
        ...(state.nextUpdateId === null ? {} : { offset: state.nextUpdateId }),
        timeout: 30,
        allowed_updates: ['message', 'callback_query'] as Array<Exclude<keyof Update, 'update_id'>>,
      }, this.abort.signal).catch((error: unknown) => {
        if (this.abort.signal.aborted) return []
        throw error
      })
      for (const update of updates) {
        const complete = await this.controller.handleUpdate(update)
        this.states.update((current) => ({
          ...current,
          nextUpdateId: Math.max(current.nextUpdateId ?? 0, update.update_id + 1),
        }))
        if (complete) {
          this.completed = true
          this.logger?.info('bot-first bootstrap completed')
          return
        }
      }
    }
  }

  private async notifyReady(): Promise<void> {
    if (!process.env.NOTIFY_SOCKET) return
    const ready = await this.notifier.notify(['--ready'])
    if (!ready.ok) this.logger?.warn('bootstrap systemd ready notification failed')
    const watchdogPid = process.env.WATCHDOG_PID?.trim()
    if (watchdogPid && watchdogPid !== String(process.pid)) return
    const watchdogUsec = Number(process.env.WATCHDOG_USEC)
    if (!Number.isSafeInteger(watchdogUsec) || watchdogUsec <= 0) return
    const intervalMs = Math.max(1_000, Math.floor(watchdogUsec / 2_000))
    this.watchdogTimer = setInterval(() => {
      void this.notifier.notify(['WATCHDOG=1']).then((result) => {
        if (!result.ok) this.logger?.warn('bootstrap systemd watchdog notification failed')
      })
    }, intervalMs)
    this.watchdogTimer.unref()
  }

  private startHealthServer(): void {
    if (this.deployment !== 'docker') return
    this.healthServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 8_787,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (path === '/live' || path === '/ready' || path === '/health') {
          return Response.json({
            live: true,
            ready: true,
            lifecycle: 'bootstrap',
          }, { headers: { 'cache-control': 'no-store' } })
        }
        return Response.json({ error: 'not_found' }, { status: 404 })
      },
    })
  }
}
