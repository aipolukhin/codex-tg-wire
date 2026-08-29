# Security policy

codex-tg-wire handles Telegram content, local project files, Codex credentials
and an agent capable of executing tools. Treat a bridge compromise as a host
security incident.

## Reporting

Use the repository's private GitHub Security Advisory reporting flow. Do not
open a public issue containing bot tokens, OpenAI credentials, Telegram IDs,
message bodies, local paths, database contents or diagnostic archives.

Include the affected commit/version, deployment mode, a minimal reproduction
without secrets and the security boundary that failed. If a secret may have
been exposed, revoke or rotate it before collecting additional diagnostics.

## Supported line

Until v1.0 completes its live canary, only the current `main` branch receives
security fixes. The supported threat model is an allowlisted private owner chat,
a trusted host and a local stdio Codex App Server. Public bots, hostile host
administrators, untrusted groups and remote App Server transport are outside
the current security model.

The detailed trust and delivery contract is in
[plugin/docs/codex-security.md](plugin/docs/codex-security.md).
