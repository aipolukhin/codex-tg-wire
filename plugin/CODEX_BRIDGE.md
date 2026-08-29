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

Personal alpha поддерживает обычный текст и команды `/start`, `/new`, `/status`, `/stop`. `SIGINT`/`SIGTERM` прекращает polling и новые lease, дожидается уже взятой работы, затем закрывает App Server и SQLite.

## Граница безопасности

- allowlist пользователей и чатов обязательны и работают deny-by-default;
- bot token не хранится в конфиге или SQLite;
- исходящий текст проходит secret redaction;
- update сохраняется до продвижения Telegram offset;
- доставка после `send_started` с неизвестным результатом становится `AMBIGUOUS` и автоматически не повторяется.

Это personal alpha: approvals, user-input cards, media и problem center ещё идут следующими срезами roadmap.
