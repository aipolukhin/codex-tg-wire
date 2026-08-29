# Dashi × Codex × Telemax: roadmap гибридного моста

Статус: active implementation
Цель первого стабильного релиза: self-hosted Telegram-клиент для Codex с UX Dashi и гарантиями доставки Telemax.

## Статус реализации — 2026-08-29

- [x] Локальный `hybrid-main` основан на pristine upstream Dashi commit `f3ac9cf`.
- [x] Изолированный App Server JSONL/stdio transport и request client.
- [x] `initialize`/`initialized`, concurrent request correlation, notifications и server requests.
- [x] Typed wrappers для thread/turn/steer/interrupt/model list.
- [x] Codex CLI compatibility manifest и deterministic schema fingerprint.
- [x] Fake subprocess tests и smoke против реального Codex CLI `0.149.1`.
- [x] Зафиксировано: `thread/start` без первого turn не переживает restart — rollout ещё не создан.
- [x] Закрыт restart recovery active turn/approval/user-input: `thread/read(includeTurns)`
  по официальному contract и fault fixtures доказывает terminal result без resume;
  `inProgress` остаётся `UNKNOWN`, старые server requests становятся `STALE`, а их
  Telegram prompts закрываются или карантинятся.
- [x] Начат M1: SQLite/WAL migrations, durable inbox/outbox, leases, dedupe, TTL и crash recovery.
- [x] Добавлены provider-neutral contracts и fake-backed durable text workers с fault tests.
- [x] Добавлен реальный Codex App Server `AgentBackend` для create/resume text turns и terminal events.
- [x] Добавлен durable SessionCoordinator: operation replay, provisional bindings и conservative `UNKNOWN`.
- [x] Добавлены deny-by-default Telegram text gateway и composition root полного text slice.
- [x] Добавлен polling ingress с SQLite cursor: durable insert всегда предшествует offset advance.
- [x] Добавлены durable-команды personal alpha: `/start`, `/new`, `/status`, `/stop`.
- [x] Добавлены lease heartbeat, periodic reaper и supervisor loops с graceful drain.
- [x] Добавлен standalone personal-alpha service: строгий конфиг без токена, grammY/Codex wiring и signal shutdown.
- [x] Добавлен первый M3 interaction slice: durable command/file approvals, user-input questions, inline callbacks, `/answer`, expiry и stale-on-disconnect.
- [x] Добавлены durable `item/permissions/requestApproval`: строгая нормализация network/filesystem profile, least-privilege grant на turn/session и пустой grant при deny/timeout/unroutable request.
- [x] Закрыт durable MCP elicitation slice: стандартные typed forms и HTTPS URL flows, `/elicit`, multiselect, skip/decline/cancel, timeout и restart recovery; несогласованный `openai/form` и secret-like schema отменяются fail-closed.
- [x] Добавлен явный `/steer <текст>` с `expectedTurnId`; late/mismatched команды не попадают в другой turn.
- [x] Добавлена restart-safe FIFO-очередь turns: один активный turn на session, control updates обходят очередь, ожидание не расходует retry budget.
- [x] Добавлен первый problem center: `/failed`, `/ambiguous`, audited `/retry`, `/resolved`, `/archive`; unsafe retry для `AMBIGUOUS` запрещён.
- [x] Добавлен durable thread registry: `/new` сохраняет историю, `/threads`, `/switch`, `/resume` и локальный `/archive` переживают restart.
- [x] Добавлены durable per-project настройки: `/model`, `/effort`, `/sandbox`, `/approval` и безопасный `/cwd`; model capabilities читаются из live `model/list`, а произвольный путь из Telegram принять нельзя.
- [x] Добавлен безопасный inbound attachment slice: Telegram photo/image и allowlisted documents сохраняются атомарно, переживают restart и доходят до Codex как `localImage` или sandbox-readable local file metadata.
- [x] Неизвестные App Server notifications больше не теряются молча: bounded SQLite-журнал хранит только method/correlation/count/timestamps, без event payload.
- [x] M4 закрыт: provider-neutral HUD/status и heartbeat, validated HTML/chunk chains, durable inbound/outbound media, atomic albums, verified file inbox/outbox и optional voice adapter работают только через SQLite/outbox boundaries.
- [x] Media fault gate покрывает retry до `send_started`, `AMBIGUOUS` после него, restart на upload boundary, tamper detection, единый album turn/proof и запрет автоматического повтора неизвестного результата.

## 1. Что именно мы строим

Это не «Telegram-плагин» в смысле основного runtime. Основной продукт — отдельный bridge-сервис:

```text
Telegram Bot API
       │
       ▼
 durable inbox ──► router/session coordinator ──► AgentBackend
       │                                            │
       │                                            ▼
       │                                    Codex App Server
       │                                            │
       ▼                                            ▼
 problem center ◄── durable outbox ◄── event projector
```

Опциональный Codex plugin появится позже только как упаковка для установки, диагностики, skills и документации. Он не будет владеть Telegram polling, очередями или жизненным циклом bridge-сервиса.

### Состав гибрида

| Источник | Что берём | Что не переносим |
|---|---|---|
| Dashi | TypeScript/Bun-каркас, grammY, Telegram UX, controls, media, redaction, HUD, heartbeat | Claude-specific связность и слабую crash-модель файловой очереди |
| Telemax | Семантику inbox/outbox, leases, `send_started`, `AMBIGUOUS`, problem center, supervisor, fault-injection тесты | Python-код буквально; делаем семантический порт в TypeScript |
| Gan-Xing bridge | Практический mapping Codex App Server: threads, turns, approvals, user input | Схему, где Telegram offset сохраняется до полной обработки update |
| woosungchoi bridge | Сценарии восстановления Codex jobs и явную обработку неоднозначной доставки | JSON/JSONL как основную транзакционную БД всего транспорта |
| OpenAI App Server | Официальный протокол, generated schemas, threads/turns/events/approvals | Experimental WebSocket как production-транспорт |

## 2. Принципы, которые нельзя нарушать

1. Telegram update сначала попадает в SQLite, только затем считается принятым.
2. Ни один production-код не отправляет сообщения в Telegram в обход durable outbox.
3. Lease истёк до `send_started` — job можно повторить. После `send_started` без подтверждённого результата — только `AMBIGUOUS`, без автоматического повтора.
4. `DELIVERED` требует доказательства: сохранённого Telegram `message_id` или эквивалентного remote id.
5. Approvals, user-input requests, queued turns и bindings хранятся независимо от процесса bridge.
6. Codex adapter ничего не знает о Telegram; Telegram adapter ничего не знает о JSON-RPC Codex.
7. Стабильный transport к Codex в `v1` — локальный `stdio` subprocess. Версия Codex CLI закреплена, TypeScript schema генерируется этой же версией.
8. Секреты и содержимое сообщений не попадают в health alerts, telemetry и обычные error logs.
9. Все отправки, включая текст, файлы, albums, edits, deletes и reactions, проходят одну модель delivery jobs.
10. Неоднозначная доставка — нормальное состояние распределённой системы, а не «редкая ошибка», которую можно скрыть retry.

## 3. Scope первого релиза

### Входит в `v1.0`

- один владелец и allowlist Telegram user/chat ids;
- один или несколько локальных проектов (`cwd`) с явным выбором;
- Codex thread: создать, продолжить, выбрать, архивировать;
- turn: запустить, прервать, поставить следующий в очередь, явно steer-ить активный;
- streaming progress без Telegram-спама: throttled edit одного status message;
- approvals и запросы дополнительного ввода через inline keyboard/reply flow;
- text, images и обычные files;
- выбор модели/effort из `model/list`, sandbox и approval policy;
- durable inbox/outbox, restart recovery, retries, TTL и problem center;
- systemd и Docker-варианты запуска, health/doctor, migrations и backup инструкции;
- redaction, rate limits, payload retention/scrubbing и аудит административных действий.

### Не входит в `v1.0`

- публичный бот и недоверенные пользователи;
- полноценный групповой multichat Dashi;
- multi-agent fleet;
- production WebSocket к удалённому App Server;
- Claude backend;
- мобильная/web admin-панель;
- «ровно один раз» доставка — Telegram API не даёт такой гарантии после сетевой неопределённости.

Интерфейс `AgentBackend` создаётся сразу, но второй provider подключается после стабилизации Codex-пути.

## 4. Milestones

Оценка дана для одного разработчика с использованием существующих проектов. Это ориентир, а не обещание по календарю.

| Milestone | Результат | Оценка |
|---|---|---:|
| M0. Baseline и protocol spike | Чистый форк Dashi, ADR, лицензии, работающий App Server harness | 2–3 дня |
| M1. Durable vertical slice | Telegram text → durable inbox → Codex → durable outbox → Telegram | 5–7 дней |
| M2. Reliability kernel | Полная state machine, leases, ambiguity, recovery, problem center | 5–7 дней |
| M3. Codex interaction parity | Threads, turns, approvals, input, interrupt/steer/queue, settings | 5–8 дней |
| M4. Dashi UX port | Controls, streaming UI, media/files, HUD, heartbeat, redaction | 5–8 дней |
| M5. Hardening и RC | Security, chaos/E2E, migrations, observability, packaging | 5–7 дней |
| M6. `v1.0` | Документация, upgrade path, release artifacts, soak | 2–4 дня |

Итого: примерно 5–7 недель до уверенного `v1.0`; полезный personal alpha — в конце M1, то есть примерно через 1.5 недели.

## 5. Подробный план

### M0 — baseline и снятие протокольных рисков

- Импортировать Dashi с сохранением upstream remote и отдельным baseline commit.
- Переименовать продукт и отделить Dashi branding от технических package names постепенно.
- Проверить лицензии всех источников. Telemax без публичной лицензии использовать как specification/reference, не копировать код в публичный репозиторий.
- Зафиксировать ADR:
  - runtime/service против optional plugin;
  - `AgentBackend` boundary;
  - delivery semantics;
  - SQLite/WAL и migration policy;
  - App Server lifecycle и version pinning.
- Собрать минимальный App Server harness на `stdio`: `initialize`, `thread/start`, `turn/start`, event stream, `turn/interrupt`.
- Генерировать TS/JSON schemas командой установленной версии Codex и проверять schema drift в CI.
- Экспериментально выяснить поведение при crash/restart:
  - активного turn;
  - ожидающего approval;
  - ожидающего user input;
  - reconnect/resume существующего thread.

Наблюдение для Codex CLI `0.149.1`: `thread/start` сам по себе возвращает id,
но без первого turn rollout ещё не существует и новый App Server процесс не
может выполнить `thread/resume`. Поэтому binding нового thread должен иметь
состояние `provisional` до подтверждённого старта первого turn.

Gate M0: чистая установка воспроизводима; harness проходит contract test против закреплённой версии Codex; неизвестные restart-сценарии описаны, а не замаскированы.

### M1 — первый сквозной, уже durable путь

- Ввести доменные интерфейсы: `TelegramGateway`, `InboxRepository`, `OutboxRepository`, `SessionCoordinator`, `AgentBackend`.
- Создать SQLite migrations для updates, sessions, thread bindings, turns и delivery jobs.
- Сохранять update с уникальным `(bot_id, update_id)` до продвижения offset.
- Реализовать lease worker и минимальные состояния outbox.
- Подключить `CodexAppServerBackend` как supervised subprocess.
- Команды personal alpha: `/start`, `/new`, `/status`, `/stop`.
- Text message запускает turn; финальный ответ доставляется только через outbox.
- Agent progress сворачивается в throttled update, а не создаёт десятки сообщений.

Gate M1: после `kill -9` на любой границе уже принятый update не теряется; повторный update дедуплицируется; завершённый ответ либо доставлен с remote id, либо видим в проблемном состоянии.

### M2 — ядро надёжности Telemax

- Полная state machine:
  - `RECEIVED` → `PENDING` → `LEASED` → `DELIVERED`;
  - `RETRY_WAIT`, `AMBIGUOUS`, `FAILED`, `EXPIRED`, `ARCHIVED`.
- `send_started_at` записывается непосредственно перед внешним Telegram call.
- Bounded retry с exponential backoff и jitter; TTL и max attempts.
- Recovery истёкших leases при старте и периодическим reaper.
- FIFO внутри session/chat и изоляция разных chats/projects.
- Source-key idempotency для каждого логического исходящего действия.
- Единая модель jobs для send/edit/delete/reaction/media/album.
- Problem center: `/failed`, `/ambiguous`, `/retry`, `/resolved`, `/archive`.
  **Готов первый срез:** списки не раскрывают payload/error detail, действия
  идемпотентны и пишутся в audit ledger с actor и исходным/целевым состоянием.
- Supervisor для polling, App Server, workers, reaper и health loops.
- Структурные тесты «no bypass»: Telegram client нельзя импортировать вне gateway/sender boundary.

Gate M2: fault-injection matrix проходит автоматически; `AMBIGUOUS` никогда не ретраится сам; ручное решение job идемпотентно и аудируется.

### M3 — полноценный Codex client в Telegram

- Thread bindings: project/chat/topic ↔ Codex thread id.
- `/threads`, `/switch`, `/new`, `/archive`, `/resume`. **Готово для
  bridge-managed threads:** registry backfill-ится из schema v6, switch/archive
  запрещены при активном или `UNKNOWN` turn, следующий turn вызывает штатный
  `thread/resume` через `AgentBackend`.
- Очередь пользовательских turns; ровно один активный turn на thread. **Готово:**
  порядок хранится в SQLite, переживает restart, а terminally failed inbox item
  не блокирует очередь навсегда.
- Явный `/steer` для `turn/steer`; обычное сообщение при занятом thread по умолчанию становится следующим queued turn.
- `/stop` вызывает `turn/interrupt` и корректно закрывает UI state.
- Server-initiated approvals отображаются inline buttons с проверкой owner и одноразовым решением. **Готово для command/file и permission-profile requests:** grant дополнительных network/filesystem permissions строится только из сохранённого запроса; Telegram callback выбирает turn/session, но не несёт и не расширяет права. Deny, timeout и отсутствующий thread route возвращают пустой grant.
- User-input requests получают durable correlation id и срок жизни. **Готово:** обычные вопросы поддерживают кнопки и `/answer`; secret prompts отклоняются до Telegram.
- MCP elicitation. **Готово для стабильных `form` и `url` modes:** поля стандартной schema нормализуются в typed Telegram controls, текст/числа принимаются через `/elicit`, URL-кнопка разрешает только HTTPS без embedded credentials. Ответы, multiselect и completion markers durable; deny/cancel/timeout/unroutable request закрываются безопасно. Расширенный `openai/form` capability намеренно не объявляется и такой запрос отменяется до сохранения произвольной schema.
- `/model`, `/effort`, `/sandbox`, `/approval`, `/cwd`; модели и возможности читаются динамически через App Server. **Готово:** выбор проекта и overrides хранятся в SQLite по bot/chat/project; `/cwd` принимает только id из `projects[]`, а `danger-full-access` доступен только при явном включении в `allowedSandboxModes`.
- Image/file inputs конвертируются в поддерживаемые input items; неподдерживаемые типы отклоняются до запуска turn. **Готово:** photo/image documents идут нативным `localImage`, voice/audio — `localAudio`, разрешённые documents/video — через приватный durable file и bridge-generated path metadata. READY proof включает SHA-256 и проверяется при каждом использовании.
- Неизвестные App Server events сохраняются диагностически и безопасно игнорируются, не валят процесс. **Готово:** каталог известных методов проверяется вместе с generated schema, а unknown method агрегируется в bounded SQLite-журнал без params/body.
- Restart recovery не запускает заменяющий turn. **Готово:** startup reconciler читает
  сохранённый turn через стабильный `thread/read(includeTurns: true)`; `COMPLETED`
  возвращается в исходную inbox operation, `FAILED/INTERRUPTED` закрываются без
  повтора, а `inProgress`, отсутствующий turn или completed без доказанного final
  переходят в `UNKNOWN`. Потерянный ответ `turn/start` коррелируется по
  `clientUserMessageId = operationKey`. Старые approval/user-input/MCP requests получают
  `STALE`; недоставленные карточки архивируются, доставленные редактируются без
  кнопок, post-send uncertainty остаётся `AMBIGUOUS`. `/new force` — явный
  операторский выход из `UNKNOWN`, обычный `/new` по-прежнему fail-closed.

Gate M3: все поддержанные flows покрыты record/replay fixtures и contract tests; upgrade Codex CLI либо проходит schema check, либо блокируется понятной ошибкой.

### M4 — лучший UX Dashi

- [x] Dashi controls и статусная модель отвязаны от Claude events через provider-neutral `AgentBackend`/UX contracts.
- [x] HTML/Markdown sanitation, chunking, secret redaction и safe previews: independently valid chunks до 4000 символов образуют ordered outbox chain; parse rejection безопасно падает в plain text.
- [x] HUD показывает active project/thread/turn, model, effort, sandbox/approval, plan и доступный context/token usage.
- [x] Heartbeat и backend hang/restart status не содержат prompt, command, plan или reasoning body.
- [x] Durable media references проверяют regular-file, root, MIME, size и SHA-256 на каждой попытке; transient preparation остаётся retryable только до `send_started`.
- [x] Outbound album — одна atomic outbox job и один Telegram `sendMediaGroup` proof; inbound `media_group_id` — одна SQLite-группа и один Codex turn.
- [x] Voice transcription запускается только после durable READY path через отдельный adapter; без adapter Codex получает нативный `localAudio`.
- [x] File inbox/outbox применяет exact MIME/size policy, safe generated names, private spool и content proofs.

Gate M4: **пройден.** Telegram mutations доступны только worker/gateway после durable job; E2E покрывает длинные HTML-ответы, media retry/tamper, albums, voice и restart на upload boundary без автоматического дубля.

### M5 — production hardening

- Owner bootstrap без утечки bot token; deny-by-default allowlist.
- Явный выбор writable roots, sandbox и network policy на project.
- Config validation и `doctor` с actionable diagnostics.
- Log redaction, payload retention и scrub после delivery/expiry.
- SQLite backup/restore, migrations forward-only и тест upgrade с предыдущего релиза.
- Health endpoints/systemd watchdog, incident lifecycle и алерты без message body.
- Rate limiting и защита inline callbacks/replayed commands.
- Chaos tests App Server/Telegram/SQLite/process restarts.
- Load/soak: длинный turn, burst updates, Telegram 429, network timeouts, disk full/read-only.
- SBOM, dependency/license audit, release signing/checksums по возможности.

Gate M5: 72-часовой soak без потерянных acknowledged updates, скрытых worker crashes и бесконечных retry loops.

### M6 — `v1.0`

- Installation guide для systemd и Docker.
- Backup/restore/upgrade/rollback runbook.
- Security model и честно описанные delivery guarantees.
- Release artifacts и pinned compatibility matrix: bridge ↔ Codex CLI.
- Optional `.codex-plugin` только для install/doctor/skills/docs, если он реально упрощает onboarding.

Gate `v1.0`: новый пользователь поднимает мост по документации, проходит smoke test, перезапускает сервис и продолжает существующий thread без ручного ремонта БД.

## 6. Fault-injection matrix

| Точка падения | Ожидаемое поведение |
|---|---|
| После записи Telegram update, до offset advance | update будет обработан после рестарта, duplicate безопасно схлопнется |
| После lease, до `send_started` | job вернётся в retry |
| После `send_started`, до Telegram response | job станет `AMBIGUOUS`, авто-retry запрещён |
| После Telegram success, до записи `DELIVERED` | job станет `AMBIGUOUS`; оператор сверит/решит |
| Во время active Codex turn | thread/session восстанавливаются насколько позволяет протокол; пользователь получает честный terminal status |
| Во время approval/user-input request | устаревший callback не применяется; запрос либо восстанавливается, либо явно expires |
| Во время media download/upload | job использует durable reference, получает свежий URL и следует тем же ambiguity rules |

## 7. Метрики готовности

- 0 потерянных acknowledged Telegram updates в fault tests.
- 0 автоматических повторов jobs в `AMBIGUOUS`.
- 100% `DELIVERED` jobs имеют remote id.
- 100% Telegram mutations проходят через разрешённый gateway/outbox boundary.
- Восстановление workers и приём новых updates после restart — до 30 секунд при исправной инфраструктуре.
- P95 первичного bot acknowledgement — до 2 секунд без Telegram rate limiting.
- Нет message content, tokens и approval payloads в обычных health/incident alerts.

## 8. Что делать после `v1.0`

Приоритетный порядок:

1. `v1.1`: Claude backend через тот же `AgentBackend`, без отдельных путей Telegram delivery.
2. `v1.2`: group/topic mode и несколько доверенных пользователей с ACL.
3. `v1.3`: multi-agent/fleet и routing между backends.
4. `v1.4`: remote App Server только после стабилизации официального transport и полноценной auth/TLS модели.
5. Web admin UI — только если Telegram problem center перестанет покрывать реальные операции.

## 9. Первый рабочий sprint

1. Импортировать Dashi и сохранить pristine baseline.
2. Добавить ADR и compatibility manifest.
3. Поднять App Server stdio harness и записать реальные fixtures.
4. Спроектировать SQLite schema и delivery state machine до Telegram handlers.
5. Реализовать единственный vertical slice `text → Codex → final text`.
6. Добавить четыре обязательных crash tests вокруг inbox/outbox.
7. Выпустить `v0.1.0-personal-alpha` только после прохождения этих tests.

Главный критерий приоритета: сначала доказать, что сообщение нельзя молча потерять или опасно повторить; затем добавлять удобство и breadth.
