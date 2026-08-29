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
- `/stop`, `/steer` и restart-safe FIFO-очередь turns;
- per-project `/model`, `/effort`, `/sandbox`, `/approval` и allowlisted `/cwd`;
- durable command/file/permission approvals и user-input вопросы;
- MCP elicitation: typed forms и HTTPS flows без credentials в URL;
- rich Telegram HTML, ordered chunks, HUD, progress и heartbeat;
- проверенные входящие/исходящие файлы, изображения, аудио, media groups и atomic albums;
- опциональная Groq-транскрибация; исходное аудио остаётся доступно Codex;
- обязательные user/chat allowlists, secret redaction и fail-closed policy gates;
- systemd и non-root read-only Docker;
- doctor, health/readiness/watchdog, backup/restore, retention, SBOM и atomic upgrade/rollback.

## Быстрый запуск из исходников

Нужны Linux, Bun `1.4.x`, авторизованный Codex CLI `0.149.1`, Telegram bot
token, числовые owner user/chat IDs и абсолютный путь к проекту.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire/plugin
bun install --frozen-lockfile
cp bridge.config.example.json bridge.config.json
install -m 0600 /dev/null telegram-token
```

Отредактируйте `bridge.config.json`, положите только bot token в
`telegram-token`, затем:

```bash
export DASHI_CODEX_BRIDGE_CONFIG="$PWD/bridge.config.json"
export DASHI_TELEGRAM_BOT_TOKEN_FILE="$PWD/telegram-token"
bun run doctor:codex --online
bun run start:codex
```

Префикс окружения `DASHI_*` временно сохранён для совместимости конфигурации с
импортированным baseline. Он не выбирает и не запускает legacy Claude runtime.
Для production используйте [инструкцию по установке](plugin/docs/codex-installation.md),
а не source checkout как постоянный daemon.

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
семантически; Python-реализация не копировалась.

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
