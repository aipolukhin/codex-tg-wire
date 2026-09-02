# Changelog

Notable changes to codex-tg-wire are documented here. The standalone bridge
version is defined by `plugin/codex-app-server.compatibility.json`; the inherited
Claude package version is not the codex-tg-wire release version.

## [Unreleased]

### Product decisions

- Product-decision capture now follows conversational intent instead of requiring
  a prefix, supports Brand cards with `PD-BRD-####` IDs, and presents the exact
  version through the `Принимаю vN` callback button.
- Explicit implementation intent now exits an open decision discussion in the
  same Telegram turn, rejected or malformed cards no longer capture later
  messages, and Git failures are redacted from owner-facing replies.

### Installer

- Fixed the host and Docker console frames so every row has the same width.
- The default host installer now bootstraps the repository-pinned Bun release
  into `~/.bun` through Bun's official installer when it is missing or differs.
- First install is now truly bot-first: the console accepts only the BotFather
  token, starts a resumable bootstrap service, and hands off through a
  nonce-bound deep link to the user's own bot.
- The running bot claims owner IDs, creates/selects the host project, chooses
  YOLO or Safe, atomically writes production config, and restarts into the full
  bridge. Numeric IDs remain available only for automation/preseed.

### Telegram control plane (M6.5)

- Added native account status, device-code login, rate limits, token usage and
  bridge/Codex version commands.
- Added cwd-filtered native Codex session discovery, attach/local handback,
  rename, unarchive, fork and compact operations.
- Added inline project settings, persisted busy-turn choices and exact
  reply-to-thread routing.
- Added durable turn-diff capture, safe project-file inspection, outbound file
  delivery and native inline review targets.
- Added an optional restart-safe Guided Plan gate with revise, confirm, execute
  and cancel actions.
- Kept live task cards active across bounded `serverOverloaded` recovery turns,
  retargeted cancellation to the replacement turn and localized task controls.

### Delivery and recovery

- Forwarding a Telegram post with a preceding comment now produces one Codex
  turn: the short-lived comment candidate is durably coalesced with the
  forwarded message or album and otherwise resumes normal processing.
- An unexpected Codex App Server exit now fails the bridge process so systemd
  restarts the complete runtime. Startup recovery also requeues source updates
  stranded behind turns that never reached App Server dispatch.
- Exhausted infrastructure retries no longer acknowledge their source update
  after merely enqueueing an error notice; the failed source remains available
  for recovery.
- A temporary model-capacity failure now continues safely in the same durable
  thread after checking existing state, instead of replaying the original
  request or immediately reporting a terminal failure.
- A turn proven failed or interrupted during bridge startup now automatically
  resumes the same logical Telegram operation in its existing Codex thread.
  Every replacement backend turn has a durable unique key and recovery ledger;
  genuinely uncertain `UNKNOWN` work remains fail-closed to prevent duplicates.

### Required before stable v1.0

- Complete a clean operator installation from a published artifact.
- Complete the 72-hour live Telegram/Codex canary.
- Publish signed release artifacts and checksums.

## [1.0.0-pre] — 2026-08-29

### Codex runtime

- Added a supervised JSONL/stdio Codex App Server client with exact schema
  compatibility gating.
- Added persistent threads, FIFO turns, steer/interrupt, model/effort and
  execution-policy controls.
- Added durable approvals, user-input questions and MCP elicitation.

### Delivery and recovery

- Added SQLite/WAL inbox/outbox, leases, bounded retry, TTL, deduplication and
  crash recovery.
- Added `send_started`, `AMBIGUOUS`, `UNKNOWN` and an audited problem center.
- Added restart reconciliation through `thread/read` without replacement turns.
- Added verified media/file spools, atomic albums and optional voice
  transcription.

### Operations

- Added doctor, health/readiness/watchdog, backup/restore, retention and soak
  tooling.
- Added hardened systemd and non-root read-only Docker packaging.
- Added reproducible release archives, CycloneDX SBOM, checksum verification
  and atomic upgrade/rollback.

## Provenance

The initial Git history and shared Telegram primitives come from
[Dashi](https://github.com/qwwiwi/dashi-plugin-claude-code). Durable delivery
semantics were ported from [Telemax](https://github.com/aipolukhin/telemax).
See [docs/provenance.md](docs/provenance.md) and [NOTICE](NOTICE).
