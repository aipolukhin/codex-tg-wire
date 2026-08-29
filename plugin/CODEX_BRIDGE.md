# Dashi Codex Telegram Bridge — personal alpha

Это отдельный durable bridge-сервис, а не Claude Code channel runtime. Он принимает Telegram update в SQLite, запускает turn через Codex App Server и отправляет финальный ответ только через durable outbox.

## Запуск

Требования: Bun, установленный и авторизованный `codex`, Telegram bot token и собственные Telegram user/chat id.

```bash
cd plugin
bun install
cp bridge.config.example.json bridge.config.json
```

В `bridge.config.json` замени примерные id и укажи один или несколько проектов. Относительные `cwd` и `stateDatabase` считаются от директории файла конфигурации. Токен намеренно запрещён в JSON — передай его только через окружение:

```bash
export DASHI_TELEGRAM_BOT_TOKEN='...'
bun run start:codex
```

Для конфига в другом месте:

```bash
export DASHI_CODEX_BRIDGE_CONFIG=/absolute/path/bridge.config.json
```

Путь к нестандартному Codex можно задать как `codex.binary` в JSON или через `CODEX_BINARY_PATH`. При старте сервис проверяет токен через `getMe`, сам получает bot id/username, открывает SQLite/WAL и инициализирует `codex app-server`.

Personal alpha поддерживает обычный текст и команды `/start`, `/new`, `/status`, `/stop`, `/steer <уточнение>`. `/steer` дополняет именно активный turn; обычное сообщение становится отдельным следующим turn. Если session занята, следующие сообщения сохраняются в SQLite и выполняются FIFO, в том числе после restart. Команды, approval-кнопки и ответы на вопросы идут как control updates и не ждут за очередью сообщений — поэтому активный turn можно сразу остановить или скорректировать. Command/file approvals приходят inline-карточками. На обычные вопросы Codex можно ответить кнопкой; свободный ответ отправляется командой, указанной на карточке: `/answer <id> <номер-вопроса> <текст>`.

Настройки Codex применяются к выбранному проекту и переживают restart:

- `/model` показывает live-каталог `model/list`; `/model <id>` выбирает модель, `/model default` сбрасывает model и effort;
- `/effort` показывает возможности выбранной модели; `/effort <value>` выбирает уровень, `/effort default` возвращает default модели;
- `/sandbox` и `/approval` показывают и меняют policy; суффикс `default` убирает override;
- `/cwd` показывает разрешённые проекты, `/cwd <project-id>` выбирает проект для следующих команд и turns.

`/cwd` намеренно не принимает filesystem path: project id и его `cwd` должны заранее находиться в `projects[]` конфигурации. Переключение запрещено, пока в текущем проекте есть `ACTIVE` или `UNKNOWN` turn. Выбранный проект хранится отдельно для каждого bot/chat, а model/effort/sandbox/approval — отдельно для каждого bot/chat/project. `/status` показывает эффективные настройки текущего проекта даже до создания первого thread.

Bridge-managed Codex threads хранятся отдельно от текущего binding:

- `/new` отвязывает current thread, но не забывает его;
- `/threads` показывает выбранный, доступные и локально архивированные threads;
- `/switch <thread-id>` выбирает доступный thread; `/resume <thread-id>` явно возвращает локально архивированный;
- `/archive <thread-id>` локально архивирует thread. Если передан id delivery job, эта же команда выполняет действие problem center.

Switch/archive current thread запрещены при `ACTIVE` или `UNKNOWN` turn. Registry и выбор переживают restart; следующее обычное сообщение продолжает выбранный thread через Codex `thread/resume`.

Problem center показывает только безопасные метаданные delivery jobs, без тела сообщения и transport error detail:

- `/failed` — последние `FAILED` и `EXPIRED`; `/retry <job-id>` запускает новый bounded retry cycle, `/archive <job-id>` закрывает проблему;
- `/ambiguous` — отправки с неизвестным результатом; прямой retry запрещён из-за риска дубля;
- `/resolved <job-id> <telegram-message-id>` — отметить проверенную вручную отправку как `DELIVERED`; `/archive <job-id>` — закрыть без повтора.

Принятые действия идемпотентны и сохраняются в `delivery_problem_actions` вместе с actor, исходным и целевым состоянием.

По умолчанию `codex.approvalPolicy` равен `on-request`, `codex.sandboxMode` — `workspace-write`, а `codex.allowedSandboxModes` разрешает только `read-only` и `workspace-write`. `danger-full-access` нельзя включить одной Telegram-командой: оператор должен сначала явно добавить его в allowlist конфигурации. Интерактивный запрос живёт 10 минут (`codex.interactionTimeoutMs`); этот timeout должен быть меньше `codex.turnTimeoutMs`. `SIGINT`/`SIGTERM` прекращает polling и новые lease, дожидается уже взятой работы, затем закрывает App Server и SQLite.

## Граница безопасности

- allowlist пользователей и чатов обязательны и работают deny-by-default;
- bot token не хранится в конфиге или SQLite;
- исходящий текст проходит secret redaction;
- update сохраняется до продвижения Telegram offset;
- очередь turns и её порядок хранятся в SQLite; ожидание занятой session не расходует retry budget;
- выбор проекта и Codex overrides хранятся в SQLite; Telegram не может подставить произвольный `cwd` или обойти sandbox allowlist;
- доставка после `send_started` с неизвестным результатом становится `AMBIGUOUS` и автоматически не повторяется.
- prompts, edits и callback acknowledgements тоже проходят durable outbox;
- первый валидный ответ выигрывает, повторный или callback от старого App Server соединения ничего не разрешает;
- вопросы с `isSecret=true` отклоняются: мост не просит присылать пароль или токен в Telegram.

Это personal alpha: permission-profile/MCP approvals, media и recovery активного turn ещё идут следующими срезами roadmap.
