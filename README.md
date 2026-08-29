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

There is no tmux or terminal-mirroring layer. Telegram is the UI, bridge SQLite
owns delivery/control recovery, and Codex's own local `CODEX_HOME` store owns
the complete resumable thread history. The App Server process is disposable:
after restart the bridge reconnects with `thread/read`/`thread/resume`; model
requests still go to OpenAI, but Telegram and bridge SQLite are not treated as
a second full Codex transcript.

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
- native Codex session handoff: `/sessions`, `/attach`, `/handback`, `/rename`,
  `/unarchive`, `/fork`, `/compact`;
- turn controls: `/stop`, `/steer`, restart-safe FIFO queue;
- one-button `/settings` for per-project model, effort, sandbox, approval,
  allowlisted cwd and the optional Guided Plan gate;
- account controls: `/auth`, device-code `/login`, `/limits`, `/usage`, `/version`;
- inspection tools: latest `/diff`, allowlisted `/file` and native inline `/review`;
- reply-to-result routing, explicit busy-turn choices and a durable plan → revise →
  confirm → execute flow;
- durable command/file/permission approvals and user-input questions;
- MCP elicitation with typed forms and credential-free HTTPS flows;
- rich Telegram HTML, ordered chunks, HUD, progress and heartbeat;
- verified inbound and outbound files, images, audio, media groups and atomic albums;
- optional Groq voice transcription; original audio remains available to Codex;
- deny-by-default user/chat allowlists, secret redaction and fail-closed policy gates;
- systemd and non-root read-only Docker packaging;
- doctor, health/readiness/watchdog, backup/restore, retention, SBOM and atomic upgrade/rollback.

### Telegram control plane

| Area | Commands and behavior |
|---|---|
| Account | `/auth`, `/login`, `/limits`, `/usage`, `/version` use native App Server account methods; the bot never asks for a password or token. |
| Sessions | `/sessions [archived] [search]`, `/attach <id>`, `/handback`, `/rename`, `/unarchive`, `/fork`, `/compact` operate on Codex's local thread store and remain restricted to the selected project's cwd. |
| Settings | `/settings` renders inline controls for model, effort, sandbox, approval, project and Guided Plan. Existing text commands remain available. |
| Busy turn | A second prompt offers steer, durable queue, stop-and-replace or cancel instead of guessing intent. The selected action is persisted and idempotent. |
| Inspection | `/diff [path]`, `/file [--all] <path>` and `/review [uncommitted\|base <branch>\|commit <sha>\|custom <text>]`. File paths are resolved beneath the configured project root. |
| Guided Plan | `/plan on` drafts under forced `read-only` + `approvalPolicy=never`, then waits for Telegram confirmation. The owner can revise, execute or cancel; state survives restart. |
| Reply routing | Replying to a delivered Codex result continues the exact thread that produced that Telegram message, even after switching sessions. |

## Install

Requirements: Linux with `systemd --user`, Bun `1.4.x`, an authenticated Codex
login, a Telegram bot token, numeric owner user/chat IDs and an absolute project
path. The compatible Codex CLI is installed locally by the bridge; your existing
`~/.codex` login is reused.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

The phone-friendly console onboarding asks for the project, execution profile,
Telegram ids and token, runs doctor, then installs and starts
`codex-tg-wire.service` for the current user. No `sudo`, `/srv`, dedicated Unix
account, Docker or second Codex login is involved.

The default profile is **YOLO**: `approvalPolicy=never` and
`sandbox=danger-full-access`. It avoids remote confirmation for every command,
but a compromised Telegram account or bot token can then act with all rights of
your Linux user. Use only a private owner bot and the generated user/chat
allowlist. Choose `Safe` in onboarding or run `./install.sh --profile safe` for
`on-request` + `workspace-write`.

The `DASHI_*` environment prefix is retained temporarily for configuration
compatibility with the imported baseline. It does not select or start the
legacy Claude runtime. See the [installation guide](plugin/docs/codex-installation.md)
for non-interactive flags, service commands and advanced system-wide/Docker
deployment.

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
semantically to TypeScript; its narrow, resumable console-onboarding principles
also shaped `install.sh`. The Python implementation was not copied.

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
