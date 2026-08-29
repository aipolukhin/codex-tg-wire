# Security model and delivery guarantees

## Supported trust model

Version `1.0` is a private, single-owner bridge. Telegram user and chat allowlists are mandatory and deny by default. Public bots, untrusted multi-user groups, remote App Server, shared fleet routing and hostile host administrators are outside the security model.

Telegram text, filenames, media, callback payloads, Codex output and project contents are untrusted data. The Telegram bot token, optional voice key, Codex authentication cache, SQLite payloads and attachment/media spools are secrets or private data.

## Boundaries

- Bot and voice credentials come from environment/file credentials; production templates use systemd `LoadCredential` or private host bind files for Docker.
- Codex authentication lives under a private persistent `CODEX_HOME`. `auth.json` must be treated like a password.
- A random deep-link nonce is the one-time owner-claim credential. Until it is claimed, the bootstrap ignores every other update. The state and nonce are mode `0600`; after a matching private `/start`, only that user/chat may choose the host project and execution profile. Docker can only confirm the single host directory already mounted by the installer. Production Telegram commands cannot submit a new arbitrary `cwd`, writable root or network policy.
- The personal onboarding presents `YOLO` (`approvalPolicy=never`, `danger-full-access`) as the recommended profile so an allowlisted owner can work without per-command prompts, but still requires an explicit choice. This removes the writable-root, network and approval boundaries: compromise of the Telegram account or bot token becomes code execution with all rights of the service's Linux user. Choosing `Safe` or passing `./install.sh --profile safe` restores `on-request` + `workspace-write`. The [official Codex CLI reference](https://learn.chatgpt.com/codex/developer-commands?surface=cli) recommends YOLO only inside an externally hardened environment; the user installer does not pretend that an allowlist is a host sandbox.
- The container itself needs outbound access to Telegram and OpenAI. `projects[].networkAccess=false` applies to the Codex turn sandbox; it is not a container-wide firewall.
- All Telegram mutations use the durable outbox boundary. Tests reject direct production imports that bypass it.
- Health and normal incident logs omit prompts, message bodies, tokens, ids, filesystem paths and transport error details.

## Delivery semantics

The bridge does not claim end-to-end exactly-once delivery because Telegram cannot prove whether a timed-out mutation reached the server.

| Boundary | Guarantee |
|---|---|
| Telegram update → SQLite | The raw update is committed before polling offset advance. Replayed `(bot_id, update_id)` values deduplicate. |
| SQLite update → Codex turn | Operation keys and one-active-turn-per-thread ordering prevent ordinary duplicate starts. Lost or active backend state becomes `UNKNOWN`; no replacement turn starts automatically. |
| Outbox before external call | Expired leases may retry with bounded backoff while `send_started_at` is absent. |
| Outbox after external call begins | A result without remote proof becomes `AMBIGUOUS` and never auto-retries. The owner must use `/resolved` or `/archive`. |
| Confirmed Telegram delivery | `DELIVERED` requires a saved Telegram message id or equivalent remote id. Ordered chunks wait for predecessor proof. |
| Inline decisions | The first valid, unexpired owner response wins transactionally. Replay or a callback from an old App Server connection cannot grant rights. |
| Process restart | Durable inbox/outbox, settings, thread bindings and queued turns survive. Active turns are inspected conservatively; uncertainty is exposed instead of hidden. |

The practical contract is: every acknowledged update remains represented durably; every outbound job is either proven delivered or visible in a terminal/problem state; ambiguous sends are never duplicated automatically.

## Data handling

- SQLite uses WAL, foreign keys and `secure_delete=ON`.
- Default payload retention is 30 days. Scrub removes message/turn/interaction/error bodies while preserving ids, state transitions, idempotency keys and delivery proofs.
- Inbound and outbound media are private, content-addressed and checked for regular-file status, allowed root, size, MIME/magic and SHA-256 before reuse.
- Telegram filenames never become local paths.
- Secret-like user-input and MCP form schemas are rejected before a Telegram prompt is created.
- Backups contain private conversations and operational metadata; backup files and manifests are mode `0600` and must not be attached to public issues.

## Host and container responsibilities

The operator must keep the OS, Docker daemon, Bun and the pinned Codex binary trustworthy; restrict access to the service account, project, config, state, backup and `CODEX_HOME`; rotate leaked credentials; and maintain project-level version control/backups. A compromised root user, Docker daemon or writable release directory can replace the bridge and is out of scope.

The simple user unit runs without root as the current user, applies
`NoNewPrivileges` and a private `/tmp`, but intentionally leaves that user's home
visible so Codex can work on normal projects. In YOLO, every file and process
available to that user is therefore in scope. The advanced system-wide unit
makes release/system paths read-only and hides home directories; the Docker
profile runs non-root with a read-only root filesystem, no Linux capabilities
and `no-new-privileges`. Those are the appropriate choices when host isolation
matters more than one-command onboarding.

## Supply chain and release status

Releases include a frozen Bun lockfile, pinned Codex/schema manifest, CycloneDX 1.6 SBOM and SHA-256 checksums. Dependency vulnerability and license gates run before release. Checksums detect corruption; publisher authentication requires a release signature supplied outside the archive.

M6 implementation and automated acceptance do not substitute for the M5 72-hour live Telegram/Codex canary. Until that canary passes, the package is a hardened pre-release rather than a stable public `v1.0`.
