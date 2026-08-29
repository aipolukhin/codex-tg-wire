# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE}

ARG BUN_VERSION=1.4.0
ARG CODEX_CLI_VERSION=0.149.1

RUN npm install --global --no-audit --no-fund \
      "bun@${BUN_VERSION}" \
      "@openai/codex@${CODEX_CLI_VERSION}" \
    && groupadd --gid 10001 dashi \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/dashi --shell /usr/sbin/nologin dashi \
    && install -d -o dashi -g dashi -m 0700 /var/lib/dashi /var/lib/codex

WORKDIR /app

COPY --chown=dashi:dashi package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=dashi:dashi codex-app-server.compatibility.json bridge.config.example.json ./
COPY --chown=dashi:dashi src ./src
COPY --chown=dashi:dashi scripts ./scripts

ENV HOME=/var/lib/codex \
    CODEX_HOME=/var/lib/codex \
    DASHI_CODEX_BRIDGE_CONFIG=/etc/dashi-codex-bridge/bridge.config.json \
    NODE_ENV=production

USER 10001:10001

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8787/ready');process.exit(r.ok?0:1)"]

CMD ["bun", "run", "start:codex"]
