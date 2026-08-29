# Dashi Codex Telegram Bridge — personal alpha

Это отдельный durable bridge-сервис, а не Claude Code channel runtime. Он принимает Telegram update в SQLite, запускает turn через Codex App Server и выполняет Telegram mutations только через durable outbox. Markdown финального ответа преобразуется в проверенный Telegram HTML; длинный ответ становится упорядоченной цепочкой сообщений до 4000 символов каждое. Media/file jobs используют content-addressed private spool и повторно проверяются перед каждой попыткой.

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

Personal alpha поддерживает обычный текст и команды `/start`, `/new`, `/status`, `/stop`, `/steer <уточнение>`. `/steer` дополняет именно активный turn; обычное сообщение становится отдельным следующим turn. Если session занята, следующие сообщения сохраняются в SQLite и выполняются FIFO, в том числе после restart. Команды, approval-кнопки и ответы на вопросы идут как control updates и не ждут за очередью сообщений — поэтому активный turn можно сразу остановить или скорректировать. Command/file approvals и запросы дополнительных network/filesystem permissions приходят inline-карточками. Permission-карточка позволяет выдать ровно запрошенное подмножество на текущий turn или явно на session; отказ и timeout возвращают пустой grant. На обычные вопросы Codex можно ответить кнопкой; свободный ответ отправляется командой, указанной на карточке: `/answer <id> <номер-вопроса> <текст>`.

MCP elicitation поддерживает стандартные `form` и `url` modes. Boolean/enum/multiselect поля управляются кнопками, строки и числа вводятся через `/elicit <id> <номер-поля> <значение>`, необязательное поле можно пропустить. URL открывается только по credential-free HTTPS-кнопке; полный URL не дублируется в тексте карточки. Ответы и completion markers сохраняются durable, а deny/cancel/timeout/restart закрываются fail-closed. Capability `openai/form` мост не объявляет: несогласованная расширенная форма отменяется до сохранения её произвольной schema. Password-like standard schema также отклоняется.

Семантика permission grant следует [официальной документации Codex App Server](https://developers.openai.com/codex/app-server); точная wire-форма проверяется локальным schema gate против закреплённой версии Codex CLI.

Настройки Codex применяются к выбранному проекту и переживают restart:

- `/model` показывает live-каталог `model/list`; `/model <id>` выбирает модель, `/model default` сбрасывает model и effort;
- `/effort` показывает возможности выбранной модели; `/effort <value>` выбирает уровень, `/effort default` возвращает default модели;
- `/sandbox` и `/approval` показывают и меняют policy; суффикс `default` убирает override;
- `/cwd` показывает разрешённые проекты, `/cwd <project-id>` выбирает проект для следующих команд и turns.

`/cwd` намеренно не принимает filesystem path: project id и его `cwd` должны заранее находиться в `projects[]` конфигурации. Переключение запрещено, пока в текущем проекте есть `ACTIVE` или `UNKNOWN` turn. Выбранный проект хранится отдельно для каждого bot/chat, а model/effort/sandbox/approval — отдельно для каждого bot/chat/project. `/status` показывает эффективные настройки текущего проекта даже до создания первого thread.

Bridge-managed Codex threads хранятся отдельно от текущего binding:

- `/new` отвязывает current thread, но не забывает его; при `UNKNOWN` нужен явный `/new force`;
- `/threads` показывает выбранный, доступные и локально архивированные threads;
- `/switch <thread-id>` выбирает доступный thread; `/resume <thread-id>` явно возвращает локально архивированный;
- `/archive <thread-id>` локально архивирует thread. Если передан id delivery job, эта же команда выполняет действие problem center.

Switch/archive current thread запрещены при `ACTIVE` или `UNKNOWN` turn. Registry и выбор переживают restart; следующее обычное сообщение продолжает выбранный thread через Codex `thread/resume`.

## HUD и heartbeat

Для каждого turn bridge создаёт durable status root и обновляет только доказанный Telegram `message_id`. Карточка показывает выбранный project, thread/turn, model, effort, sandbox/approval, plan progress и token/context usage, когда эти числа присылает App Server. Проектор принимает provider-neutral progress facts: command, plan и reasoning body в статусную таблицу не попадают.

Если App Server долго не даёт активности, heartbeat создаёт ordered edit job с безопасным elapsed status. После restart незавершённая карточка честно переходит в `UNKNOWN`; скрытого заменяющего turn нет. Все status sends/edits проходят через тот же outbox и сохраняют обычные правила `send_started`/`AMBIGUOUS`.

## Восстановление после рестарта

До запуска polling и workers bridge проверяет каждый turn, оставшийся `ACTIVE`.
Стабильный `thread/read` с `includeTurns: true` читает сохранённую историю без
`thread/resume`, подписки или нового model call:

- доказанный `COMPLETED` с final message сохраняется локально, а исходный Telegram update снова проходит обычный idempotent путь и доставляет ответ;
- `FAILED` и `INTERRUPTED` закрывают исходный update без автоматического повтора;
- `inProgress`, отсутствующий turn, ошибка чтения или completed без final message становятся `UNKNOWN`; новая работа автоматически не запускается;
- если ответ `turn/start` потерялся до записи backend turn id, bridge ищет ровно один turn по сохранённому `clientUserMessageId = operationKey`;
- `/new force` явно помечает `UNKNOWN` как оставленный оператором и отвязывает thread. Обычный `/new` этого не делает.

Server request живёт только в том App Server connection, который его создал.
Поэтому approval/user-input/MCP elicitation от прошлого процесса становится `STALE`: ещё не
отправленная карточка архивируется, уже доставленная редактируется и лишается
кнопок, а prompt, для которого отправка началась без remote proof, остаётся
`AMBIGUOUS` в problem center. Ответ на старую кнопку никогда не уходит в новый
App Server connection.

Problem center показывает только безопасные метаданные delivery jobs, без тела сообщения и transport error detail:

- `/failed` — последние `FAILED` и `EXPIRED`; `/retry <job-id>` запускает новый bounded retry cycle, `/archive <job-id>` закрывает проблему;
- `/ambiguous` — отправки с неизвестным результатом; прямой retry запрещён из-за риска дубля;
- `/resolved <job-id> <telegram-message-id>` — отметить проверенную вручную отправку как `DELIVERED`; `/archive <job-id>` — закрыть без повтора.

Принятые действия идемпотентны и сохраняются в `delivery_problem_actions` вместе с actor, исходным и целевым состоянием.

Длинный финальный ответ сначала целиком раскладывается в SQLite и лишь затем входящий update помечается обработанным. Каждый chunk ждёт `DELIVERED` predecessor. Поэтому неизвестный результат отправки останавливает хвост в очереди: `/resolved` с проверенным Telegram message id продолжает цепочку, а `/archive` закрывает оставшиеся зависимые chunks без скрытого повтора.

## Media/file inbox, albums и voice

Bridge принимает Telegram photo, documents, voice/audio и разрешённые video. Photo и image documents передаются нативным `localImage`, voice/audio — `localAudio`. Обычный документ или video сохраняется локально, а Codex получает bridge-generated metadata с абсолютным path и читает файл своими sandboxed tools. `mention` для этого не используется: в App Server он предназначен для apps. Протокольный источник: [официальная документация Codex App Server](https://developers.openai.com/codex/app-server).

Фрагменты одного Telegram `media_group_id` сначала становятся отдельными durable inbox rows, но SQLite-группа разрешает lease только лидеру после `albums.flushMs` тишины. Caption и вложения собираются в один Codex input; `processed`, retry, terminal failure и expired-lease recovery применяются ко всей группе транзакционно. Фрагмент, пришедший после начала обработки группы, не теряется и обрабатывается как отдельное сообщение. Исходящий album — одна `send_album` job, один вызов `sendMediaGroup` и один proof со всеми Telegram message ids.

Порядок обработки:

1. raw Telegram update сначала фиксируется в SQLite;
2. private chat и sender проходят deny-by-default allowlist;
3. MIME и заявленный размер проверяются до скачивания;
4. тело скачивается с жёстким streaming limit, MIME-specific magic проверяется;
5. файл атомарно сохраняется под generated hash-name с mode `0600`, READY metadata — в `telegram_attachments`, SHA-256 proof — отдельно в SQLite;
6. перед каждым повторным использованием проверяются regular-file/no-symlink, root, размер, magic и SHA-256; испорченный proof вызывает безопасную повторную загрузку;
7. только после этого запускается Codex turn или optional voice adapter.

Настройки находятся в секции `attachments`: `directory`, `maxBytes` (не больше 20 MiB) и точный `allowedMimeTypes`. По умолчанию разрешены JPEG/PNG/WebP/GIF, plain text/Markdown/CSV, JSON, PDF/XML, Ogg/MP3/MP4/WAV/WebM audio и MP4/WebM video. Произвольный `application/octet-stream`, executables и archives не разрешены. MIME mismatch, превышение лимита и запрещённый тип отклоняются до Codex; ответ об отказе проходит через durable outbox.

Voice provider по умолчанию выключен (`voice.provider: "none"`), при этом voice всё равно доступен Codex как `localAudio`. Для Groq укажи `voice.provider: "groq"` и передай ключ только через окружение:

```bash
export GROQ_API_KEY='...'
```

`voice.model`, `voice.language`, `voice.apiRoot`, `voice.maxBytes` и `voice.requestTimeoutMs` настраиваются в JSON; ключ там запрещён strict schema. Adapter читает только уже materialized path, ещё раз сверяет размер и SHA-256, нормализует Telegram `.oga` в multipart filename `.ogg` и fail-soft оставляет исходное аудио, если транскрипция недоступна. Транскрипт маркируется как недоверенный пользовательский ввод.

## Media/file outbox

`enqueueOutboundMedia` и `enqueueOutboundAlbum` сначала копируют разрешённый project file в private content-addressed spool. В durable job лежат безопасное имя, MIME, размер и SHA-256, но не временный Telegram URL. Перед каждой попыткой gateway заново открывает spool file и проверяет allowed root, отсутствие symlink, type/size/hash и совместимость с Telegram media kind. Caption проходит тот же Markdown → validated HTML → redaction pipeline.

До `send_started` ошибка подготовки или падение worker безопасно ретраится. После `send_started` неизвестный результат upload становится `AMBIGUOUS`; автоматический retry запрещён. Это одинаково для одного файла и atomic album.

Неизвестные notification methods от App Server агрегируются в `codex_unhandled_notifications`. Журнал ограничен 1000 строками и содержит только method, thread/turn correlation, счётчик и timestamps — `params`, prompt и file content туда не записываются. Каталог известных методов сверяется с generated schema командой `bun run codex:schema:check`.

По умолчанию `codex.approvalPolicy` равен `on-request`, `codex.sandboxMode` — `workspace-write`, а `codex.allowedSandboxModes` разрешает только `read-only` и `workspace-write`. `danger-full-access` нельзя включить одной Telegram-командой: оператор должен сначала явно добавить его в allowlist конфигурации. Интерактивный запрос живёт 10 минут (`codex.interactionTimeoutMs`); этот timeout должен быть меньше `codex.turnTimeoutMs`. `SIGINT`/`SIGTERM` прекращает polling и новые lease, дожидается уже взятой работы, затем закрывает App Server и SQLite.

## Граница безопасности

- allowlist пользователей и чатов обязательны и работают deny-by-default;
- bot token и Groq key не хранятся в JSON или SQLite;
- исходящий текст и подписи inline-кнопок проходят secret redaction;
- Markdown финального ответа проходит Telegram HTML allowlist и повторную проверку после redaction; каждый chunk ограничен 4000 символами, а подтверждение доставки хранится отдельно;
- update сохраняется до продвижения Telegram offset;
- очередь turns и её порядок хранятся в SQLite; ожидание занятой session не расходует retry budget;
- выбор проекта и Codex overrides хранятся в SQLite; Telegram не может подставить произвольный `cwd` или обойти sandbox allowlist;
- вложения скачиваются только после allowlist, имеют MIME/size/magic/hash gates и никогда не получают Telegram filename как локальный path;
- album grouping, media captions, HUD и heartbeat не создают отдельный Telegram send path;
- доставка после `send_started` с неизвестным результатом становится `AMBIGUOUS` и автоматически не повторяется.
- prompts, edits и callback acknowledgements тоже проходят durable outbox;
- первый валидный ответ выигрывает, повторный или callback от старого App Server соединения ничего не разрешает;
- callback permission-карточки выбирает только срок grant; сами права берутся из сохранённого server request, нормализуются по pinned App Server schema и не могут быть расширены Telegram payload;
- вопросы с `isSecret=true` отклоняются: мост не просит присылать пароль или токен в Telegram.
- MCP URL разрешён только по HTTPS без embedded credentials; `openai/form` не согласовывается, а secret-like form schema не превращается в Telegram-карточку.

Это personal alpha: durable recovery kernel и M4 UX/media slice закрыты. Следующий этап — M5 production hardening: doctor, retention/scrub, backup/restore, health/watchdog, rate limits, chaos/load и release supply-chain.
