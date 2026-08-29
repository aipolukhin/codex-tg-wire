# Installation: standalone Telegram → Codex bridge

This guide installs bridge `1.0.x` as a single-owner daemon. It does not use the legacy Claude channel runtime. Supported versions are pinned in [the compatibility matrix](codex-compatibility.md).

## Recommended user installation

For a personal Linux host, clone the repository and run the onboarding:

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

The installer is resumable and safe to run again. When Bun is absent or has a
different version, it installs the version pinned by `plugin/package.json` into
`~/.bun` through Bun's official installer, without `sudo`. It then installs
frozen Bun dependencies and the pinned Codex CLI locally, reuses the current
user's `CODEX_HOME` (normally `~/.codex`), and stores the bot token separately
with mode `0600`. It starts a bootstrap service and prints a nonce-protected
deep link. The matching private `/start` update supplies the owner user/chat
IDs; the running bot then creates/selects the project and asks for YOLO or Safe.
It atomically writes the production allowlist/config and restarts itself into
the full bridge. The service lives at
`~/.config/systemd/user/codex-tg-wire.service`; SQLite and media state default to
`~/.local/share/codex-tg-wire`. No root privileges or service account are
required, and the terminal is no longer needed after the token is entered.

After the bootstrap steps, use **Continue in the bot**. If local Codex auth
exists, the bridge uses it immediately. Otherwise **Connect Codex** opens
official device login and **Check login** verifies it. The same onboarding card
can open Groq API Keys for optional voice transcription. Once this card is
complete, normal setup and operation require no terminal.

The execution choice is explicit in onboarding:

| Profile | Codex settings | Intended use |
|---|---|---|
| `YOLO` (recommended) | `approvalPolicy=never`, `danger-full-access` | A private, single-owner bot where uninterrupted remote work matters more than host isolation. Telegram compromise becomes full access as that Linux user. |
| `Safe` | `approvalPolicy=on-request`, `workspace-write` | Shared or higher-risk hosts where command approvals and a workspace boundary are desired. |

For a scripted Safe install, pass all non-secret values on the command line and
the secret by file:

```bash
./install.sh \
  --project /home/me/code/project \
  --telegram-user 123456789 \
  --telegram-chat 123456789 \
  --token-file /safe/path/telegram-token \
  --profile safe
```

Useful lifecycle commands:

```bash
systemctl --user status codex-tg-wire.service
journalctl --user -u codex-tg-wire.service -f
systemctl --user restart codex-tg-wire.service
./install.sh --uninstall  # removes the service, preserves config/state
```

On a headless server, an administrator may enable user lingering if the service
must remain alive after logout. The advanced installations below remain useful
for multi-user machines, immutable releases or container policy; they are no
longer the default onboarding path.

## Prerequisites

- Linux with systemd 252+ or Docker Engine with Compose;
- `curl` and `unzip` for the recommended host installer (it installs pinned Bun itself);
- Bun `1.4.x` for advanced/manual host installations;
- Codex CLI `0.149.1` for the advanced system-wide host installation (the user installer vendors it locally);
- a private Telegram bot token (interactive onboarding discovers owner IDs itself);
- a writable local project directory, or permission to create `~/codex-workspace`;
- a Codex account that can be authenticated from the bot when local auth is absent.

Official Codex setup supports interactive login, device-code login on headless hosts, and API-key login through stdin. Never place the OpenAI credential, Telegram token, or `CODEX_HOME/auth.json` in this repository. See the [official Codex CLI guide](https://developers.openai.com/codex/cli/) and [official authentication guide](https://learn.chatgpt.com/codex/auth).

## systemd installation (advanced, system-wide)

Download the release tar, external CycloneDX SBOM and checksum file into a staging directory. Verify any detached release signature first when one is published, then verify the files:

```bash
sha256sum -c dashi-codex-bridge-1.0.0.sha256
tar -xzf dashi-codex-bridge-1.0.0.tar.gz
cd dashi-codex-bridge-1.0.0
```

Create a dedicated account and immutable release root. Replace `/srv/my-project` with the project Codex may access:

```bash
sudo useradd --system --home-dir /var/lib/dashi-codex-bridge --no-create-home \
  --shell /usr/sbin/nologin dashi-codex
sudo install -d -o dashi-codex -g dashi-codex -m 0700 \
  /etc/dashi-codex-bridge /var/lib/dashi-codex-bridge
sudo chown -R dashi-codex:dashi-codex /srv/my-project
```

Install the verified archive. The manager verifies the checksum again, rejects unsafe tar entries, installs frozen production dependencies into a versioned directory and atomically creates `/opt/dashi-codex-bridge/current`:

```bash
sudo bun run manage:codex -- install \
  --artifact ../dashi-codex-bridge-1.0.0.tar.gz \
  --checksums ../dashi-codex-bridge-1.0.0.sha256 \
  --prefix /opt/dashi-codex-bridge \
  --owner dashi-codex
```

Generate a deny-by-default configuration. The command refuses to overwrite an existing installation and creates an empty private `telegram-token` file:

```bash
sudo -u dashi-codex bun /opt/dashi-codex-bridge/current/scripts/codex-bridge-init.ts \
  --config-dir /etc/dashi-codex-bridge \
  --state-dir /var/lib/dashi-codex-bridge \
  --project /srv/my-project \
  --telegram-user 123456789 \
  --telegram-chat 123456789 \
  --profile safe
sudoedit /etc/dashi-codex-bridge/telegram-token
```

For a headless host, authenticate the service account with device code:

```bash
sudo -u dashi-codex env \
  HOME=/var/lib/dashi-codex-bridge \
  CODEX_HOME=/var/lib/dashi-codex-bridge/codex-home \
  codex login --device-auth
```

Run preflight as the service account. `CREDENTIALS_DIRECTORY` models the same credential source systemd will provide:

```bash
sudo -u dashi-codex env \
  HOME=/var/lib/dashi-codex-bridge \
  CODEX_HOME=/var/lib/dashi-codex-bridge/codex-home \
  CREDENTIALS_DIRECTORY=/etc/dashi-codex-bridge \
  DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
  bun --cwd /opt/dashi-codex-bridge/current run doctor:codex --online
```

Install and start the validated unit:

```bash
sudo install -m 0644 \
  /opt/dashi-codex-bridge/current/deploy/systemd/dashi-codex-bridge.service \
  /etc/systemd/system/dashi-codex-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now dashi-codex-bridge.service
systemctl status dashi-codex-bridge.service
curl --fail http://127.0.0.1:8787/ready
```

The unit uses `LoadCredential`, a private state directory, systemd watchdog and a non-login user. Its `ProtectHome=true` policy intentionally means production projects should live outside `/home`, for example under `/srv`.

## Docker Compose installation

Docker is optional. The default and shortest path is still the host
`./install.sh`. The image pins Bun, Codex CLI and the base-image digest; it runs
with the invoking host UID/GID, a read-only root filesystem, no Linux
capabilities and `no-new-privileges`. Config, SQLite/media state and
`CODEX_HOME` are independent host bind mounts.

From the repository root, run the guided wrapper:

```bash
./docker.sh setup
```

The wrapper creates or mounts `~/codex-workspace` by default; pass
`--project /absolute/path` to mount another directory. It asks only for the bot
token, builds the pinned images, starts a resumable bootstrap container and
prints a nonce-protected link. Press **START** in Telegram to claim the owner,
confirm the mounted project and choose YOLO or Safe. The same container writes
the production config atomically, restarts into the full bridge and offers
these next actions:

- **Connect Codex** opens official device login for the persistent container
  `CODEX_HOME`;
- **Check login** refreshes the same onboarding card;
- **Create Groq key** and **Paste Groq key** optionally enable voice transcription;
- **Start the first task** enters the normal task flow.

The key-bearing Telegram message is scrubbed from the durable inbox and queued
for durable deletion. Groq voice is optional and can be skipped.

Lifecycle commands stay small:

```bash
./docker.sh status
./docker.sh logs
./docker.sh restart
./docker.sh doctor
./docker.sh down
```

`./docker.sh setup` uses a dedicated persistent Codex home under the bridge data
directory by default. `--codex-home /absolute/path` selects another host
directory. If bot-based device login is unavailable, the profile-gated one-shot
helper is the recovery path:

```bash
./docker.sh login             # device-code fallback
./docker.sh login --browser   # localhost callback fallback
```

Credentials are never image layers or Compose environment values. The Telegram
token and bootstrap state live in a host-private config bind (`0700`, files
`0600`); that bind remains writable so the bootstrap can persist its polling
cursor and atomically create the final config. The optional Groq key lives in a
private writable credentials directory under state so the bot can rotate it.
The container root filesystem is still read-only. The health endpoint remains
container-local and Docker evaluates it with the image `HEALTHCHECK`; do not
publish port `8787` unless a trusted monitor requires it.

## First-run and restart acceptance

Before calling an installation healthy:

1. Send `/start`, then a short request that creates a Codex thread.
2. Confirm the final Telegram answer and record the thread id from `/status` or `/threads`.
3. Restart with `systemctl --user restart codex-tg-wire.service` or
   `./docker.sh restart`.
4. Wait for readiness, send a follow-up without `/new`, and confirm `/status` still reports the same thread.
5. Run `/failed` and `/ambiguous`; both should be empty.

The automated equivalent is `bun run acceptance:codex`; it uses isolated fakes and no real credentials. A real canary is still required before declaring the public release stable.

## Why v1 is not a `.codex-plugin`

The bridge is an always-on daemon with SQLite, Telegram polling, health checks and OS service ownership. A Codex plugin is useful for skills, MCP and app integrations inside an interactive Codex process, but it cannot replace this daemon lifecycle. Shipping both would add a second install/update path without reducing operator steps, so v1 deliberately ships one standalone runtime. A thin onboarding plugin can be reconsidered only if it can call the same doctor/install contracts without owning another bridge process.
