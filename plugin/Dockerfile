# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE} AS base

ARG BUN_VERSION=1.4.0
ARG CODEX_CLI_VERSION=0.149.1
ARG CODEX_TG_WIRE_UID=10001
ARG CODEX_TG_WIRE_GID=10001
ARG VERSION=1.0.0
ARG REVISION=unknown

RUN npm install --global --no-audit --no-fund \
      "bun@${BUN_VERSION}" \
      "@openai/codex@${CODEX_CLI_VERSION}" \
    && groupadd --gid "${CODEX_TG_WIRE_GID}" codex-wire \
    && useradd --uid "${CODEX_TG_WIRE_UID}" --gid "${CODEX_TG_WIRE_GID}" \
      --create-home --home-dir /home/codex-wire --shell /usr/sbin/nologin codex-wire \
    && install -d -o codex-wire -g codex-wire -m 0700 \
      /var/lib/codex-tg-wire /var/lib/codex

WORKDIR /app

COPY --chown=codex-wire:codex-wire package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=codex-wire:codex-wire codex-app-server.compatibility.json bridge.config.example.json ./
COPY --chown=codex-wire:codex-wire src ./src
COPY --chown=codex-wire:codex-wire scripts ./scripts

ENV HOME=/var/lib/codex \
    CODEX_HOME=/var/lib/codex \
    DASHI_CODEX_BRIDGE_CONFIG=/etc/codex-tg-wire/bridge.config.json \
    NODE_ENV=production

LABEL org.opencontainers.image.title="codex-tg-wire" \
      org.opencontainers.image.description="Durable owner-only Telegram bridge for Codex App Server" \
      org.opencontainers.image.source="https://github.com/aipolukhin/codex-tg-wire" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

# Profile-gated helper for containerized Codex login. The production image is
# the separate final runtime target and does not contain socat.
FROM base AS login

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 docker/codex-login-entrypoint.sh /usr/local/bin/codex-login-entrypoint
USER ${CODEX_TG_WIRE_UID}:${CODEX_TG_WIRE_GID}
EXPOSE 1456
ENTRYPOINT ["codex-login-entrypoint"]
CMD ["login", "--device-auth"]

FROM base AS runtime

USER ${CODEX_TG_WIRE_UID}:${CODEX_TG_WIRE_GID}

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8787/ready');process.exit(r.ok?0:1)"]

CMD ["bun", "run", "start:codex"]
