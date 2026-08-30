# ADR-0003: Durable delivery semantics

- Status: accepted
- Date: 2026-08-29

## Context

A crash can occur after Telegram accepts a mutation but before the bridge saves
the response. Automatically repeating that call can duplicate a message. A
crash before any send attempt is different: retry is safe.

File dead letters and error classification alone do not preserve enough state
to distinguish those cases after a process restart.

## Decision

The hybrid runtime will use a SQLite inbox and outbox with leases.

- Persist each inbound update under unique `(bot_id, update_id)` before
  advancing the polling offset.
- Route every user-content delivery and interaction mutation through a
  delivery job.
- Record `send_started_at` immediately before the external API call.
- An expired lease without `send_started_at` returns to retry.
- An expired lease with `send_started_at` becomes `AMBIGUOUS`.
- Never automatically retry `AMBIGUOUS` jobs.
- Mark a job `DELIVERED` only with a stored remote message id or equivalent
  proof returned by Telegram.
- Put answers, media, albums, requested edits/deletes and durable interactions
  under the same state machine and administrative problem center.
- Keep replaceable native presence outside delivery correctness: typing, the
  idempotent 👀 accepted receipt and the single pinned status are best-effort,
  rate-limited calls. Their failures are swallowed and never retry a Codex
  turn. The status anchor id/text is persisted only to enable edit-in-place and
  stale-anchor replacement.
- Add structural tests that forbid Telegram API imports outside the sender
  boundary.

## Consequences

- The system chooses explicit operator review over silent duplicate delivery.
- Exactly-once delivery is not claimed when the remote API outcome is unknown.
- SQLite migrations and fault-injection tests are required before production
  Telegram wiring.
