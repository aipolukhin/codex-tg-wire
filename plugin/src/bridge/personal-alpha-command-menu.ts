import type { PersonalAlphaCommandName } from './contracts.js'
import type { CommandSpec } from '../telegram/command-scope.js'

type PersonalCommandSpec = CommandSpec & { command: PersonalAlphaCommandName }

/** Native Telegram slash menu for the standalone Codex runtime. */
export const PERSONAL_ALPHA_BOT_COMMANDS = [
  { command: 'start', description: 'открыть онбординг и основные действия' },
  { command: 'settings', description: 'модель, effort, доступ и проект' },
  { command: 'status', description: 'текущий thread, turn и расход контекста' },
  { command: 'new', description: 'начать новый Codex thread' },
  { command: 'stop', description: 'остановить текущую задачу' },
  { command: 'steer', description: 'уточнить активную задачу: /steer текст' },
  { command: 'plan', description: 'Guided Plan: on, off или status' },
  { command: 'sessions', description: 'найти нативные сессии Codex' },
  { command: 'attach', description: 'подключить сессию: /attach THREAD_ID' },
  { command: 'handback', description: 'продолжить текущий thread в терминале' },
  { command: 'compact', description: 'сжать контекст текущего thread' },
  { command: 'fork', description: 'создать ответвление текущего thread' },
  { command: 'rename', description: 'переименовать thread: /rename имя' },
  { command: 'archive', description: 'архивировать текущий thread' },
  { command: 'unarchive', description: 'вернуть thread из архива' },
  { command: 'diff', description: 'показать последний diff' },
  { command: 'review', description: 'запустить нативное Codex review' },
  { command: 'file', description: 'получить файл проекта: /file путь' },
  { command: 'cwd', description: 'выбрать настроенный проект' },
  { command: 'model', description: 'выбрать модель Codex' },
  { command: 'effort', description: 'выбрать reasoning effort' },
  { command: 'sandbox', description: 'выбрать режим доступа к файлам' },
  { command: 'approval', description: 'настроить подтверждения действий' },
  { command: 'auth', description: 'проверить авторизацию Codex' },
  { command: 'login', description: 'подключить аккаунт Codex' },
  { command: 'groq', description: 'подключить Groq для voice transcription' },
  { command: 'limits', description: 'показать лимиты Codex' },
  { command: 'usage', description: 'показать статистику использования' },
  { command: 'failed', description: 'проблемы доставки с безопасным retry' },
  { command: 'ambiguous', description: 'неопределённые доставки без auto-retry' },
  { command: 'version', description: 'версии моста и Codex CLI' },
] as const satisfies readonly PersonalCommandSpec[]
