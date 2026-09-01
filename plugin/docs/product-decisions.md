# Product decisions R1

`codex-tg-wire` can discuss and accept product decisions without adding a second
bot or a second editable source of truth. The bridge keeps drafts and delivery
state in SQLite; only an explicitly accepted card is written to the canonical
STVOR Git repository.

## Owner flow

Start a message with one of the modes:

- `Исследуем:` — collect evidence and compare options before recommending a card;
- `Фиксируем:` — turn an existing owner decision into an exact card;
- `Меняем:` — replace an accepted card while preserving its history.

Before acceptance, the Codex turn is forced to `read-only` with approvals denied.
The agent starts with one complete interpretation, asks at most one material
question at a time and must not invent rationale or evidence.

When the brief is complete, the bridge validates a strict schema and renders the
human-readable card itself. Every version has a new random callback token and the
SHA-256 of the exact rendered brief. The owner can:

- accept and record the displayed version;
- close it and send an edit;
- request more data;
- reject it.

Text acceptance is also available as `Принимаю vN.`. An old token or version
cannot accept a newer card.

## Durable acceptance

The acceptance record preserves the original Telegram update/message, the
acceptance update/message/callback query, the Codex thread/turn, actor, timestamp,
brief version and SHA-256. The Git writer:

1. takes a repository lock and refuses a dirty canonical worktree;
2. validates the replacement chain for `Меняем`;
3. allocates the next `PD-CAP-####` ID;
4. writes the card and regenerates the Capacity index;
5. runs the product-decision validator and `git diff --check`;
6. creates one scoped commit and, when configured, pushes it.

Repeated callbacks return the same decision. If commit succeeds and push fails,
the next acceptance attempt finds that exact card and retries only the push. The
first acceptance provenance is retained. Acceptance never changes application
code, runtime configuration or a live service.

R1 intentionally supports only the `capacity` domain. Product Home and broader
domain coverage are later product milestones.

## Configuration

The feature is off by default:

```json
{
  "productDecisions": {
    "enabled": true,
    "repositoryPath": "/absolute/path/to/vpn-infra",
    "remote": "origin",
    "push": true
  }
}
```

`repositoryPath` is resolved relative to the config file when not absolute and
must be a Git worktree. `remote` defaults to `origin`; `push: false` keeps the
scoped commit local. The bot owner allowlist remains the authorization boundary.

Draft payloads follow the normal retention window after a flow reaches a terminal
state. Idempotency keys, states, accepted decision ID and Git proof remain after
payload scrubbing.

## Operator checks

Run the focused gate before activation:

```bash
bun run typecheck
bun test tests/bridge/product-decision-r1.test.ts \
  tests/bridge/service-config.test.ts \
  tests/telegram/durable-text-gateway.test.ts \
  tests/durable/retention.test.ts
```

Create an online SQLite backup before the first start that applies the decision
schema migration. After restart, require the normal `/ready` health check to pass.
