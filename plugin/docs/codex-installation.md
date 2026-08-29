# Installation: standalone Telegram → Codex bridge

This guide installs bridge `1.0.x` as a single-owner daemon. It does not use the legacy Claude channel runtime. Supported versions are pinned in [the compatibility matrix](codex-compatibility.md).

## Recommended user installation

For a personal Linux host, clone the repository and run the onboarding:

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

The installer is resumable and safe to run again. It installs frozen Bun
dependencies and the pinned Codex CLI locally, reuses the current user's
`CODEX_HOME` (normally `~/.codex`), asks for the project and private Telegram
allowlist, stores the bot token separately with mode `0600`, runs doctor and
creates `~/.config/systemd/user/codex-tg-wire.service`. SQLite and media state
default to `~/.local/share/codex-tg-wire`. No root privileges or service account
are required.

The execution choice is explicit in onboarding:

| Profile | Codex settings | Intended use |
|---|---|---|
| `YOLO` (default) | `approvalPolicy=never`, `danger-full-access` | A private, single-owner bot where uninterrupted remote work matters more than host isolation. Telegram compromise becomes full access as that Linux user. |
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
- Bun `1.4.x` for a host installation;
- Codex CLI `0.149.1` for the advanced system-wide host installation (the user installer vendors it locally);
- a private Telegram bot token and numeric owner user/chat ids;
- a local project directory writable by the service account;
- an authenticated Codex CLI account.

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

The image pins Bun, Codex CLI and the base-image digest. It runs as a configurable non-root UID/GID, has a read-only root filesystem, drops all Linux capabilities and persists bridge state separately from `CODEX_HOME`.

From the release root:

```bash
cd deploy/docker
cp .env.example .env
cp bridge.config.example.json bridge.config.json
cp bridge.env.example bridge.env
install -m 0600 /dev/null telegram-token
```

Edit `.env`: set the absolute `DASHI_PROJECT_PATH`, and set `DASHI_UID`/`DASHI_GID` to the owner of that project (`id -u` and `id -g`). Edit `bridge.config.json` with the real Telegram ids. Put only the bot token in `telegram-token`; do not add it to Compose environment or JSON.

Build and confirm the exact runtime pins:

```bash
docker compose build --pull bridge
docker compose run --rm --entrypoint codex bridge --version
docker compose run --rm --entrypoint bun bridge --version
```

Authenticate the persistent Codex volume and run preflight:

```bash
docker compose run --rm --entrypoint codex bridge login --device-auth
docker compose run --rm --entrypoint bun bridge run doctor:codex --online
docker compose up -d
docker compose ps
```

The health endpoint stays loopback-only inside the container; Docker evaluates it with the image `HEALTHCHECK`. Do not publish port `8787` unless a trusted local monitor requires it.

## First-run and restart acceptance

Before calling an installation healthy:

1. Send `/start`, then a short request that creates a Codex thread.
2. Confirm the final Telegram answer and record the thread id from `/status` or `/threads`.
3. Restart with `systemctl restart dashi-codex-bridge` or `docker compose restart bridge`.
4. Wait for readiness, send a follow-up without `/new`, and confirm `/status` still reports the same thread.
5. Run `/failed` and `/ambiguous`; both should be empty.

The automated equivalent is `bun run acceptance:codex`; it uses isolated fakes and no real credentials. A real canary is still required before declaring the public release stable.

## Why v1 is not a `.codex-plugin`

The bridge is an always-on daemon with SQLite, Telegram polling, health checks and OS service ownership. A Codex plugin is useful for skills, MCP and app integrations inside an interactive Codex process, but it cannot replace this daemon lifecycle. Shipping both would add a second install/update path without reducing operator steps, so v1 deliberately ships one standalone runtime. A thin onboarding plugin can be reconsidered only if it can call the same doctor/install contracts without owning another bridge process.
