# Compatibility matrix

Standalone bridge version is independent from the legacy Claude plugin package version. The canonical machine-readable source is [`codex-app-server.compatibility.json`](../codex-app-server.compatibility.json); release names and App Server client identity use `bridgeVersion` from that file.

| Bridge | Codex CLI | Bun | Transport | Status |
|---|---|---|---|---|
| `1.0.x` | `0.149.1` | `1.4.x` | local `stdio` | supported |

Pinned stable App Server schema SHA-256: `710487c9ba5a251908766a1d50e27587865e67cf85f0a6516243c98895b8f4a1`.

Compatibility is exact for Codex CLI because App Server types and recovery semantics are checked against a deterministic schema fingerprint. Patch/minor Codex upgrades are not assumed compatible: update the pin, regenerate schemas, review protocol drift, run `codex:schema:check`, the full test suite and the restart acceptance gate.

Bun is pinned to the lockfile generation line. A newer Bun may work, but release and Docker builds use the declared exact version. Remote App Server and WebSocket transport are outside the `1.0` support matrix.

The bridge refuses to start the production rollout when `doctor:codex` sees a different Codex CLI version. Downgrading the bridge never downgrades or rewrites SQLite; use a backup created before the upgrade and the documented offline restore flow when a database rollback is required.
