# Codex bridge: production hardening и recovery

Этот runbook относится к standalone `bun run start:codex`. Legacy Claude channel runtime использует другой lifecycle и другой health endpoint. Установка: [codex-installation.md](codex-installation.md), upgrade/rollback: [codex-upgrade.md](codex-upgrade.md), security contract: [codex-security.md](codex-security.md).

## Preflight и секреты

Устанавливай только lockfile-resolved зависимости и сначала запускай doctor:

```bash
bun install --frozen-lockfile
export DASHI_CODEX_BRIDGE_CONFIG=/path/to/bridge.config.json
export DASHI_TELEGRAM_BOT_TOKEN='...'
bun run doctor:codex
bun run doctor:codex --online
```

Обычный doctor не обращается в Telegram. `--online` выполняет только `getMe`. Ни один режим не печатает token/Groq key и не создаёт production DB. FAIL даёт exit code `1`, неправильные аргументы — `2`.

Bot token и optional `GROQ_API_KEY` принимаются из environment или private credential file. Production templates используют systemd `LoadCredential` и Docker secrets; environment остаётся compatibility path. JSON strict: credential fields в нём запрещены. `allowedUserIds` и `allowedChatIds` обязательны и deny-by-default.

## Project policy

Каждый элемент `projects[]` фиксирует execution boundary:

```json
{
  "id": "main",
  "cwd": "/srv/project",
  "sandboxMode": "workspace-write",
  "writableRoots": ["/srv/generated"],
  "networkAccess": false
}
```

`cwd` всегда входит в writable roots для `workspace-write`; дополнительные roots должны быть перечислены явно. Relative paths считаются от config file. `networkAccess` передаётся в `turn/start.sandboxPolicy`. Telegram `/cwd` принимает только project id, а `/sandbox` не меняет roots/network. Wire-форма соответствует [официальной документации Codex App Server](https://developers.openai.com/codex/app-server).

Персональный `./install.sh` по умолчанию выбирает YOLO и включает
`danger-full-access`; это сознательная UX-настройка для приватного owner-only
бота, а не security boundary. `./install.sh --profile safe` оставляет только
`read-only`/`workspace-write`. В любом профиле doctor выдаёт WARN, когда
`danger-full-access` активен: writable roots, network sandbox и approvals тогда
не ограничивают Codex.

## Отмена задачи и локальные изменения

`taskWorkspaces.enabled` по умолчанию включён. Для чистого Git-проекта каждый
turn выполняется в отдельном detached worktree из
`taskWorkspaces.directory`; зарегистрированный checkout меняется только после
доказанного успешного завершения backend turn. Bridge применяет получившийся
diff без commit/push, поэтому обычная Git-шайба по-прежнему предлагает эти
действия владельцу.

Кнопка отмены требует второго подтверждения: «Отменить и очистить» прерывает
точный backend turn и удаляет его незавершённый worktree. Durable-флаг отмены
переживает restart, отменённая работа не попадает в auto-resume. Если restart
случился на границе успешной интеграции, bridge проверяет уже применённый patch
и идемпотентно заканчивает transition.

Если зарегистрированный checkout был грязным до начала turn, bridge переносит
его tracked и non-ignored untracked состояние в baseline капсулы. При успехе в
canonical checkout применяется только дельта задачи; при отмене baseline и
чужой черновик остаются нетронутыми. Для non-Git каталогов изоляция невозможна:
они продолжают работать напрямую и без обещания filesystem rollback. Внешние
side effects (API, сообщения, удалённые сервисы) автоматически не откатываются.
Для production укажи `taskWorkspaces.directory` на приватном локальном диске с
достаточным местом; завершённые metadata rows удаляются общим retention job.

## Health и systemd watchdog

По умолчанию health слушает только `127.0.0.1:8787`:

- `GET /live` — процесс находится в running lifecycle;
- `GET /ready` и `GET /health` — SQLite отвечает, а poller, каждый inbox worker, outbox, reaper и UX loop не stale и не превысили consecutive-error budget;
- любой degraded ответ — HTTP `503`.

Ответы содержат только lifecycle, elapsed time, counters и loop names. Bot/chat/project ids, message body, prompt, command, path и error detail не публикуются.

Минимальные важные настройки unit:

```ini
[Service]
Type=notify
NotifyAccess=all
WorkingDirectory=/opt/dashi/plugin
LoadCredential=telegram-token:/etc/dashi-codex-bridge/telegram-token
Environment=DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json
ExecStart=/usr/bin/env bun /opt/dashi-codex-bridge/current/plugin/src/codex-telegram-service.ts
Restart=on-failure
RestartSec=5s
KillMode=mixed
WatchdogSec=180s
```

`NotifyAccess=all` нужен, потому что bridge вызывает `systemd-notify` как дочерний
процесс. Watchdog подтверждает liveness event loop и продолжает пульсировать при
readiness degradation: долгий Codex turn законно держит один inbox worker дольше
`health.staleAfterMs` и не должен быть убит. `/ready` при этом остаётся degraded
для мониторинга. Если сам event loop зависнет, watchdog timer не выполнится и
systemd перезапустит процесс.

`KillMode=mixed` оставляет дочерний Codex App Server живым во время graceful
stop: сначала сигнал получает bridge, он дренирует текущий turn и outbox, затем
сам закрывает App Server. На следующем запуске recovery повторно инспектирует не
только `ACTIVE`, но и ранее неопределённые `UNKNOWN` turns. Если Codex уже может
доказать terminal state, сообщения, заблокированные этим turn, возвращаются в
durable FIFO автоматически.

При запуске вне systemd можно передать `DASHI_TELEGRAM_BOT_TOKEN_FILE`; внутри unit файл `telegram-token` автоматически находится через `CREDENTIALS_DIRECTORY`. Credential resolver не следует symlink, ограничивает размер и не печатает secret path/value.

## Backup и restore

Online backup безопасен при работающем WAL:

```bash
bun run backup:codex -- /backup/bridge-YYYYMMDD.sqlite3
```

Команда отказывается перезаписывать destination, делает консистентный `VACUUM INTO`, проверяет `quick_check`, ставит mode `0600` и создаёт соседний SHA-256 manifest без source path.

Restore выполняй только после clean stop:

```bash
systemctl stop dashi-codex-bridge.service
bun run restore:codex -- /backup/bridge-YYYYMMDD.sqlite3 --replace
bun run doctor:codex
systemctl start dashi-codex-bridge.service
```

Restore проверяет manifest/hash/integrity, мигрирует старую schema только вперёд и сохраняет прежний target как `.pre-restore-<timestamp>`. Наличие WAL/SHM sidecar блокирует replace: сначала добейся чистой остановки, не удаляй sidecar вручную.

## Retention и flood control

`retention.payloadMaxAgeDays` по умолчанию равен 30. После срока bridge затирает message/turn/interaction/delivery payloads и error text, удаляет private attachment/media files внутри их spool roots, но сохраняет update ids, operation keys, states и delivery proof для дедупликации. SQLite работает с `secure_delete=ON`. Shared outbound file не удаляется, пока на него ссылается свежий job.

Завершённые черновики продуктовых решений очищаются тем же retention job:
стираются JSON карточки и тексты ошибок, но остаются version/token state,
acceptance idempotency key, ID принятого решения и Git proof. Перед первым
включением `productDecisions` сделай online backup, затем после restart проверь
`/ready`. Контракт конфигурации и retry Git push описаны в
[product-decisions.md](product-decisions.md).

Telegram send path использует per-chat FIFO bucket, общий bot bucket и bounded retry по `429 retry_after`. Значения лежат в `telegram.rateLimit`; retry_after и число попыток имеют жёсткие потолки. Non-429 timeout не превращается во внутренний бесконечный retry. Replayed updates схлопываются по `(bot_id, update_id)`, а первый terminal callback response выигрывает транзакционно.

Закреплённый status anchor — best-effort telemetry, а не часть outbox. Во время
turn он обновляется не чаще раза в минуту; progress events не создают отдельные
Telegram edits. `429` и временная сетевая ошибка никогда не превращаются в
fallback `sendMessage`: новый anchor создаётся только когда Telegram явно
подтвердил, что старое сообщение удалено или больше не редактируется.

## Chaos, soak и release gate

Быстрый локальный gate:

```bash
bun run typecheck
bun test
bun run codex:schema:check
bun run soak:codex:smoke
bun audit --audit-level=high
bun run licenses:codex
```

72-часовой kernel soak:

```bash
bun run soak:codex
```

Harness на каждом цикле доказывает inbox/outbox completion, повторяет callbacks, делает `quick_check` и каждые 100 операций закрывает/открывает SQLite. Для Gate M5 дополнительно нужен живой canary с настоящими Codex App Server и Telegram: длинный turn, 429, timeout, рестарт процесса и проверка problem center.

Release artifacts собираются только из clean `HEAD`:

```bash
bun run release:codex
cd dist
sha256sum -c dashi-codex-bridge-<version>.sha256
```

Результат: reproducible tar.gz, CycloneDX 1.6 SBOM и SHA-256 file. В tar входят LICENSE, commit/schema metadata и lockfile. Подпись выполняется в release CI или оператором поверх checksum/artifact (`cosign sign-blob` либо detached GPG signature); private signing key bridge не читает.

## Incident flow

1. Не запускай второй poller на том же token.
2. Сними `/ready`, последние safe structured logs и `/failed`/`/ambiguous`; не копируй production SQLite в публичный issue.
3. При `AMBIGUOUS` никогда не делай слепой retry: проверь Telegram и используй `/resolved` либо `/archive`.
4. Перед repair создай backup; перед restore останови unit.
5. После изменения прогони doctor, schema gate и реальное тестовое сообщение.
