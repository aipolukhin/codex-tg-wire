# codex-tg-wire

> Durable self-hosted мост между Telegram и Codex App Server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Runtime: Bun 1.4](https://img.shields.io/badge/runtime-Bun_1.4-f9f1e1.svg)](https://bun.sh)
[![Codex CLI: 0.149.1](https://img.shields.io/badge/Codex_CLI-0.149.1-111827.svg)](plugin/docs/codex-compatibility.md)
[![Status: pre-release](https://img.shields.io/badge/status-hardened_pre--release-f59e0b.svg)](#статус-релиза)

[English](README.md) · Русский (эта страница)

codex-tg-wire позволяет владельцу управлять постоянными Codex threads из
разрешённого приватного Telegram-чата. Это отдельный always-on сервис, а не
prompt-wrapper и не Codex plugin: Telegram updates, turns, интерактивные запросы
и исходящая доставка координируются через SQLite/WAL до продвижения внешнего
состояния.

```text
Telegram Bot API
        │
        ▼
 durable inbox ──► session coordinator ──► Codex App Server
        │                                      │
        │                                      ▼
        └──── problem center ◄── durable outbox
```

Слоя tmux или terminal mirror здесь нет. Telegram — UI, наша SQLite отвечает
за recovery доставки и control state, а полную возобновляемую историю thread
хранит сам Codex в локальном `CODEX_HOME`. Процесс App Server одноразовый: после
рестарта bridge подключается через `thread/read`/`thread/resume`; model requests
уходят в OpenAI, но Telegram и наша SQLite не изображают второй полный Codex
transcript.

## Зачем codex-tg-wire

Простой мост умеет вызвать Codex и переслать ответ. Настоящие проблемы
начинаются, когда процесс падает между приёмом update, запуском turn и ответом
Telegram. codex-tg-wire делает эти границы явными:

| Граница | Гарантия |
|---|---|
| Telegram ingress | Raw update коммитится до продвижения polling offset; `(bot_id, update_id)` дедуплицирует повторы. |
| Codex turns | Один активный turn на thread, restart-safe FIFO, явные steer/interrupt и durable thread bindings. |
| Telegram egress | Любая send/edit/delete/reaction/media операция идёт через transactional outbox с leases и bounded retry. |
| Неизвестный результат | После записи `send_started` неопределённая отправка становится `AMBIGUOUS` и никогда не повторяется автоматически. |
| Восстановление | Сохранённые turns сверяются через `thread/read`; неопределённость становится видимым `UNKNOWN`, а не скрытым повторным turn. |
| Действия владельца | `/failed` и `/ambiguous` показывают безопасные метаданные; retry/resolve/archive идемпотентны и аудируются. |

codex-tg-wire не обещает невозможный end-to-end exactly-once. Он честно показывает
неопределённость и позволяет владельцу разрешить её без скрытого дублирования.

## Возможности

- постоянные Codex threads: `/threads`, `/switch`, `/resume`, `/archive`, `/new`;
- handoff нативных Codex-сессий: `/sessions`, `/attach`, `/handback`, `/rename`,
  `/unarchive`, `/fork`, `/compact`;
- `/stop`, `/steer` и restart-safe FIFO-очередь turns;
- единая кнопочная `/settings` для model, effort, sandbox, approval, allowlisted
  cwd и optional Guided Plan gate;
- управление аккаунтом: `/auth`, device-code `/login`, `/limits`, `/usage`, `/version`;
- inspection: последний `/diff`, allowlisted `/file` и нативный inline `/review`;
- reply-to-result routing, явный выбор при занятом turn и durable flow
  plan → revise → confirm → execute;
- durable command/file/permission approvals и user-input вопросы;
- MCP elicitation: typed forms и HTTPS flows без credentials в URL;
- rich Telegram HTML, ordered chunks, HUD, progress и heartbeat;
- проверенные входящие/исходящие файлы, изображения, аудио, media groups и atomic albums;
- опциональная Groq-транскрибация; исходное аудио остаётся доступно Codex;
- обязательные user/chat allowlists, secret redaction и fail-closed policy gates;
- systemd и non-root read-only Docker;
- doctor, health/readiness/watchdog, backup/restore, retention, SBOM и atomic upgrade/rollback.

### Telegram control plane

| Зона | Команды и поведение |
|---|---|
| Аккаунт | `/auth`, `/login`, `/limits`, `/usage`, `/version` используют нативные account methods App Server; бот не просит пароль или token. |
| Сессии | `/sessions [archived] [search]`, `/attach <id>`, `/handback`, `/rename`, `/unarchive`, `/fork`, `/compact` работают с локальным thread store Codex и ограничены cwd выбранного проекта. |
| Настройки | `/settings` показывает inline controls для model, effort, sandbox, approval, project и Guided Plan. Старые текстовые команды остаются. |
| Занятый turn | Второй prompt предлагает steer, durable queue, stop-and-replace или cancel. Выбор сохраняется и обрабатывается идемпотентно. |
| Inspection | `/diff [path]`, `/file [--all] <path>` и `/review [uncommitted\|base <branch>\|commit <sha>\|custom <text>]`. File path разрешается только внутри настроенного project root. |
| Guided Plan | `/plan on` составляет план под принудительными `read-only` + `approvalPolicy=never`, затем ждёт подтверждения в Telegram. План можно поправить, выполнить или отменить; state переживает restart. |
| Reply routing | Reply на доставленный результат Codex продолжает именно тот thread, который создал Telegram-сообщение, даже после переключения session. |

## Установка

Нужны Linux с `systemd --user`, Bun `1.4.x`, выполненный Codex login, Telegram
bot token, числовые owner user/chat IDs и абсолютный путь к проекту. Совместимый
Codex CLI мост поставит локально сам и переиспользует ваш `~/.codex`.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

Компактный консольный onboarding спросит project path, профиль исполнения,
Telegram IDs и token, запустит doctor и установит пользовательский
`codex-tg-wire.service`. Не нужны `sudo`, `/srv`, отдельный Unix account, Docker
и второй Codex login.

По умолчанию выбран **YOLO**: `approvalPolicy=never` и
`sandbox=danger-full-access`, поэтому Codex не просит разрешение на каждый
инструмент. Цена удобства: скомпрометированный Telegram account или bot token
получит права вашего Linux-пользователя. Используйте только приватного бота и
сгенерированный user/chat allowlist. Для `on-request` + `workspace-write`
выберите `Safe` в onboarding или запустите `./install.sh --profile safe`.

Префикс окружения `DASHI_*` временно сохранён для совместимости конфигурации с
импортированным baseline. Он не выбирает и не запускает legacy Claude runtime.
Non-interactive flags, команды сервиса и advanced system-wide/Docker-варианты
описаны в [инструкции по установке](plugin/docs/codex-installation.md).

## Документация

| Документ | Для чего |
|---|---|
| [Установка](plugin/docs/codex-installation.md) | systemd, Docker Compose, Codex login и первая restart-проверка |
| [Production runbook](plugin/docs/codex-production.md) | readiness, backup/restore, retention, rate limits и live soak |
| [Upgrade и rollback](plugin/docs/codex-upgrade.md) | проверенные artifacts, staged activation и безопасный rollback БД |
| [Security contract](plugin/docs/codex-security.md) | trust boundaries, гарантии доставки, секреты и incident handling |
| [Compatibility matrix](plugin/docs/codex-compatibility.md) | точная политика версий Codex/Bun/App Server |
| [Roadmap](ROADMAP.md) | завершённые v1 milestones и post-v1 направление |
| [Происхождение кода](docs/provenance.md) | что сохранено из Dashi, взято как референс, исключено или написано заново |

Полезные команды из `plugin/`:

```bash
bun run doctor:codex --online
bun run backup:codex -- /safe/path/bridge.sqlite3
bun run acceptance:codex
bun run codex:schema:check
bun run release:codex
```

## Статус релиза

Реализация v1 и герметичный artifact gate install → restart → resume завершены.
Мост остаётся **hardened pre-release**, пока не пройдены чистая операторская
установка и реальный 72-часовой Telegram/Codex canary. Поддерживаемая поверхность
v1 — приватные allowlisted-чаты и локальный stdio App Server. Группы, topics,
fleet orchestration и remote App Server transport относятся к post-v1.

## Основа и благодарности

Первым baseline codex-tg-wire стал актуальный TypeScript/Bun и Telegram UX из
[Dashi](https://github.com/qwwiwi/dashi-plugin-claude-code). Форматирование,
медиа и safety-идеи сохранены, а Claude/tmux runtime заменён нативным Codex App
Server backend и SQLite durability boundary.

Модель доставки взята из опыта
[Telemax](https://github.com/aipolukhin/telemax): leases, `send_started`,
`AMBIGUOUS`, problem center и fault-injection дисциплина перенесены в TypeScript
семантически; его компактный и возобновляемый console onboarding также стал
референсом для `install.sh`. Python-реализация не копировалась.

Репозиторий сохраняет upstream Git history и Apache-2.0 attribution. Подробности
в [NOTICE](NOTICE) и [карте происхождения](docs/provenance.md). codex-tg-wire —
независимый неофициальный проект, не связанный с
OpenAI или Telegram.

## Разработка

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test
```

Поддерживаемый production entry point — `bun run start:codex`. Часть
унаследованных Claude channel modules пока остаётся в source tree на время
выделения общего Telegram-кода; продукт из этого README их не использует.
