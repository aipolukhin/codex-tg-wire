#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIRECTORY="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="$SCRIPT_DIRECTORY/plugin/deploy/docker/compose.yaml"
DOCKER_CONFIG_DIRECTORY="${CODEX_TG_WIRE_DOCKER_CONFIG:-${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/codex-tg-wire/docker}"
DEFAULT_STATE_DIRECTORY="${XDG_DATA_HOME:-$HOME/.local/share}/codex-tg-wire"
DEFAULT_CODEX_HOME="${CODEX_TG_WIRE_DOCKER_CODEX_HOME:-$DEFAULT_STATE_DIRECTORY/codex-home}"
ACTION="${1:-help}"
[[ $# -eq 0 ]] || shift

PROJECT_INPUT=""
TELEGRAM_USER=""
TELEGRAM_CHAT=""
TOKEN_SOURCE=""
GROQ_SOURCE=""
TELEGRAM_TOKEN=""
EXECUTION_PROFILE="yolo"
PROFILE_WAS_SET=0
ENABLE_GROQ=1
STATE_DIRECTORY="$DEFAULT_STATE_DIRECTORY"
CODEX_HOME_DIRECTORY="$DEFAULT_CODEX_HOME"
REPLACE_TOKEN=0
REPLACE_GROQ_KEY=0
START_SERVICE=1
ONLINE_DOCTOR=1
TEMPORARY_PATH=""
UI_INNER_WIDTH=44

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  CYAN=$'\033[36m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  RED=$'\033[31m'
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
else
  CYAN=""
  GREEN=""
  YELLOW=""
  RED=""
  BOLD=""
  DIM=""
  RESET=""
fi

cleanup() {
  if [[ -n "$TEMPORARY_PATH" && -e "$TEMPORARY_PATH" ]]; then
    rm -f -- "$TEMPORARY_PATH"
  fi
}
trap cleanup EXIT

say() { printf '%s→%s %s\n' "$CYAN" "$RESET" "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
note() { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
prompt() { printf '%s?%s %s' "$CYAN" "$RESET" "$1"; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

box_rule() {
  local left="$1"
  local right="$2"
  local border="${3:-$CYAN}"
  local rule
  printf -v rule '%*s' "$UI_INNER_WIDTH" ''
  rule="${rule// /─}"
  printf '%s%s%s%s%s\n' "$border" "$left" "$rule" "$right" "$RESET"
}

box_line() {
  local text="$1"
  local style="${2:-}"
  local border="${3:-$CYAN}"
  local width="${#text}"
  (( width <= UI_INNER_WIDTH )) || fail "internal UI line is wider than its frame"
  local left=$(( (UI_INNER_WIDTH - width) / 2 ))
  local right=$(( UI_INNER_WIDTH - width - left ))
  printf '%s│%s%*s%s%s%s%*s%s│%s\n' \
    "$border" "$RESET" "$left" '' "$style" "$text" "$RESET" "$right" '' "$border" "$RESET"
}

banner() {
  box_rule '╭' '╮'
  box_line 'CODEX · TG · WIRE' "$BOLD"
  box_line 'optional Docker runtime'
  box_rule '╰' '╯'
}

step() { printf '\n%sШаг %s из %s%s · %s\n\n' "$BOLD" "$1" "$2" "$RESET" "$3"; }

on_interrupt() {
  printf '\n'
  warn "Настройка отменена. Повторный ./docker.sh setup продолжит безопасно."
  exit 130
}
trap on_interrupt INT

usage() {
  cat <<'EOF'
Optional Docker lifecycle for codex-tg-wire.

Usage:
  ./docker.sh setup [options]
  ./docker.sh up|down|restart|status|logs|doctor|build
  ./docker.sh login [--browser]

Setup options:
  --project PATH          Project directory Codex may work in
  --telegram-user ID      Preseed owner id instead of interactive bot claim
  --telegram-chat ID      Preseed chat id (defaults to the owner id)
  --token-file PATH       Read the Telegram bot token from a private file
  --groq-key-file PATH    Enable voice transcription with a private Groq key file
  --profile yolo|safe     Execution profile (default: yolo)
  --config-dir PATH       Docker config directory (default: XDG config home)
  --state-dir PATH        SQLite/media directory (default: XDG data home)
  --codex-home PATH       Persistent container Codex home (default: XDG data home)
  --replace-token         Replace an existing Telegram credential
  --replace-groq-key      Replace an existing Groq credential
  --no-start              Configure and verify without starting the bridge
  --offline               Skip Telegram API checks in doctor
  -h, --help              Show this help

No secret is accepted as a command-line value. Docker is an optional deployment
path; the default host installation remains ./install.sh.

The normal setup asks only for the BotFather token, starts the container, then
moves owner claim and the YOLO/Safe choice into a nonce-protected Telegram flow.
--project selects the host directory mounted into Docker; the default is
~/codex-workspace. Numeric Telegram IDs are only for automation/preseed.
EOF
}

need_value() { [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"; }

absolute_directory() {
  local path="$1"
  local label="$2"
  [[ "$path" == /* ]] || fail "$label must be an absolute path"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a real directory: $path"
  (CDPATH= cd -- "$path" && pwd -P)
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker Engine with Compose is required"
  docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"
  docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable for the current user"
}

compose_environment_path() { printf '%s/compose.env\n' "$DOCKER_CONFIG_DIRECTORY"; }

compose() {
  docker compose --env-file "$(compose_environment_path)" -f "$COMPOSE_FILE" "$@"
}

require_setup() {
  local environment_path
  environment_path="$(compose_environment_path)"
  [[ -f "$environment_path" && ! -L "$environment_path" ]] || \
    fail "Docker setup is incomplete; run ./docker.sh setup"
  if [[ ! -s "$DOCKER_CONFIG_DIRECTORY/bridge.config.json" ]]; then
    [[ -s "$DOCKER_CONFIG_DIRECTORY/bootstrap-state.json" ]] || \
      fail "bridge config and bootstrap state are missing; run ./docker.sh setup"
  fi
  [[ -s "$DOCKER_CONFIG_DIRECTORY/telegram-token" ]] || \
    fail "Telegram credential is missing; run ./docker.sh setup"
}

require_production_config() {
  [[ -s "$DOCKER_CONFIG_DIRECTORY/bridge.config.json" ]] || \
    fail "bot-first onboarding is not complete; finish it in Telegram first"
}

compose_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "paths must not contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_compose_environment() {
  local project="$1"
  local environment_path
  environment_path="$(compose_environment_path)"
  TEMPORARY_PATH="$(mktemp "$DOCKER_CONFIG_DIRECTORY/.compose.env.XXXXXX")"
  chmod 0600 "$TEMPORARY_PATH"
  {
    printf 'COMPOSE_PROJECT_NAME=codex-tg-wire\n'
    printf 'CODEX_TG_WIRE_PROJECT_PATH=%s\n' "$(compose_quote "$project")"
    printf 'CODEX_TG_WIRE_CONFIG_DIR=%s\n' "$(compose_quote "$DOCKER_CONFIG_DIRECTORY")"
    printf 'CODEX_TG_WIRE_STATE_DIR=%s\n' "$(compose_quote "$STATE_DIRECTORY")"
    printf 'CODEX_TG_WIRE_CODEX_HOME=%s\n' "$(compose_quote "$CODEX_HOME_DIRECTORY")"
    printf 'CODEX_TG_WIRE_UID=%s\n' "$(id -u)"
    printf 'CODEX_TG_WIRE_GID=%s\n' "$(id -g)"
    printf 'CODEX_TG_WIRE_IMAGE=codex-tg-wire:1.0.0\n'
    printf 'CODEX_TG_WIRE_LOGIN_IMAGE=codex-tg-wire-login:1.0.0\n'
    printf 'CODEX_TG_WIRE_VERSION=1.0.0\n'
    printf 'BUN_VERSION=1.4.0\n'
    printf 'CODEX_CLI_VERSION=0.149.1\n'
  } > "$TEMPORARY_PATH"
  mv -f -- "$TEMPORARY_PATH" "$environment_path"
  TEMPORARY_PATH=""
}

write_token_file() {
  local source="$1"
  local target="$DOCKER_CONFIG_DIRECTORY/telegram-token"
  local size
  [[ -f "$source" && ! -L "$source" ]] || fail "--token-file must be a regular, non-symlink file"
  size="$(stat -c '%s' -- "$source")"
  [[ "$size" -gt 0 && "$size" -le 65536 ]] || fail "--token-file is empty or too large"
  TEMPORARY_PATH="$(mktemp "$DOCKER_CONFIG_DIRECTORY/.telegram-token.XXXXXX")"
  install -m 0600 -- "$source" "$TEMPORARY_PATH"
  mv -f -- "$TEMPORARY_PATH" "$target"
  TEMPORARY_PATH=""
}

write_groq_file() {
  local source="$1"
  local target="$STATE_DIRECTORY/credentials/groq-api-key"
  local size
  [[ -f "$source" && ! -L "$source" ]] || fail "--groq-key-file must be a regular, non-symlink file"
  size="$(stat -c '%s' -- "$source")"
  [[ "$size" -gt 0 && "$size" -le 65536 ]] || fail "--groq-key-file is empty or too large"
  mkdir -p -- "$STATE_DIRECTORY/credentials"
  chmod 0700 "$STATE_DIRECTORY/credentials"
  TEMPORARY_PATH="$(mktemp "$STATE_DIRECTORY/credentials/.groq-api-key.XXXXXX")"
  install -m 0600 -- "$source" "$TEMPORARY_PATH"
  mv -f -- "$TEMPORARY_PATH" "$target"
  TEMPORARY_PATH=""
}

run_doctor() {
  local arguments=(run doctor:codex)
  [[ $ONLINE_DOCTOR -eq 0 ]] || arguments+=(--online)
  compose run --rm --no-deps --entrypoint bun bridge "${arguments[@]}"
}

setup() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) need_value "$@"; PROJECT_INPUT="$2"; shift 2 ;;
      --telegram-user) need_value "$@"; TELEGRAM_USER="$2"; shift 2 ;;
      --telegram-chat) need_value "$@"; TELEGRAM_CHAT="$2"; shift 2 ;;
      --token-file) need_value "$@"; TOKEN_SOURCE="$2"; shift 2 ;;
      --groq-key-file) need_value "$@"; GROQ_SOURCE="$2"; ENABLE_GROQ=1; shift 2 ;;
      --profile) need_value "$@"; EXECUTION_PROFILE="$2"; PROFILE_WAS_SET=1; shift 2 ;;
      --config-dir) need_value "$@"; DOCKER_CONFIG_DIRECTORY="$2"; shift 2 ;;
      --state-dir) need_value "$@"; STATE_DIRECTORY="$2"; shift 2 ;;
      --codex-home) need_value "$@"; CODEX_HOME_DIRECTORY="$2"; shift 2 ;;
      --replace-token) REPLACE_TOKEN=1; shift ;;
      --replace-groq-key) REPLACE_GROQ_KEY=1; shift ;;
      --no-start) START_SERVICE=0; shift ;;
      --offline) ONLINE_DOCTOR=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown setup option: $1" ;;
    esac
  done

  case "$EXECUTION_PROFILE" in yolo|safe) ;; *) fail "--profile must be 'yolo' or 'safe'" ;; esac
  case "$DOCKER_CONFIG_DIRECTORY" in /*) ;; *) fail "--config-dir must be absolute" ;; esac
  case "$STATE_DIRECTORY" in /*) ;; *) fail "--state-dir must be absolute" ;; esac
  case "$CODEX_HOME_DIRECTORY" in /*) ;; *) fail "--codex-home must be absolute" ;; esac

  banner
  step 1 4 "Docker runtime"
  require_docker
  ok "$(docker --version)"
  ok "$(docker compose version)"
  note "Default host install is still ./install.sh; this path is explicitly containerized."

  local config_path="$DOCKER_CONFIG_DIRECTORY/bridge.config.json"
  local environment_path="$DOCKER_CONFIG_DIRECTORY/bridge.env"
  local token_path="$DOCKER_CONFIG_DIRECTORY/telegram-token"
  local groq_path="$STATE_DIRECTORY/credentials/groq-api-key"
  local bootstrap_path="$DOCKER_CONFIG_DIRECTORY/bootstrap-state.json"
  local compose_path
  compose_path="$(compose_environment_path)"
  local new_install=0
  local bootstrap_install=0
  local onboarding_url=""

  if [[ -e "$config_path" ]]; then
    [[ -f "$config_path" && ! -L "$config_path" ]] || fail "unsafe or incomplete config: $config_path"
    [[ -f "$environment_path" && ! -L "$environment_path" ]] || fail "unsafe or incomplete environment: $environment_path"
    [[ -f "$token_path" && ! -L "$token_path" ]] || fail "unsafe or incomplete credential: $token_path"
    [[ -f "$compose_path" && ! -L "$compose_path" ]] || fail "unsafe or incomplete Compose environment: $compose_path"
    if [[ -e "$groq_path" ]]; then
      [[ -f "$groq_path" && ! -L "$groq_path" ]] || fail "unsafe Groq credential: $groq_path"
      ENABLE_GROQ=1
    else
      ENABLE_GROQ=0
      if [[ -n "$GROQ_SOURCE" ]]; then
        fail "existing config has Groq voice disabled; enable it explicitly in bridge.config.json first"
      fi
    fi
    [[ $PROFILE_WAS_SET -eq 0 ]] || fail "--profile applies only to first setup"
    step 2 4 "Persistent data"
    ok "Keeping existing config, Codex home and SQLite state"
    note "Nothing is recreated and docker compose down will not remove host data."
  elif [[ -e "$bootstrap_path" ]]; then
    [[ -f "$bootstrap_path" && ! -L "$bootstrap_path" ]] || fail "unsafe bootstrap state: $bootstrap_path"
    [[ -f "$environment_path" && ! -L "$environment_path" ]] || fail "unsafe bootstrap environment"
    [[ -s "$token_path" && ! -L "$token_path" ]] || fail "unsafe bootstrap credential"
    [[ -f "$compose_path" && ! -L "$compose_path" ]] || fail "unsafe Compose environment"
    [[ -f "$groq_path" && ! -L "$groq_path" ]] || fail "unsafe bootstrap Groq credential"
    [[ $PROFILE_WAS_SET -eq 0 ]] || fail "--profile cannot replace active bot onboarding"
    local bootstrap_bot bootstrap_nonce
    bootstrap_bot="$(sed -n 's/.*"botUsername": "\([A-Za-z0-9_]*\)".*/\1/p' "$bootstrap_path")"
    bootstrap_nonce="$(sed -n 's/.*"nonce": "\([A-Za-z0-9_-]*\)".*/\1/p' "$bootstrap_path")"
    [[ "$bootstrap_bot" =~ ^[A-Za-z0-9_]{5,32}$ && "$bootstrap_nonce" =~ ^[A-Za-z0-9_-]{16,64}$ ]] || \
      fail "bootstrap state has no valid Telegram link"
    onboarding_url="https://t.me/$bootstrap_bot?start=$bootstrap_nonce"
    bootstrap_install=1
    ENABLE_GROQ=1
    step 2 4 "Bot-first onboarding"
    ok "Незавершённая настройка найдена — продолжаем без повторного ввода token."
  elif [[ -e "$environment_path" || -e "$token_path" || -e "$compose_path" || -e "$groq_path" ]]; then
    fail "Docker target contains incomplete credentials without config or bootstrap state"
  else
    new_install=1
    PROJECT_INPUT="${PROJECT_INPUT:-$HOME/codex-workspace}"
    [[ "$PROJECT_INPUT" == /* ]] || fail "--project must be an absolute path"
    if [[ ! -e "$PROJECT_INPUT" ]]; then
      mkdir -p -- "$PROJECT_INPUT" || fail "cannot create Docker project directory: $PROJECT_INPUT"
      chmod 0700 "$PROJECT_INPUT"
    fi
    local project_directory
    project_directory="$(absolute_directory "$PROJECT_INPUT" "project")"
    mkdir -p -- "$DOCKER_CONFIG_DIRECTORY" "$STATE_DIRECTORY" "$CODEX_HOME_DIRECTORY"
    chmod 0700 "$DOCKER_CONFIG_DIRECTORY" "$STATE_DIRECTORY" "$CODEX_HOME_DIRECTORY"
    DOCKER_CONFIG_DIRECTORY="$(absolute_directory "$DOCKER_CONFIG_DIRECTORY" "config directory")"
    STATE_DIRECTORY="$(absolute_directory "$STATE_DIRECTORY" "state directory")"
    CODEX_HOME_DIRECTORY="$(absolute_directory "$CODEX_HOME_DIRECTORY" "Codex home")"
    write_compose_environment "$project_directory"

    say "Building pinned runtime and profile-gated login helper"
    compose build --pull bridge codex-login
    ok "Runtime image ready; credentials were not copied into it"

    step 2 4 "Persistent data"
    ok "Project is mounted at the same absolute path: $project_directory"
    ok "Codex threads persist in $CODEX_HOME_DIRECTORY"

    step 3 4 "Private Telegram"
    if [[ -n "$TELEGRAM_USER" ]]; then
      [[ "$TELEGRAM_USER" =~ ^[1-9][0-9]*$ ]] || fail "--telegram-user must be a positive numeric id"
      [[ -n "$TELEGRAM_CHAT" ]] || TELEGRAM_CHAT="$TELEGRAM_USER"
      compose run --rm --no-deps setup \
        --config-dir /etc/codex-tg-wire \
        --state-dir /var/lib/codex-tg-wire \
        --project "$project_directory" \
        --telegram-user "$TELEGRAM_USER" \
        --telegram-chat "$TELEGRAM_CHAT" \
        --profile "$EXECUTION_PROFILE" \
        --voice groq \
        --groq-credential-path /var/lib/codex-tg-wire/credentials/groq-api-key >/dev/null
      if [[ "$EXECUTION_PROFILE" == "yolo" ]]; then
        ok "YOLO: approvalPolicy=never · sandbox=danger-full-access"
      else
        ok "Safe: approvalPolicy=on-request · sandbox=workspace-write"
      fi
    else
      [[ -z "$TELEGRAM_CHAT" ]] || fail "--telegram-chat requires --telegram-user"
      bootstrap_install=1
      ENABLE_GROQ=1
      if [[ -n "$TOKEN_SOURCE" ]]; then
        [[ -f "$TOKEN_SOURCE" && ! -L "$TOKEN_SOURCE" ]] || \
          fail "--token-file must be a regular, non-symlink file"
      else
        prompt "Telegram bot token от @BotFather (не отображается): "
        read -r -s TELEGRAM_TOKEN
        printf '\n'
        [[ -n "$TELEGRAM_TOKEN" ]] || fail "Telegram bot token must not be empty"
      fi
      mkdir -p -- "$STATE_DIRECTORY/credentials"
      chmod 0700 "$STATE_DIRECTORY/credentials"
      local bootstrap_profile="auto"
      [[ $PROFILE_WAS_SET -eq 0 ]] || bootstrap_profile="$EXECUTION_PROFILE"
      if [[ -n "$TOKEN_SOURCE" ]]; then
        onboarding_url="$(compose run --rm --no-deps -T --entrypoint bun setup \
          /app/scripts/codex-bridge-bootstrap-init.ts \
          --config-dir /etc/codex-tg-wire \
          --state-dir /var/lib/codex-tg-wire \
          --default-project "$project_directory" \
          --deployment docker \
          --profile "$bootstrap_profile" \
          --groq-credential-path /var/lib/codex-tg-wire/credentials/groq-api-key \
          < "$TOKEN_SOURCE")" || fail "не удалось инициализировать Telegram bot"
      else
        onboarding_url="$(printf '%s\n' "$TELEGRAM_TOKEN" | \
          compose run --rm --no-deps -T --entrypoint bun setup \
            /app/scripts/codex-bridge-bootstrap-init.ts \
            --config-dir /etc/codex-tg-wire \
            --state-dir /var/lib/codex-tg-wire \
            --default-project "$project_directory" \
            --deployment docker \
            --profile "$bootstrap_profile" \
            --groq-credential-path /var/lib/codex-tg-wire/credentials/groq-api-key)" || \
          fail "не удалось инициализировать Telegram bot"
        unset TELEGRAM_TOKEN
      fi
      ok "Bot token проверен; owner и режим выбираются дальше в Telegram."
    fi
  fi

  if [[ $new_install -eq 0 ]]; then step 3 4 "Private Telegram"; fi
  if [[ $bootstrap_install -eq 0 ]]; then
    if [[ -n "$TOKEN_SOURCE" ]]; then
      if [[ $new_install -eq 0 && $REPLACE_TOKEN -ne 1 ]]; then
        fail "refusing to replace token without --replace-token"
      fi
      write_token_file "$TOKEN_SOURCE"
    elif [[ ! -s "$token_path" ]]; then
      if [[ -z "$TELEGRAM_TOKEN" ]]; then
        [[ -t 0 ]] || fail "--token-file is required for non-interactive setup"
        prompt "Telegram bot token от @BotFather (не отображается): "
        read -r -s TELEGRAM_TOKEN
        printf '\n'
      fi
      [[ -n "$TELEGRAM_TOKEN" ]] || fail "Telegram bot token must not be empty"
      TEMPORARY_PATH="$(mktemp "$DOCKER_CONFIG_DIRECTORY/.telegram-token.XXXXXX")"
      chmod 0600 "$TEMPORARY_PATH"
      printf '%s\n' "$TELEGRAM_TOKEN" > "$TEMPORARY_PATH"
      unset TELEGRAM_TOKEN
      mv -f -- "$TEMPORARY_PATH" "$token_path"
      TEMPORARY_PATH=""
    fi
  elif [[ -n "$TOKEN_SOURCE" && $new_install -eq 0 ]]; then
    [[ $REPLACE_TOKEN -eq 1 ]] || fail "refusing to replace bootstrap token without --replace-token"
    write_token_file "$TOKEN_SOURCE"
  fi
  if [[ -n "$GROQ_SOURCE" ]]; then
    if [[ $new_install -eq 0 && $REPLACE_GROQ_KEY -ne 1 ]]; then
      fail "refusing to replace Groq key without --replace-groq-key"
    fi
    write_groq_file "$GROQ_SOURCE"
  fi
  chmod 0700 "$DOCKER_CONFIG_DIRECTORY" "$STATE_DIRECTORY" "$CODEX_HOME_DIRECTORY"
  chmod 0600 "$environment_path" "$token_path" "$compose_path"
  [[ ! -e "$config_path" ]] || chmod 0600 "$config_path"
  [[ ! -e "$bootstrap_path" ]] || chmod 0600 "$bootstrap_path"
  [[ ! -e "$groq_path" ]] || chmod 0600 "$groq_path"
  ok "Token is a private bind-mounted file, never an image or environment value"
  if [[ $ENABLE_GROQ -eq 1 ]]; then
    if [[ -s "$groq_path" ]]; then
      ok "Groq voice connected; key is a separate private bind-mounted file"
    else
      note "Groq voice is optional and connects from the Telegram onboarding card."
    fi
  else
    note "Groq voice transcription skipped; Telegram voice still reaches Codex as audio."
  fi

  step 4 4 "Doctor and bot-first start"
  if [[ $bootstrap_install -eq 0 ]]; then
    say "Running bridge doctor"
    run_doctor
  else
    ok "Bot identity and token verified; production config is checked on restart."
  fi
  if [[ $START_SERVICE -eq 1 ]]; then
    say "Starting hardened bridge container"
    compose up -d --no-build bridge
    compose ps bridge
  fi

  printf '\n'
  box_rule '╭' '╮' "$GREEN"
  box_line 'Docker bridge ready' "$BOLD" "$GREEN"
  box_rule '╰' '╯' "$GREEN"
  printf '\n'
  printf '  Status: ./docker.sh status\n'
  printf '  Logs:   ./docker.sh logs\n'
  printf '  Stop:   ./docker.sh down\n'
  printf '  Config: %s\n' "$DOCKER_CONFIG_DIRECTORY"
  printf '  State:  %s\n' "$STATE_DIRECTORY"
  if [[ $bootstrap_install -eq 1 ]]; then
    if [[ $START_SERVICE -eq 0 ]]; then
      printf '  Start:  ./docker.sh up\n'
    fi
    printf '\n  Open the one-time link and press START:\n\n  %s\n\n' "$onboarding_url"
    printf '  Next:   finish owner, project and mode setup in Telegram\n'
  else
    printf '  Next:   open the bot, send /start and follow the action buttons\n'
  fi
}

case "$ACTION" in
  setup) setup "$@" ;;
  up) require_docker; require_setup; compose up -d --no-build bridge ;;
  down) require_docker; require_setup; compose down ;;
  restart) require_docker; require_setup; compose restart bridge ;;
  status) require_docker; require_setup; compose ps bridge ;;
  logs) require_docker; require_setup; compose logs --tail 100 -f bridge ;;
  doctor) require_docker; require_setup; require_production_config; run_doctor ;;
  build) require_docker; require_setup; compose build --pull bridge codex-login ;;
  login)
    require_docker
    require_setup
    if [[ "${1:-}" == "--browser" ]]; then
      [[ $# -eq 1 ]] || fail "usage: ./docker.sh login [--browser]"
      compose run --rm --service-ports codex-login login
    else
      [[ $# -eq 0 ]] || fail "usage: ./docker.sh login [--browser]"
      compose run --rm --no-deps codex-login login --device-auth
    fi
    ;;
  help|-h|--help) usage ;;
  *) fail "unknown action: $ACTION (run ./docker.sh --help)" ;;
esac
