# ADR-0001: Hybrid runtime boundaries

- Status: accepted
- Date: 2026-08-29

## Context

Dashi is a Claude Code channel plugin whose Telegram product surface is useful
for the Codex bridge. Codex exposes a bidirectional App Server protocol rather
than Claude's inbound channel capability. Telemax has stronger durable delivery
semantics, but is a separate Python codebase with no shared Git history.

Trying to hide Telegram polling, Codex process ownership, and durable delivery
inside a Codex plugin would mix deployment packaging with runtime ownership.
It would also make provider-specific events leak into every Telegram handler.

## Decision

The main product is an independent TypeScript/Bun bridge service.

The service is split by these boundaries:

- `TelegramGateway`: Telegram update ingestion and API calls;
- `InboxRepository` / `OutboxRepository`: durable transport state;
- `SessionCoordinator`: chat/project/thread/turn policy;
- `AgentBackend`: provider-neutral agent lifecycle;
- `CodexAppServerBackend`: Codex-specific protocol mapping.

The initial Codex transport is implemented under `plugin/src/codex/` without
wiring it into the existing Claude composition root. We first prove protocol
and restart behaviour with a standalone harness.

An optional Codex plugin may later package install/doctor/skills/docs. It does
not own polling, queues, SQLite, or service supervision.

## Consequences

- Codex can reach feature parity without destabilising the existing channel.
- A later Claude backend can reuse the same delivery and Telegram paths.
- The first milestone contains some temporary parallel composition code.
- Provider-specific capabilities require explicit mapping at `AgentBackend`.
