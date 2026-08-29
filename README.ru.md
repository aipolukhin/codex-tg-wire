<p align="center">
  <img src="docs/assets/codex-tg-wire-hero.svg" width="100%" alt="codex-tg-wire соединяет Telegram и Codex App Server через durable SQLite-контур">
</p>

<p align="center">
  <strong>Управляй постоянными Codex-сессиями из Telegram — и продолжай их в терминале.</strong>
</p>

<p align="center">
  Русский · <a href="README.md">English</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-2563eb"></a>
  <a href="plugin/docs/codex-compatibility.md"><img alt="Codex CLI 0.149.1" src="https://img.shields.io/badge/Codex_CLI-0.149.1-7c3aed"></a>
  <a href="plugin/package.json"><img alt="Bun 1.4" src="https://img.shields.io/badge/runtime-Bun_1.4-f59e0b"></a>
  <a href="#release-status"><img alt="Hardened pre-release" src="https://img.shields.io/badge/status-hardened_pre--release-0f766e"></a>
</p>

<p align="center">
  <a href="#quick-start">Быстрый старт</a> ·
  <a href="#features">Возможности</a> ·
  <a href="#architecture">Архитектура</a> ·
  <a href="#comparison">Сравнение с Dashi</a> ·
  <a href="#documentation">Документация</a>
</p>

---

Отправь Codex задачу вдали от компьютера, следи за выполнением, отвечай на
approvals, смотри diff, а потом продолжай тот же thread локально. codex-tg-wire —
owner-only self-hosted мост для настоящей работы с кодом, а не stateless
чат-обёртка.

| Контекст остаётся | Управление под рукой | Падения не замалчиваются |
|---|---|---|
| Продолжай нативные Codex threads из Telegram или возвращай их в `codex resume`. | Останавливай, steer-ь, ставь в очередь, делай review и меняй model/sandbox кнопками. | SQLite inbox/outbox, restart recovery и явные `UNKNOWN`/`AMBIGUOUS` не дают тихо потерять или опасно повторить работу. |

<a id="quick-start"></a>
## Быстрый старт

Нужны **Linux с systemd --user**, выполненный **Codex login**, **Telegram bot
token** и числовые Telegram user/chat IDs владельца. Installer сам поставит
совместимый Codex CLI и переиспользует локальный аккаунт из `~/.codex`.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

Консольный onboarding спросит один проект, execution profile, Telegram IDs и
token, проверит окружение, затем установит и запустит пользовательский сервис.
Для основного сценария не нужны `sudo`, отдельный Unix user, Docker или второй
Codex login.

После установки открой бота и отправь:

```text
/start
```

> [!CAUTION]
> Профиль по умолчанию — **YOLO**: `approvalPolicy=never` и
> `sandbox=danger-full-access`. Это удобно, но тот, кто получит контроль над
> разрешённым Telegram account, сможет действовать с правами твоего
> Linux-пользователя. Утечка bot token также раскрывает bridge traffic и требует
> реакции как на incident. Выбери **Safe** в onboarding или запусти
> `./install.sh --profile safe` для `on-request` + `workspace-write`.

[Подробная установка](plugin/docs/codex-installation.md) ·
[Docker и production deployment](plugin/docs/codex-installation.md#docker-compose-installation)

<a id="features"></a>
## Что умеет мост

### Codex как удалённый workspace

| Я хочу… | Что отправить в Telegram |
|---|---|
| Начать или продолжить работу | Обычное сообщение, `/new`, `/sessions`, `/attach <thread-id>` |
| Вернуться в терминал | `/handback` напечатает безопасно экранированную команду `codex resume` |
| Управлять активным turn | `/stop`, `/steer <текст>` или выбор steer/queue/replace/cancel при занятости |
| Изменить режим выполнения | `/settings`: model, effort, sandbox, approvals, project и Guided Plan |
| Проверить результат | `/diff [path]`, `/file [--all] <path>`, `/review` |
| Проверить аккаунт | `/auth`, `/login`, `/limits`, `/usage`, `/version` |
| Управлять нативными сессиями | `/rename`, `/archive`, `/unarchive`, `/fork`, `/compact` |

Reply на доставленный ответ Codex направляет следующее сообщение точно в thread,
который создал этот ответ — даже если позже была выбрана другая сессия.

### Сначала план, потом изменения

Включи `/plan on`, и каждая новая задача пройдёт durable gate:

```text
план в read-only → исправить или отменить → подтвердить → выполнить
```

Planning и revision принудительно работают с `sandbox=read-only` и
`approvalPolicy=never`. Workspace становится доступен для записи только после
кнопки **Выполнить**. Незакрытый план и выбранное действие переживают restart.

### Настоящие файлы проекта

- изображения и аудио передаются нативными inputs App Server;
- разрешённые документы проверяются, приватно сохраняются и доступны по safe path;
- media group превращается в один atomic Codex turn;
- `/file --all` отправляет файл проекта через тот же durable outbox;
- optional Groq transcription дополняет voice input, не заменяя оригинальное
  аудио, доступное Codex.

<a id="architecture"></a>
## Как это работает

```text
Telegram update
      │
      ▼
SQLite/WAL inbox ──► session coordinator ──► codex app-server --stdio
      │                                              │
      └──── problem center ◄── SQLite/WAL outbox ◄───┘
```

В Codex runtime нет tmux, terminal mirror и transcript classifier. Bridge-сервис
сам поднимает локальный App Server как дочерний процесс и общается с ним по stdio.

| Состояние | Источник истины |
|---|---|
| Полный возобновляемый Codex thread | Локальное хранилище Codex в `CODEX_HOME` |
| Принятые Telegram updates и polling cursor | SQLite/WAL inbox моста |
| Очереди, настройки, approvals и recovery state | Control tables в SQLite/WAL |
| Sends, edits, media и доказательство доставки | SQLite/WAL outbox моста |
| Диалог с пользователем | Telegram messages; это не второй полный Codex transcript |

<details>
<summary><strong>Что происходит при падении?</strong></summary>

| Граница | Поведение |
|---|---|
| Telegram повторил update | Уникальный `(bot_id, update_id)` схлопнет дубль. |
| Процесс умер до начала отправки | Lease вернётся в bounded retry. |
| Telegram мог принять send, но ответ потерялся | Job станет `AMBIGUOUS` и не будет автоматически повторён. |
| App Server исчез во время turn | Сохранённый turn сверяется через `thread/read`; неопределённость становится видимым `UNKNOWN`, а не новым скрытым turn. |
| Нужно восстановить delivery | `/failed` и `/ambiguous` показывают безопасные metadata и идемпотентные retry/resolve/archive actions. |

codex-tg-wire не обещает невозможный end-to-end exactly-once. Он сохраняет
доказательства, показывает неопределённость и запрещает опасный retry, когда
нельзя исключить дублирование.

</details>

<a id="comparison"></a>
## codex-tg-wire и Dashi

codex-tg-wire начался с TypeScript/Bun и Telegram UX из Dashi, но сейчас это
отдельный продукт с другим runtime и reliability model.

| | codex-tg-wire | Dashi |
|---|---|---|
| Agent runtime | Нативные threads/turns Codex App Server | Claude Code session через channel/tmux lifecycle |
| Session storage | Codex `CODEX_HOME`, attach/fork/compact и local handback | Claude transcript и состояние live terminal/tmux |
| Delivery state | Transactional SQLite/WAL inbox/outbox, leases и ambiguity handling | File-oriented queues и transcript-based fallbacks |
| Telegram focus | Приватный allowlisted workflow одного владельца | Более полный multichat, groups/topics и personas |
| Native controls | Codex account, usage, limits, sessions, diff и inline review | Claude hooks, terminal mirror, `/keys`, `/cc` |
| Кому подходит | Владельцу, которому нужен durable Codex workstation в Telegram | Claude-centric командам, которым важна широкая chat surface Dashi |

Мы сознательно не переносили tmux transport, Claude hooks, Guest Mode, публичные
чаты, fleet orchestration и полный Dashi multichat. Мотивация описана в
[карте происхождения и исключений](docs/provenance.md).

## Безопасность в двух словах

- user/chat allowlists обязательны и работают deny-by-default;
- tokens не попадают в JSON и SQLite;
- paths ограничены configured projects и перепроверяются перед использованием;
- исходящий текст проходит redaction, Telegram HTML — validation;
- любая send/edit/delete/reaction/media mutation идёт через durable outbox;
- retention очищает старые completed payloads, diffs и reply routes;
- Safe и YOLO — явные профили, а не скрытое поведение.

Перед публикацией мощного coding agent в Telegram прочитай полный
[security contract](plugin/docs/codex-security.md).

<a id="documentation"></a>
## Документация

| Документ | Когда нужен |
|---|---|
| [Установка](plugin/docs/codex-installation.md) | user-systemd, system-wide systemd или Docker Compose |
| [Production runbook](plugin/docs/codex-production.md) | readiness, backup/restore, retention и live soak |
| [Upgrade и rollback](plugin/docs/codex-upgrade.md) | переход между verified artifacts без риска для БД |
| [Security contract](plugin/docs/codex-security.md) | trust boundaries, secrets и incident handling |
| [Compatibility](plugin/docs/codex-compatibility.md) | точные версии Codex CLI, Bun и App Server schema |
| [Roadmap](ROADMAP.md) | закрытые milestones и post-v1 направление |
| [Provenance](docs/provenance.md) | что пришло из Dashi, Telemax и других референсов |

<a id="release-status"></a>
## Статус релиза

Реализация v1 и artifact gate install → restart → resume завершены. Проект
остаётся **hardened pre-release**, пока не пройдены чистая операторская установка
и реальный 72-часовой Telegram/Codex canary. Сейчас поддерживаются private
allowlisted-чаты и локальный stdio App Server. Groups, topics, fleet orchestration
и remote App Server transport относятся к post-v1.

<details>
<summary><strong>Разработка и проверки</strong></summary>

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test
bun run codex:schema:check
```

Полезные operator checks:

```bash
bun run doctor:codex --online
bun run backup:codex -- /safe/path/bridge.sqlite3
bun run acceptance:codex
bun run release:codex
```

Production entry point — `bun run start:codex`. Часть унаследованных Claude
modules пока остаётся в source tree во время extraction общих Telegram
primitives; Codex entry point их не загружает.

</details>

## Происхождение и лицензия

Telegram UX baseline взят из
[Dashi](https://github.com/qwwiwi/dashi-plugin-claude-code). Durable delivery
semantics сформированы с учётом [Telemax](https://github.com/aipolukhin/telemax)
и заново реализованы на TypeScript; Python-код не копировался. Репозиторий
сохраняет upstream history и Apache-2.0 attribution — см. [NOTICE](NOTICE) и
[provenance map](docs/provenance.md).

codex-tg-wire — независимый неофициальный проект, не связанный с OpenAI или
Telegram.
