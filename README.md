# codex-tg-wire

> A durable, self-hosted Telegram bridge for Codex App Server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Runtime: Bun 1.4](https://img.shields.io/badge/runtime-Bun_1.4-f9f1e1.svg)](https://bun.sh)
[![Codex CLI: 0.149.1](https://img.shields.io/badge/Codex_CLI-0.149.1-111827.svg)](plugin/docs/codex-compatibility.md)
[![Status: pre-release](https://img.shields.io/badge/status-hardened_pre--release-f59e0b.svg)](#release-status)

English (this page) · [Русская версия](README.ru.md)

codex-tg-wire lets an allowlisted owner operate persistent Codex threads from a
private Telegram chat. It is an always-on service, not a prompt wrapper and not
a Codex plugin: Telegram updates, turns, interactive requests and outbound
delivery are coordinated through SQLite/WAL before external state advances.

```text
Telegram Bot API
        │
        ▼
 durable inbox ──► session coordinator ──► Codex App Server
        │                                      │
        │                                      ▼
        └──── problem center ◄── durable outbox
```

## Why codex-tg-wire

A basic bridge can call Codex and forward its answer. The hard part begins when
the process dies between accepting an update, starting a turn and receiving a
Telegram response. codex-tg-wire makes those boundaries explicit:

| Boundary | Guarantee |
|---|---|
| Telegram ingress | The raw update is committed before the polling offset advances; `(bot_id, update_id)` deduplicates retries. |
| Codex turns | One active turn per thread, restart-safe FIFO queue, explicit steer/interrupt and durable thread bindings. |
| Telegram egress | Every send/edit/delete/reaction/media operation goes through one transactional outbox with leases and bounded retry. |
| Unknown send result | Once `send_started` is recorded, an uncertain result becomes `AMBIGUOUS` and is never retried automatically. |
| Restart recovery | Stored turns are reconciled with `thread/read`; uncertainty becomes visible `UNKNOWN`, never a hidden replacement turn. |
| Operator recovery | `/failed` and `/ambiguous` expose safe metadata; retry, resolve and archive actions are idempotent and audited. |

codex-tg-wire does not claim impossible end-to-end exactly-once delivery. It makes
uncertainty visible and gives the owner a safe way to resolve it without
silently duplicating work.

## Features

- persistent Codex threads: `/threads`, `/switch`, `/resume`, `/archive`, `/new`;
- turn controls: `/stop`, `/steer`, restart-safe FIFO queue;
- per-project `/model`, `/effort`, `/sandbox`, `/approval` and allowlisted `/cwd`;
- durable command/file/permission approvals and user-input questions;
- MCP elicitation with typed forms and credential-free HTTPS flows;
- rich Telegram HTML, ordered chunks, HUD, progress and heartbeat;
- verified inbound and outbound files, images, audio, media groups and atomic albums;
- optional Groq voice transcription; original audio remains available to Codex;
- deny-by-default user/chat allowlists, secret redaction and fail-closed policy gates;
- systemd and non-root read-only Docker packaging;
- doctor, health/readiness/watchdog, backup/restore, retention, SBOM and atomic upgrade/rollback.

## Quick start from source

Requirements: Linux, Bun `1.4.x`, an authenticated Codex CLI `0.149.1`, a
Telegram bot token, numeric owner user/chat IDs and an absolute project path.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire/plugin
bun install --frozen-lockfile
cp bridge.config.example.json bridge.config.json
install -m 0600 /dev/null telegram-token
```

Edit `bridge.config.json`, place only the bot token in `telegram-token`, then:

```bash
export DASHI_CODEX_BRIDGE_CONFIG="$PWD/bridge.config.json"
export DASHI_TELEGRAM_BOT_TOKEN_FILE="$PWD/telegram-token"
bun run doctor:codex --online
bun run start:codex
```

The `DASHI_*` environment prefix is retained temporarily for configuration
compatibility with the imported baseline. It does not select or start the
legacy Claude runtime. Production users should follow the hardened
[installation guide](plugin/docs/codex-installation.md) instead of running the
source checkout as a daemon.

## Documentation

| Guide | Purpose |
|---|---|
| [Installation](plugin/docs/codex-installation.md) | systemd and Docker Compose deployment, Codex login and first restart acceptance |
| [Production runbook](plugin/docs/codex-production.md) | readiness, backup, restore, retention, rate limits and live soak |
| [Upgrade and rollback](plugin/docs/codex-upgrade.md) | verified artifacts, staged activation and database-safe rollback |
| [Security contract](plugin/docs/codex-security.md) | trust boundaries, delivery guarantees, secrets and incident handling |
| [Compatibility matrix](plugin/docs/codex-compatibility.md) | exact Codex/Bun/App Server support policy |
| [Implementation roadmap](ROADMAP.md) | completed v1 milestones and post-v1 direction |
| [Provenance](docs/provenance.md) | what was kept from Dashi, informed by Telemax/other bridges, omitted or written anew |

Useful commands from `plugin/`:

```bash
bun run doctor:codex --online
bun run backup:codex -- /safe/path/bridge.sqlite3
bun run acceptance:codex
bun run codex:schema:check
bun run release:codex
```

## Release status

The v1 implementation and hermetic artifact install → restart → resume gate are
complete. The bridge remains a **hardened pre-release** until a clean operator
install and a real 72-hour Telegram/Codex canary complete. The supported v1
surface is private, allowlisted chats over a local stdio App Server. Groups,
topics, fleet orchestration and remote App Server transport are post-v1 work.

## Origins and attribution

codex-tg-wire began from the current
[Dashi](https://github.com/qwwiwi/dashi-plugin-claude-code) TypeScript/Bun and
Telegram UX baseline. It keeps the useful formatting, media and safety ideas,
while replacing the Claude/tmux runtime path with a native Codex App Server
backend and a SQLite durability boundary.

The delivery state model was informed by
[Telemax](https://github.com/aipolukhin/telemax): leases, `send_started`,
`AMBIGUOUS`, problem-center actions and fault-injection discipline were ported
semantically to TypeScript; the Python implementation was not copied.

The repository retains the upstream Git history and Apache-2.0 attribution.
See [NOTICE](NOTICE) and the detailed [provenance map](docs/provenance.md).
codex-tg-wire is an independent, unofficial project and is not
affiliated with OpenAI or Telegram.

## Development

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test
```

The supported production entry point is `bun run start:codex`. Some inherited
Claude channel modules remain in the source tree while shared Telegram code is
being extracted; they are not the product described by this README.
