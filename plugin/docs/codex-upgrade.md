# Upgrade, rollback and disaster recovery

Release code under `/opt/dashi-codex-bridge/releases` is immutable. `current` and `previous` are symlinks managed atomically; configuration, `CODEX_HOME`, SQLite and media spools live outside releases.

## Upgrade systemd installation

Create an online backup before stopping the old binary:

```bash
sudo -u dashi-codex env \
  DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
  bun --cwd /opt/dashi-codex-bridge/current run backup:codex -- \
  /var/lib/dashi-codex-bridge/pre-upgrade.sqlite3
sudo systemctl stop dashi-codex-bridge.service
```

Verify/extract the new release in a staging directory, then install without activating it:

```bash
sha256sum -c dashi-codex-bridge-1.0.1.sha256
bun run manage:codex -- install \
  --artifact ../dashi-codex-bridge-1.0.1.tar.gz \
  --checksums ../dashi-codex-bridge-1.0.1.sha256 \
  --prefix /opt/dashi-codex-bridge \
  --owner dashi-codex \
  --no-activate
```

The manager prints the exact versioned release directory. Run that release's doctor against the existing config before activation, then switch `current`:

```bash
sudo -u dashi-codex env \
  HOME=/var/lib/dashi-codex-bridge \
  CODEX_HOME=/var/lib/dashi-codex-bridge/codex-home \
  CREDENTIALS_DIRECTORY=/etc/dashi-codex-bridge \
  DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
  bun --cwd /opt/dashi-codex-bridge/releases/1.0.1-REPLACE_COMMIT run doctor:codex
sudo bun /opt/dashi-codex-bridge/releases/1.0.1-REPLACE_COMMIT/scripts/codex-bridge-release-manager.ts \
  activate --prefix /opt/dashi-codex-bridge \
  --release /opt/dashi-codex-bridge/releases/1.0.1-REPLACE_COMMIT
sudo systemctl start dashi-codex-bridge.service
curl --fail http://127.0.0.1:8787/ready
```

Send a follow-up to an existing thread and inspect `/failed` and `/ambiguous`. Do not remove the old release or pre-upgrade backup until the canary window is complete.

## Safe rollback

SQLite migrations are forward-only. A previous binary is not assumed to understand a database already migrated by a newer release. Therefore the safe rollback restores the pre-upgrade backup instead of silently trying to downgrade schema:

```bash
sudo systemctl stop dashi-codex-bridge.service
sudo bun /opt/dashi-codex-bridge/current/scripts/codex-bridge-release-manager.ts \
  rollback --prefix /opt/dashi-codex-bridge
sudo -u dashi-codex env \
  DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
  bun --cwd /opt/dashi-codex-bridge/current run restore:codex -- \
  /var/lib/dashi-codex-bridge/pre-upgrade.sqlite3 --replace
sudo -u dashi-codex env \
  CREDENTIALS_DIRECTORY=/etc/dashi-codex-bridge \
  DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
  bun --cwd /opt/dashi-codex-bridge/current run doctor:codex
sudo systemctl start dashi-codex-bridge.service
```

Restore keeps the replaced database as a `.pre-restore-*` recovery copy. Never delete WAL/SHM files by hand; a dirty sidecar blocks restore.

## Docker upgrade and rollback

Back up into the persistent state volume, change only `DASHI_BRIDGE_IMAGE` or the checked-out release, then recreate the container:

```bash
docker compose exec bridge bun run backup:codex -- /var/lib/dashi/pre-upgrade.sqlite3
docker compose build --pull bridge
docker compose up -d --force-recreate bridge
docker compose ps
```

To roll back, restore the previous image/release pin, stop the bridge, restore the pre-upgrade database with that image, and recreate the service. Named `bridge-state` and `codex-home` volumes must not be deleted. `docker compose down -v` is destructive and is never part of an upgrade or rollback.

## Compatibility discipline

- Never change only the Codex CLI version in Docker or on the host.
- Update the machine manifest, generated schema fingerprint, Docker build arg and human matrix together.
- Run `codex:schema:check`, all tests and `acceptance:codex` before activation.
- A checksum proves file integrity, not publisher identity. Verify a detached signature when the release channel provides one.
- Backup/restore covers bridge SQLite and spools only when the operator includes them; Codex auth and external project data require their own backup policy.
