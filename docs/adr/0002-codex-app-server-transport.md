# ADR-0002: Codex App Server transport and compatibility

- Status: accepted
- Date: 2026-08-29

## Context

Codex App Server supports bidirectional JSON-RPC-like messages over JSONL
stdio. Its CLI can generate TypeScript bindings that match the installed Codex
version. WebSocket transport is currently experimental and unsupported for
production workloads.

The bridge needs streamed notifications and server-initiated requests for
approvals and user input. A one-shot `codex exec` subprocess cannot provide the
same lifecycle reliably.

## Decision

- Use one supervised local `codex app-server --listen stdio://` subprocess.
- Perform `initialize` and wait for its response before sending `initialized`.
- Keep request ids and pending promises inside an isolated client.
- Dispatch notifications and server-initiated requests through different APIs.
- Reject all pending requests when the subprocess closes.
- Pin a tested Codex CLI version in
  `plugin/codex-app-server.compatibility.json`.
- Generate stable TypeScript bindings with that CLI and compare a deterministic
  tree fingerprint using `bun run codex:schema:check`.
- Keep a narrow handwritten application-facing type layer. Generated bindings
  remain the compatibility oracle rather than becoming domain types.
- Do not enable `experimentalApi` in the initial client.
- Treat a newly returned thread id as provisional until its first turn creates
  a rollout. With Codex CLI `0.149.1`, `thread/start` without a turn does not
  survive an App Server restart: `thread/resume` returns `no rollout found`.

## Consequences

- App Server upgrades are deliberate and schema drift is visible.
- The bridge does not depend on experimental remote transport.
- The narrow types must be reviewed whenever the compatibility fingerprint
  changes.
- Process supervision and recovery policy remain work for the next milestone.
- Session storage must not present a provisional thread as restart-durable.
