# Происхождение codex-tg-wire

Этот документ отделяет унаследованный код, архитектурные референсы и новую
реализацию. «Не перенесено» ниже означает, что функция не входит в
поддерживаемый Codex runtime `bun run start:codex`. Часть legacy Claude-модулей
ещё физически остаётся в source tree до завершения extraction общего
Telegram-кода.

## Dashi

Источник: [qwwiwi/dashi-plugin-claude-code](https://github.com/qwwiwi/dashi-plugin-claude-code),
baseline `f3ac9cfd20a125674bbad9f507f7cf6bc7566fca`, Apache-2.0.

### Сохранено и адаптировано

- Bun + TypeScript + grammY + Zod как базовый технологический стек.
- Telegram Markdown/HTML pipeline, безопасный chunking длинных сообщений и
  HTML validation.
- Secret redaction и общий принцип deny-by-default allowlist.
- UX-паттерны inline-кнопок, progress/status card, HUD и heartbeat.
- Подходы к Telegram media, voice transcription и rate limiting.

Codex runtime прямо использует общие модули `format/chunk.ts`, `format/html.ts`,
`safety/redact.ts` и `safety/html-validator.ts`. Durable poller, gateway,
attachments, albums, status projector и interaction broker написаны как новые
Codex-oriented реализации вокруг этих primitives.

### Не перенесено в Codex runtime v1

- Claude Code channel/MCP lifecycle и запуск через
  `--dangerously-load-development-channels`.
- Привязка к Anthropic Max subscription и Claude-specific notifications.
- tmux как транспорт: terminal mirror, pane classifier, `/keys`, `/cc` и
  отправка keystrokes в живой terminal.
- Claude hooks: `PreToolUse`/`PostToolUse`/`Stop`, TaskMirror, transcript-based
  read receipt и fallback reply.
- Полный Dashi multichat: группы/topics, per-chat tmux sessions, persona overlay
  и public/private policy.
- Guest Mode и ответы недоверенным внешним чатам.
- Dashi autonomy lease/ask-guard и fleet orchestration.
- Memory hooks в `recent.md`/verbose JSONL.
- launchd/macOS production packaging.
- File inbox/outbox как основной recovery contract и автоматический restart
  живой Claude-сессии.

Эти функции не объявляются поддерживаемыми возможностями codex-tg-wire. Для v1
группы/topics, fleet и второй Claude backend сознательно оставлены за границей
релиза.

## Telemax

Источник: [aipolukhin/telemax](https://github.com/aipolukhin/telemax),
Apache-2.0.

Из Telemax перенесена **семантика, не Python-код**:

- durable SQLite inbox/outbox;
- leases, heartbeat и reaper истёкших leases;
- граница `send_started` и явное состояние `AMBIGUOUS`;
- bounded retry, TTL и max attempts;
- problem center с idempotent/audited retry, resolve и archive;
- supervisor loops и fault-injection дисциплина;
- content-addressed media spool, integrity proof и безопасное повторное
  открытие файлов;
- атомарная модель albums и запрет скрытого повтора после неизвестного remote
  результата.

В codex-tg-wire эта модель заново реализована на TypeScript/Bun и расширена на
turn queue, Codex thread bindings, approvals, callbacks и App Server recovery.

## Другие Codex bridges

Код этих проектов не vendored и не копировался; они использовались как
поведенческие референсы и контрпримеры.

- [Gan-Xing/telegram-codex-app-bridge](https://github.com/Gan-Xing/telegram-codex-app-bridge) —
  практический mapping App Server threads/turns, approvals, user input и
  Telegram controls. Не взята модель, где polling cursor зависит от полного
  завершения обработки: codex-tg-wire сначала фиксирует raw update, затем
  продвигает offset.
- [woosungchoi/codex-telegram-bot](https://github.com/woosungchoi/codex-telegram-bot) —
  сценарии очереди и восстановления прерванных Codex jobs. Не взяты JSON/JSONL
  state files как транзакционная база и эвристический запуск замещающего turn.

## OpenAI Codex App Server

Официальный источник протокола:
[Codex App Server documentation](https://developers.openai.com/codex/app-server).

Оттуда взяты wire contract, lifecycle и generated schema: `initialize`,
threads, turns, model catalog, notifications, approvals, user input, MCP
elicitation и `thread/read`. Production transport v1 — только supervised local
stdio с exact Codex CLI pin и schema fingerprint. Experimental remote/WebSocket
transport не объявлен поддерживаемым.

## Написано для codex-tg-wire

- JSONL/stdio transport, concurrent request correlation и supervised App Server
  client.
- Provider-neutral `AgentBackend`, Codex backend и typed protocol wrappers.
- SQLite migrations/repositories, inbox/outbox workers, leases, FIFO turns,
  session coordinator и startup reconciler.
- Durable approval/user-input/MCP interaction broker с restart/stale rules.
- Thread registry, project settings, problem center и audit ledger.
- Durable Telegram poller, gateway, attachment store, outbound media/album path,
  rate limiter и voice adapter.
- HUD/event projector, heartbeat и unknown-notification journal.
- Doctor, health/readiness/watchdog, backup/restore, retention, soak/chaos gates,
  SBOM, reproducible artifacts и atomic upgrade/rollback.

