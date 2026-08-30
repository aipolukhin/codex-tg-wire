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
- UX-паттерны inline-кнопок, progress/status card и heartbeat. Технический HUD
  сохранён только как opt-in диагностика; обычный чат показывает финальные ответы.
- Подходы к Telegram media, voice transcription и rate limiting.

Codex runtime прямо использует общие модули `format/chunk.ts`, `format/html.ts`,
`safety/redact.ts` и `safety/html-validator.ts`. Durable poller, gateway,
attachments, albums, status projector и interaction broker написаны как новые
Codex-oriented реализации вокруг этих primitives.

### Не перенесено в Codex runtime v1

Это не механически потерянные функции. Мы не стали переносить runtime-механизмы,
которые решали ограничения Claude Code/tmux или противоречили owner-only модели
первого релиза.

| Функция Dashi | Почему исключена | Что используется вместо неё / когда вернётся |
|---|---|---|
| Claude Code channel/MCP lifecycle, `--dangerously-load-development-channels` и Anthropic Max billing model | Это lifecycle, auth и экономика другого провайдера. Если оставить его внутри основного процесса, продукт снова потребует две несовместимые схемы запуска и перестанет быть понятным Codex-мостом. | Нативный Codex App Server по supervised stdio, официальный Codex login и provider-neutral `AgentBackend`. Второй Claude backend возможен отдельно после v1, без смешивания lifecycle. |
| tmux transport, terminal mirror, pane classifier, `/keys`, `/cc` | tmux был API к интерактивному terminal Claude: приходилось распознавать состояние pane и посылать keystrokes. App Server уже даёт typed threads, turns, approvals и interrupt/steer. Эмуляция клавиатуры здесь добавила бы гонки, потерю correlation ids и лишний remote-shell surface. | JSONL/RPC App Server transport и структурированные `/stop`, `/steer`, `/threads`, `/resume`. |
| Claude hooks `PreToolUse`, `PostToolUse`, `Stop`, TaskMirror | Названия событий и payloads принадлежат Claude Code. Их адаптер поверх Codex дублировал бы настоящий протокол и мог расходиться с ним при restart. | App Server notifications, command/file approvals, user input и MCP elicitation фиксируются в SQLite interaction broker до ответа. |
| Transcript-based read receipts и fallback reply | Dashi читает изменяемый transcript-файл и эвристически решает, был ли уже ответ. После crash такая эвристика способна отправить дубль или принять thinking/tool event за финал. | Typed turn events + transactional outbox. Неизвестная внешняя отправка становится `AMBIGUOUS`, а не скрытым fallback-дублем. |
| Полный multichat: groups, topics, per-chat tmux и personas | v1 сознательно фиксирует один trust domain: приватные allowlisted user/chat IDs. Groups/topics требуют отдельной ACL-модели для sender/chat/topic, маршрутизации threads и тестов утечки контекста; `per-chat tmux` к Codex неприменим. | Durable thread registry уже разделяет Codex sessions. Groups/topics и их ACL запланированы после v1; personas вернутся только как backend-neutral overlay. |
| Guest Mode и публичные чаты | Telegram-сообщение запускает coding agent, расходует quota и может менять файлы. Давать это неизвестному пользователю несовместимо с owner-only threat model, особенно при default YOLO. | Fail-closed user/chat allowlist. Публичный бот не считается поддерживаемым режимом и не планируется без отдельной tenant/sandbox архитектуры. |
| Dashi autonomy lease и ask-guard | Они компенсировали self-gating Claude внутри terminal: отслеживали mandate и блокировали лишнее «спросить разрешение». В Codex approval policy и sandbox являются входными параметрами каждого thread/turn; второй guard создал бы конфликтующие решения. | Default YOLO передаёт `approvalPolicy=never` + `danger-full-access`; Safe profile передаёт `on-request` + `workspace-write`. Durable interaction broker обрабатывает только реальные запросы App Server. |
| Fleet orchestration | Fleet — отдельный control plane: discovery, scheduling, tenant isolation, aggregate health и rollouts нескольких agents. Втаскивание его в первый single-owner daemon усложнило бы recovery раньше, чем стабилизирован один узел. | Один supervised App Server и один transactional state contour в v1. Fleet вынесен в post-v1 roadmap. |
| Memory hooks в `recent.md` и verbose JSONL | Формат и пути привязаны к конкретному Claude workspace/cognee pipeline, дублируют историю Codex и повышают риск второго неочищенного хранилища prompts/secrets. | Codex threads + SQLite audit/state с retention и scrub. Экспорт памяти должен появиться как явный backend-neutral sink, а не скрытый hook. |
| macOS/launchd production deployment | Текущий production gate, watchdog и canary проверены на Linux/systemd и Docker. Непроверенный launchd plist выглядел бы как поддержка, но не давал бы доказательств restart/readiness. | Linux user-systemd — простой путь; system-wide systemd и Docker — advanced. launchd можно добавить после отдельного macOS CI/canary. |
| Файловая crash-модель: inbox/outbox и restart живой Claude-сессии | Отдельные JSON/JSONL-файлы не позволяют одной транзакцией связать dedupe update, lease, turn binding, outbound proof и polling offset. Автоматически «оживлять» неизвестный turn опасно дублем работы. | SQLite/WAL с транзакциями, leases, reaper, FIFO turns, `thread/read`, `UNKNOWN` и `AMBIGUOUS`. Файлы остались только для content-addressed media и проверяемых backup artifacts. |

Legacy Claude-модули пока **физически остаются** в source tree: общий Telegram-код
ещё извлекается из исходного графа импортов. Это временная мера, чтобы extraction
не превратился в big-bang rewrite. Production entry point `bun run start:codex`
их не загружает, README не объявляет их частью продукта, а удалить их можно
после выделения общих primitives и отдельного regression gate.

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
  результата;
- phone-friendly console onboarding: узкий banner, короткие нумерованные шаги,
  скрытый ввод секрета, валидация рядом с prompt, спокойный Ctrl+C и идемпотентный
  повтор setup. В `install.sh` этот UX реализован заново на Bash/ANSI без
  зависимостей от Rich/questionary.
- native presence из `bridge/presence`: throttled
  `sendChatAction("typing")`, best-effort 👀 receipt и один тихий закреп со
  схемой edit-in-place → send/pin/delete fallback. TypeScript-реализация хранит
  только заменяемый anchor и payload-free telemetry в основной SQLite.

В codex-tg-wire эта модель заново реализована на TypeScript/Bun и расширена на
turn queue, Codex thread bindings, approvals, callbacks и App Server recovery.

## Другие Codex bridges

Код этих проектов не vendored и не копировался; они использовались как
поведенческие референсы и контрпримеры.

- [Gan-Xing/telegram-codex-app-bridge](https://github.com/Gan-Xing/telegram-codex-app-bridge) —
  практический mapping App Server threads/turns, approvals, user input и
  Telegram controls. M6.5 также использует как поведенческие референсы account
  status/login, native session handoff, inline settings, diff/review и явный
  busy-turn выбор. Код и state model не копировались: все действия проведены
  через provider-neutral contracts, SQLite interactions и durable outbox. Не
  взята модель, где polling cursor зависит от полного завершения обработки:
  codex-tg-wire сначала фиксирует raw update, затем продвигает offset.
- [woosungchoi/codex-telegram-bot](https://github.com/woosungchoi/codex-telegram-bot) —
  сценарии очереди, reply-oriented продолжения и восстановления прерванных
  Codex jobs. Не взяты JSON/JSONL state files как транзакционная база и
  эвристический запуск замещающего turn.

### Карта M6.5: референс → собственная проводка

| Capability | Поведенческий референс | Что реализовано в codex-tg-wire |
|---|---|---|
| Account status и device login | Gan-Xing bridge + официальный App Server | Typed `account/read` и `account/login/start` через `AgentBackend`; результат выводится Telegram action card. |
| Native session discovery/handoff | Gan-Xing bridge | cwd-confined `/sessions`, `/attach`, `/handback`, rename/archive/unarchive/fork/compact поверх App Server и SQLite bindings. |
| Inline settings | Gan-Xing bridge и Dashi UX | Provider-neutral model/effort/sandbox/approval/project/plan panel; каждое callback-действие allowlisted, durable и idempotent. |
| Busy turn choice | Gan-Xing bridge + очередь woosungchoi | Явные steer/queue/stop-and-replace/cancel; решение хранится до исполнения и не угадывается по времени прихода сообщения. |
| Reply → exact thread | Reply-oriented UX woosungchoi | Собственный SQLite route registry связывает доказанный Telegram `message_id` с Codex thread и переживает restart. |
| Diff/file/review | Gan-Xing bridge + App Server schema | Durable diff artifact, root-confined file delivery и native `review/start`; все Telegram mutations идут через outbox. |
| Guided Plan | Общий UX pattern coding bridges | Собственная persisted state machine: read-only draft/revision, explicit execute/cancel, затем writable turn в том же thread. |

Код референсных bridges не копировался. Их удобные пользовательские flows
перепроведены через общие contracts, SQLite repositories, App Server typed
methods и одну durable Telegram delivery boundary.

## M7: deployment и bot-first onboarding

Docker login flow сверялся с
[hotchpotch/openai-api-server-via-codex](https://github.com/hotchpotch/openai-api-server-via-codex),
Apache-2.0. Оттуда взят deployment pattern: profile-gated one-shot login helper,
общий persistent `CODEX_HOME`, loopback-only browser callback proxy и device-code
fallback. Compose topology, hardening, wrapper и credential layout написаны для
codex-tg-wire заново; attribution сохранён в `NOTICE`.

Основной host-first выбор и спокойный четырёхшаговый console flow продолжают
Telemax-inspired onboarding. Новая Telegram-проводка написана здесь:

- `/start` сам проверяет account и запускает App Server device login;
- inline buttons формулируют конкретные действия, а команды остаются fallback;
- host install переиспользует `~/.codex`, Docker держит отдельный persistent
  `CODEX_HOME`;
- Groq не выдаёт подходящий bridge OAuth/device flow, поэтому кнопка ведёт на
  [официальную страницу API Keys](https://console.groq.com/keys), а присланный
  key валидируется, атомарно сохраняется и удаляется из Telegram/SQLite;
- Docker остаётся optional; default deployment — user-systemd в домашней
  директории.

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
- Native account/session commands, cwd-confined handoff, inline settings и
  exact Telegram-message → Codex-thread route registry.
- Button-first Codex/Groq onboarding, dynamic private Groq credential rotation
  без restart и durable scrub/delete secret-bearing commands.
- Persisted busy choices, turn-diff artifacts, safe file/review controls и
  Guided Plan state machine.
- Durable Telegram poller, gateway, attachment store, outbound media/album path,
  rate limiter и voice adapter.
- payload-free event projector, heartbeat, `/status` snapshot и
  unknown-notification journal; per-answer HUD выключен, а quota/context
  показываются в одном нативном закрепе.
- Doctor, health/readiness/watchdog, backup/restore, retention, soak/chaos gates,
  SBOM, reproducible artifacts, optional hardened Docker wrapper и atomic
  upgrade/rollback.
