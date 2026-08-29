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
  --telegram-user ID      Allowed Telegram user id
  --telegram-chat ID      Allowed chat id (defaults to the user id)
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
  [[ -s "$DOCKER_CONFIG_DIRECTORY/bridge.config.json" ]] || \
    fail "bridge config is missing; run ./docker.sh setup"
  [[ -s "$DOCKER_CONFIG_DIRECTORY/telegram-token" ]] || \
    fail "Telegram credential is missing; run ./docker.sh setup"
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
  local compose_path
  compose_path="$(compose_environment_path)"
  local new_install=0

  if [[ -e "$config_path" || -e "$environment_path" || -e "$token_path" || -e "$compose_path" ]]; then
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
  else
    new_install=1
    if [[ -z "$PROJECT_INPUT" ]]; then
      [[ -t 0 ]] || fail "--project is required for non-interactive setup"
      prompt "Папка проекта (absolute path): "
      read -r PROJECT_INPUT
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
    if [[ $PROFILE_WAS_SET -eq 0 && -t 0 ]]; then
      printf '  %s1)%s YOLO %s(default)%s — без approvals и sandbox\n' \
        "$BOLD" "$RESET" "$GREEN" "$RESET"
      printf '  2) Safe — workspace-write, опасные команды через Telegram approval\n\n'
      while true; do
        prompt "Режим [1]: "
        read -r choice
        case "$choice" in
          ''|1) EXECUTION_PROFILE="yolo"; break ;;
          2) EXECUTION_PROFILE="safe"; break ;;
          *) warn "Выберите 1 или 2." ;;
        esac
      done
    fi
    if [[ "$EXECUTION_PROFILE" == "yolo" ]]; then
      ok "YOLO: approvalPolicy=never · sandbox=danger-full-access"
      warn "Only a private owner allowlist is safe for this profile."
    else
      ok "Safe: approvalPolicy=on-request · sandbox=workspace-write"
    fi
    ok "Project is mounted at the same absolute path: $project_directory"
    ok "Codex threads persist in $CODEX_HOME_DIRECTORY"

    step 3 4 "Private Telegram"
    if [[ -z "$TELEGRAM_USER" ]]; then
      [[ -t 0 ]] || fail "--telegram-user is required for non-interactive setup"
      prompt "Telegram owner user id: "
      read -r TELEGRAM_USER
    fi
    [[ -n "$TELEGRAM_CHAT" ]] || TELEGRAM_CHAT="$TELEGRAM_USER"
    local voice_provider="groq"
    compose run --rm --no-deps setup \
      --config-dir /etc/codex-tg-wire \
      --state-dir /var/lib/codex-tg-wire \
      --project "$project_directory" \
      --telegram-user "$TELEGRAM_USER" \
      --telegram-chat "$TELEGRAM_CHAT" \
      --profile "$EXECUTION_PROFILE" \
      --voice "$voice_provider" \
      --groq-credential-path /var/lib/codex-tg-wire/credentials/groq-api-key >/dev/null
  fi

  if [[ $new_install -eq 0 ]]; then step 3 4 "Private Telegram"; fi
  if [[ -n "$TOKEN_SOURCE" ]]; then
    if [[ $new_install -eq 0 && $REPLACE_TOKEN -ne 1 ]]; then
      fail "refusing to replace token without --replace-token"
    fi
    write_token_file "$TOKEN_SOURCE"
  elif [[ ! -s "$token_path" ]]; then
    [[ -t 0 ]] || fail "--token-file is required for non-interactive setup"
    prompt "Telegram bot token (не отображается): "
    read -r -s telegram_token
    printf '\n'
    [[ -n "$telegram_token" ]] || fail "Telegram bot token must not be empty"
    TEMPORARY_PATH="$(mktemp "$DOCKER_CONFIG_DIRECTORY/.telegram-token.XXXXXX")"
    chmod 0600 "$TEMPORARY_PATH"
    printf '%s\n' "$telegram_token" > "$TEMPORARY_PATH"
    unset telegram_token
    mv -f -- "$TEMPORARY_PATH" "$token_path"
    TEMPORARY_PATH=""
  fi
  if [[ -n "$GROQ_SOURCE" ]]; then
    if [[ $new_install -eq 0 && $REPLACE_GROQ_KEY -ne 1 ]]; then
      fail "refusing to replace Groq key without --replace-groq-key"
    fi
    write_groq_file "$GROQ_SOURCE"
  fi
  chmod 0700 "$DOCKER_CONFIG_DIRECTORY" "$STATE_DIRECTORY" "$CODEX_HOME_DIRECTORY"
  chmod 0600 "$config_path" "$environment_path" "$token_path" "$compose_path"
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
  say "Running bridge doctor"
  run_doctor
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
  printf '  Next:   open the bot, send /start and follow the action buttons\n'
}

case "$ACTION" in
  setup) setup "$@" ;;
  up) require_docker; require_setup; compose up -d --no-build bridge ;;
  down) require_docker; require_setup; compose down ;;
  restart) require_docker; require_setup; compose restart bridge ;;
  status) require_docker; require_setup; compose ps bridge ;;
  logs) require_docker; require_setup; compose logs --tail 100 -f bridge ;;
  doctor) require_docker; require_setup; run_doctor ;;
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
