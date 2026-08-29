#!/usr/bin/env bash

set -Eeuo pipefail

SERVICE_NAME="codex-tg-wire.service"
SCRIPT_DIRECTORY="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_DIRECTORY="$SCRIPT_DIRECTORY/plugin"

CONFIG_DIRECTORY="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/codex-tg-wire"
STATE_DIRECTORY="${XDG_DATA_HOME:-$HOME/.local/share}/codex-tg-wire"
SYSTEMD_USER_DIRECTORY="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$SYSTEMD_USER_DIRECTORY/$SERVICE_NAME"

PROJECT_INPUT=""
TELEGRAM_USER=""
TELEGRAM_CHAT=""
TOKEN_SOURCE=""
GROQ_SOURCE=""
EXECUTION_PROFILE="yolo"
PROFILE_WAS_SET=0
ENABLE_GROQ=1
REPLACE_TOKEN=0
REPLACE_GROQ_KEY=0
START_SERVICE=1
ONLINE_DOCTOR=1
INSTALL_DEPENDENCIES=1
UNINSTALL=0
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

say() {
  printf '%s→%s %s\n' "$CYAN" "$RESET" "$*"
}

fail() {
  printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

ui_box_rule() {
  local left="$1"
  local right="$2"
  local border="${3:-$CYAN}"
  local rule
  printf -v rule '%*s' "$UI_INNER_WIDTH" ''
  rule="${rule// /─}"
  printf '%s%s%s%s%s\n' "$border" "$left" "$rule" "$right" "$RESET"
}

ui_box_line() {
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

ui_banner() {
  ui_box_rule '╭' '╮'
  ui_box_line 'CODEX · TG · WIRE' "$BOLD"
  ui_box_line 'Telegram ↔ Codex App Server'
  ui_box_rule '╰' '╯'
}

ui_step() {
  printf '\n%sШаг %s из %s%s · %s\n\n' "$BOLD" "$1" "$2" "$RESET" "$3"
}

ui_ok() {
  printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"
}

ui_warn() {
  printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"
}

ui_note() {
  printf '%s%s%s\n' "$DIM" "$*" "$RESET"
}

ui_prompt() {
  printf '%s?%s %s' "$CYAN" "$RESET" "$1"
}

on_interrupt() {
  printf '\n'
  ui_warn "Настройка отменена. Повторный ./install.sh продолжит с сохранённого шага."
  exit 130
}
trap on_interrupt INT

usage() {
  cat <<'EOF'
Install codex-tg-wire for the current Linux user.

Usage:
  ./install.sh [options]
  ./install.sh --uninstall

First-install options:
  --project PATH          Project directory Codex may work in
  --telegram-user ID      Allowed Telegram user id
  --telegram-chat ID      Allowed chat id (defaults to the user id)
  --token-file PATH       Read the Telegram bot token from a private file
  --groq-key-file PATH    Enable voice transcription with a private Groq key file
  --profile yolo|safe     Execution profile (default: yolo)

Maintenance options:
  --replace-token         Allow --token-file to replace an existing token
  --replace-groq-key      Allow --groq-key-file to replace an existing key
  --config-dir PATH       Override the configuration directory
  --state-dir PATH        Override the SQLite/media state directory
  --no-start              Install and enable the unit without starting it
  --offline               Skip the Telegram API check in doctor
  --skip-deps             Do not run bun install (for verified existing installs)
  --uninstall             Disable and remove only the user service; keep data
  -h, --help              Show this help

No token is accepted as a command-line value. Without --token-file, the first
interactive install asks for it without echoing it.

If the pinned Bun runtime is missing, the installer adds it to ~/.bun through
the official Bun installer. Set BUN_INSTALL to choose another absolute path.
EOF
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      need_value "$@"
      PROJECT_INPUT="$2"
      shift 2
      ;;
    --telegram-user)
      need_value "$@"
      TELEGRAM_USER="$2"
      shift 2
      ;;
    --telegram-chat)
      need_value "$@"
      TELEGRAM_CHAT="$2"
      shift 2
      ;;
    --token-file)
      need_value "$@"
      TOKEN_SOURCE="$2"
      shift 2
      ;;
    --groq-key-file)
      need_value "$@"
      GROQ_SOURCE="$2"
      ENABLE_GROQ=1
      shift 2
      ;;
    --profile)
      need_value "$@"
      EXECUTION_PROFILE="$2"
      PROFILE_WAS_SET=1
      shift 2
      ;;
    --config-dir)
      need_value "$@"
      CONFIG_DIRECTORY="$2"
      shift 2
      ;;
    --state-dir)
      need_value "$@"
      STATE_DIRECTORY="$2"
      shift 2
      ;;
    --replace-token)
      REPLACE_TOKEN=1
      shift
      ;;
    --replace-groq-key)
      REPLACE_GROQ_KEY=1
      shift
      ;;
    --no-start)
      START_SERVICE=0
      shift
      ;;
    --offline)
      ONLINE_DOCTOR=0
      shift
      ;;
    --skip-deps)
      INSTALL_DEPENDENCIES=0
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$CONFIG_DIRECTORY" in
  /*) ;;
  *) fail "--config-dir must be an absolute path" ;;
esac
case "$STATE_DIRECTORY" in
  /*) ;;
  *) fail "--state-dir must be an absolute path" ;;
esac
case "$EXECUTION_PROFILE" in
  yolo|safe) ;;
  *) fail "--profile must be 'yolo' or 'safe'" ;;
esac

if [[ $UNINSTALL -eq 1 ]]; then
  say "Removing the current user's service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  rm -f -- "$UNIT_PATH"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  printf 'Service removed. Configuration and state were kept:\n  %s\n  %s\n' \
    "$CONFIG_DIRECTORY" "$STATE_DIRECTORY"
  exit 0
fi

[[ -d "$PLUGIN_DIRECTORY" && -f "$PLUGIN_DIRECTORY/package.json" ]] || \
  fail "run this script from a complete codex-tg-wire checkout"
[[ "$(uname -s)" == "Linux" ]] || fail "the one-command installer currently supports Linux only"

ui_banner
ui_step 1 4 "Runtime"

absolute_command() {
  local name="$1"
  local path
  path="$(command -v "$name" 2>/dev/null)" || return 1
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *)
      local directory
      directory="$(CDPATH= cd -- "$(dirname -- "$path")" && pwd -P)"
      printf '%s/%s\n' "$directory" "$(basename -- "$path")"
      ;;
  esac
}

required_command() {
  local name="$1"
  local path
  path="$(absolute_command "$name")" || fail "$name is required but was not found in PATH"
  printf '%s\n' "$path"
}

PINNED_BUN_VERSION="$(awk -F'[@"]' '/"packageManager"[[:space:]]*:/ { print $5; exit }' \
  "$PLUGIN_DIRECTORY/package.json")"
[[ "$PINNED_BUN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  fail "cannot read the pinned Bun version"
BUN_INSTALL_DIRECTORY="${BUN_INSTALL:-$HOME/.bun}"
case "$BUN_INSTALL_DIRECTORY" in
  /*) ;;
  *) fail "BUN_INSTALL must be an absolute path" ;;
esac

install_bun() {
  local curl_binary
  curl_binary="$(required_command curl)"
  required_command unzip >/dev/null

  say "Installing pinned Bun $PINNED_BUN_VERSION in $BUN_INSTALL_DIRECTORY"
  TEMPORARY_PATH="$(mktemp "${TMPDIR:-/tmp}/codex-tg-wire-bun.XXXXXX")"
  "$curl_binary" --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 https://bun.com/install --output "$TEMPORARY_PATH"
  BUN_INSTALL="$BUN_INSTALL_DIRECTORY" \
    bash "$TEMPORARY_PATH" "bun-v$PINNED_BUN_VERSION" >/dev/null
  rm -f -- "$TEMPORARY_PATH"
  TEMPORARY_PATH=""
}

BUN_BINARY="$(absolute_command bun || true)"
if [[ -z "$BUN_BINARY" && -x "$BUN_INSTALL_DIRECTORY/bin/bun" ]]; then
  BUN_BINARY="$BUN_INSTALL_DIRECTORY/bin/bun"
fi
BUN_VERSION=""
if [[ -n "$BUN_BINARY" ]]; then
  BUN_VERSION="$("$BUN_BINARY" --version 2>/dev/null || true)"
fi
if [[ "$BUN_VERSION" != "$PINNED_BUN_VERSION" ]]; then
  if [[ -n "$BUN_VERSION" ]]; then
    ui_warn "Found Bun $BUN_VERSION; codex-tg-wire pins $PINNED_BUN_VERSION."
  else
    ui_note "Bun is not installed; the installer will add it without sudo."
  fi
  install_bun
  BUN_BINARY="$BUN_INSTALL_DIRECTORY/bin/bun"
  [[ -x "$BUN_BINARY" ]] || fail "Bun installer did not create $BUN_BINARY"
  BUN_VERSION="$("$BUN_BINARY" --version 2>/dev/null)" || fail "cannot execute Bun"
fi
[[ "$BUN_VERSION" == "$PINNED_BUN_VERSION" ]] || \
  fail "Bun $PINNED_BUN_VERSION is required; found ${BUN_VERSION:-unknown}"
export PATH="$BUN_INSTALL_DIRECTORY/bin:$PATH"

SYSTEMCTL_BINARY="$(required_command systemctl)"
CODEX_HOME_VALUE="${CODEX_HOME:-$HOME/.codex}"

if ! "$SYSTEMCTL_BINARY" --user show-environment >/dev/null 2>&1; then
  fail "systemd --user is unavailable; log in normally or enable a user manager first"
fi

if [[ $INSTALL_DEPENDENCIES -eq 1 ]]; then
  say "Installing frozen Bun dependencies"
  (
    cd -- "$PLUGIN_DIRECTORY"
    "$BUN_BINARY" install --frozen-lockfile
  )
fi

LOCAL_CODEX_BINARY="$PLUGIN_DIRECTORY/node_modules/.bin/codex"
if [[ -n "${CODEX_BINARY_PATH:-}" ]]; then
  [[ "$CODEX_BINARY_PATH" == /* && -x "$CODEX_BINARY_PATH" ]] || \
    fail "CODEX_BINARY_PATH must name an absolute executable path"
  CODEX_BINARY="$CODEX_BINARY_PATH"
elif [[ -x "$LOCAL_CODEX_BINARY" ]]; then
  CODEX_BINARY="$LOCAL_CODEX_BINARY"
else
  CODEX_BINARY="$(absolute_command codex)"
fi
PINNED_CODEX_VERSION="$(awk -F'"' '/"codexCliVersion"/ { print $4; exit }' \
  "$PLUGIN_DIRECTORY/codex-app-server.compatibility.json")"
[[ -n "$PINNED_CODEX_VERSION" ]] || fail "cannot read the pinned Codex CLI version"
CODEX_VERSION_OUTPUT="$($CODEX_BINARY --version 2>/dev/null)" || fail "cannot execute Codex CLI"
CODEX_VERSION="${CODEX_VERSION_OUTPUT#codex-cli }"
[[ "$CODEX_VERSION" != "$CODEX_VERSION_OUTPUT" ]] || \
  fail "Codex CLI returned an unexpected version string: $CODEX_VERSION_OUTPUT"
[[ "$CODEX_VERSION" == "$PINNED_CODEX_VERSION" ]] || \
  fail "Codex CLI $PINNED_CODEX_VERSION is required; found $CODEX_VERSION"

ui_ok "Bun $BUN_VERSION"
if HOME="$HOME" CODEX_HOME="$CODEX_HOME_VALUE" \
  "$CODEX_BINARY" login status >/dev/null 2>&1; then
  ui_ok "Codex CLI $CODEX_VERSION · текущий login переиспользован"
else
  ui_warn "Codex CLI $CODEX_VERSION · login завершим кнопкой в Telegram"
fi
ui_ok "systemd --user доступен"

CONFIG_PATH="$CONFIG_DIRECTORY/bridge.config.json"
ENVIRONMENT_PATH="$CONFIG_DIRECTORY/bridge.env"
TOKEN_PATH="$CONFIG_DIRECTORY/telegram-token"
GROQ_PATH="$CONFIG_DIRECTORY/groq-api-key"
NEW_INSTALL=0

if [[ -e "$CONFIG_PATH" || -e "$ENVIRONMENT_PATH" || -e "$TOKEN_PATH" ]]; then
  [[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || \
    fail "existing installation has no safe regular config: $CONFIG_PATH"
  [[ -f "$ENVIRONMENT_PATH" && ! -L "$ENVIRONMENT_PATH" ]] || \
    fail "existing installation has no safe regular environment file: $ENVIRONMENT_PATH"
  [[ -f "$TOKEN_PATH" && ! -L "$TOKEN_PATH" ]] || \
    fail "existing installation has no safe regular Telegram credential: $TOKEN_PATH"
  if grep -q '"provider": "groq"' "$CONFIG_PATH"; then
    ENABLE_GROQ=1
    [[ -f "$GROQ_PATH" && ! -L "$GROQ_PATH" ]] || \
      fail "existing Groq voice config has no safe credential: $GROQ_PATH"
  else
    ENABLE_GROQ=0
    if [[ -n "$GROQ_SOURCE" ]]; then
      fail "existing config has Groq voice disabled; enable it explicitly in bridge.config.json first"
    fi
  fi
  if [[ $PROFILE_WAS_SET -eq 1 ]]; then
    fail "--profile only applies to a first install; edit the existing config explicitly"
  fi
  ui_step 2 4 "Доступ Codex"
  ui_ok "Keeping the existing bridge configuration"
  ui_note "Профиль, project path и allowlist не перезаписываются."
else
  NEW_INSTALL=1
  ui_step 2 4 "Доступ Codex"
  if [[ -z "$PROJECT_INPUT" ]]; then
    [[ -t 0 ]] || fail "--project is required for a non-interactive first install"
    ui_prompt "Папка проекта (absolute path): "
    read -r PROJECT_INPUT
  fi

  [[ "$PROJECT_INPUT" == /* ]] || fail "--project must be an absolute path"
  [[ -d "$PROJECT_INPUT" ]] || fail "project directory does not exist: $PROJECT_INPUT"
  PROJECT_DIRECTORY="$(CDPATH= cd -- "$PROJECT_INPUT" && pwd -P)"

  if [[ $PROFILE_WAS_SET -eq 0 && -t 0 ]]; then
    printf '  %s1)%s YOLO %s(default)%s — без approvals и sandbox\n' \
      "$BOLD" "$RESET" "$GREEN" "$RESET"
    printf '  2) Safe — workspace-write, опасные команды через Telegram approval\n\n'
    while true; do
      ui_prompt "Режим [1]: "
      read -r PROFILE_CHOICE
      case "$PROFILE_CHOICE" in
        ''|1) EXECUTION_PROFILE="yolo"; break ;;
        2) EXECUTION_PROFILE="safe"; break ;;
        *) ui_warn "Выберите 1 или 2." ;;
      esac
    done
  fi
  if [[ "$EXECUTION_PROFILE" == "yolo" ]]; then
    ui_ok "YOLO: approvalPolicy=never · sandbox=danger-full-access"
    ui_warn "Telegram-команды получат все права текущего Linux-пользователя."
    ui_note "Доступ останется только у указанного user/chat id; публичный бот здесь недопустим."
  else
    ui_ok "Safe: approvalPolicy=on-request · sandbox=workspace-write"
  fi
  ui_ok "Проект: $PROJECT_DIRECTORY"

  ui_step 3 4 "Приватный Telegram"
  if [[ -z "$TELEGRAM_USER" ]]; then
    [[ -t 0 ]] || fail "--telegram-user is required for a non-interactive first install"
    ui_prompt "Telegram owner user id: "
    read -r TELEGRAM_USER
  fi
  [[ -n "$TELEGRAM_CHAT" ]] || TELEGRAM_CHAT="$TELEGRAM_USER"

  VOICE_PROVIDER="groq"

  say "Creating private configuration and SQLite state directories"
  "$BUN_BINARY" "$PLUGIN_DIRECTORY/scripts/codex-bridge-init.ts" \
    --config-dir "$CONFIG_DIRECTORY" \
    --state-dir "$STATE_DIRECTORY" \
    --project "$PROJECT_DIRECTORY" \
    --telegram-user "$TELEGRAM_USER" \
    --telegram-chat "$TELEGRAM_CHAT" \
    --profile "$EXECUTION_PROFILE" \
    --voice "$VOICE_PROVIDER" >/dev/null
fi

if [[ $NEW_INSTALL -eq 0 ]]; then
  ui_step 3 4 "Приватный Telegram"
fi

write_token_file() {
  local source="$1"
  local size
  [[ -f "$source" && ! -L "$source" ]] || fail "--token-file must be a regular, non-symlink file"
  size="$(stat -c '%s' -- "$source")"
  [[ "$size" -gt 0 && "$size" -le 65536 ]] || fail "--token-file is empty or too large"
  TEMPORARY_PATH="$(mktemp "$CONFIG_DIRECTORY/.telegram-token.XXXXXX")"
  install -m 0600 -- "$source" "$TEMPORARY_PATH"
  mv -f -- "$TEMPORARY_PATH" "$TOKEN_PATH"
  TEMPORARY_PATH=""
}

write_groq_file() {
  local source="$1"
  local size
  [[ -f "$source" && ! -L "$source" ]] || fail "--groq-key-file must be a regular, non-symlink file"
  size="$(stat -c '%s' -- "$source")"
  [[ "$size" -gt 0 && "$size" -le 65536 ]] || fail "--groq-key-file is empty or too large"
  TEMPORARY_PATH="$(mktemp "$CONFIG_DIRECTORY/.groq-api-key.XXXXXX")"
  install -m 0600 -- "$source" "$TEMPORARY_PATH"
  mv -f -- "$TEMPORARY_PATH" "$GROQ_PATH"
  TEMPORARY_PATH=""
}

if [[ -n "$TOKEN_SOURCE" ]]; then
  if [[ $NEW_INSTALL -eq 0 && $REPLACE_TOKEN -ne 1 ]]; then
    fail "refusing to replace the existing token without --replace-token"
  fi
  write_token_file "$TOKEN_SOURCE"
elif [[ ! -s "$TOKEN_PATH" ]]; then
  [[ -t 0 ]] || fail "--token-file is required for a non-interactive first install"
  ui_prompt "Telegram bot token (не отображается): "
  read -r -s TELEGRAM_TOKEN
  printf '\n'
  [[ -n "$TELEGRAM_TOKEN" ]] || fail "Telegram bot token must not be empty"
  TEMPORARY_PATH="$(mktemp "$CONFIG_DIRECTORY/.telegram-token.XXXXXX")"
  chmod 0600 "$TEMPORARY_PATH"
  printf '%s\n' "$TELEGRAM_TOKEN" > "$TEMPORARY_PATH"
  unset TELEGRAM_TOKEN
  mv -f -- "$TEMPORARY_PATH" "$TOKEN_PATH"
  TEMPORARY_PATH=""
fi
if [[ -n "$GROQ_SOURCE" ]]; then
  if [[ $NEW_INSTALL -eq 0 && $REPLACE_GROQ_KEY -ne 1 ]]; then
    fail "refusing to replace the existing Groq key without --replace-groq-key"
  fi
  write_groq_file "$GROQ_SOURCE"
fi
ui_ok "Telegram token сохранён отдельно · mode 0600"
if [[ $ENABLE_GROQ -eq 1 ]]; then
  if [[ -s "$GROQ_PATH" ]]; then
    ui_ok "Groq voice подключён · key хранится отдельно с mode 0600"
  else
    ui_note "Groq voice optional · подключается кнопкой после /start в Telegram."
  fi
else
  ui_note "Groq voice пропущен; Telegram voice всё равно передаётся Codex как audio."
fi
ui_ok "Allowlist и конфигурация готовы"

chmod 0700 "$CONFIG_DIRECTORY"
if [[ -d "$STATE_DIRECTORY" ]]; then
  chmod 0700 "$STATE_DIRECTORY"
fi
chmod 0600 "$CONFIG_PATH" "$ENVIRONMENT_PATH" "$TOKEN_PATH"
[[ ! -e "$GROQ_PATH" ]] || chmod 0600 "$GROQ_PATH"

systemd_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "paths must not contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

ui_step 4 4 "Проверка и запуск"
say "Installing $SERVICE_NAME for the current user"
mkdir -p -- "$SYSTEMD_USER_DIRECTORY"
TEMPORARY_PATH="$(mktemp "$SYSTEMD_USER_DIRECTORY/.codex-tg-wire.service.XXXXXX")"
chmod 0600 "$TEMPORARY_PATH"
{
  printf '%s\n' \
    '[Unit]' \
    'Description=codex-tg-wire durable Telegram bridge for Codex' \
    'Documentation=https://github.com/aipolukhin/codex-tg-wire' \
    'Wants=network-online.target' \
    'After=network-online.target' \
    '' \
    '[Service]' \
    'Type=notify' \
    'NotifyAccess=all' \
    "WorkingDirectory=$(systemd_quote "$PLUGIN_DIRECTORY")" \
    "Environment=$(systemd_quote "HOME=$HOME")" \
    "Environment=$(systemd_quote "CODEX_HOME=$CODEX_HOME_VALUE")" \
    "Environment=$(systemd_quote "CODEX_BINARY_PATH=$CODEX_BINARY")" \
    "Environment=$(systemd_quote "DASHI_CODEX_BRIDGE_CONFIG=$CONFIG_PATH")" \
    "Environment=$(systemd_quote "DASHI_TELEGRAM_BOT_TOKEN_FILE=$TOKEN_PATH")" \
    "Environment=$(systemd_quote "PATH=$PATH")"
  if [[ $ENABLE_GROQ -eq 1 ]]; then
    printf 'Environment=%s\n' "$(systemd_quote "GROQ_API_KEY_FILE=$GROQ_PATH")"
  fi
  printf '%s\n' \
    "ExecStart=$(systemd_quote "$BUN_BINARY") run start:codex" \
    'Restart=on-failure' \
    'RestartSec=5s' \
    'TimeoutStopSec=120s' \
    'WatchdogSec=180s' \
    'UMask=0077' \
    '' \
    'NoNewPrivileges=true' \
    'PrivateTmp=true' \
    '' \
    '[Install]' \
    'WantedBy=default.target'
} > "$TEMPORARY_PATH"
mv -f -- "$TEMPORARY_PATH" "$UNIT_PATH"
TEMPORARY_PATH=""

say "Running bridge doctor"
DOCTOR_ARGUMENTS=()
if [[ $ONLINE_DOCTOR -eq 1 ]]; then
  DOCTOR_ARGUMENTS+=(--online)
fi
(
  cd -- "$PLUGIN_DIRECTORY"
  DOCTOR_ENVIRONMENT=(
    "HOME=$HOME"
    "CODEX_HOME=$CODEX_HOME_VALUE"
    "CODEX_BINARY_PATH=$CODEX_BINARY"
    "DASHI_CODEX_BRIDGE_CONFIG=$CONFIG_PATH"
    "DASHI_TELEGRAM_BOT_TOKEN_FILE=$TOKEN_PATH"
  )
  if [[ $ENABLE_GROQ -eq 1 ]]; then
    DOCTOR_ENVIRONMENT+=("GROQ_API_KEY_FILE=$GROQ_PATH")
  fi
  env "${DOCTOR_ENVIRONMENT[@]}" \
    "$BUN_BINARY" run doctor:codex "${DOCTOR_ARGUMENTS[@]}"
)

"$SYSTEMCTL_BINARY" --user daemon-reload
"$SYSTEMCTL_BINARY" --user enable "$SERVICE_NAME" >/dev/null
if [[ $START_SERVICE -eq 1 ]]; then
  say "Starting $SERVICE_NAME"
  "$SYSTEMCTL_BINARY" --user restart "$SERVICE_NAME"
  "$SYSTEMCTL_BINARY" --user is-active --quiet "$SERVICE_NAME" || \
    fail "service did not become active; inspect: journalctl --user -u $SERVICE_NAME -n 100"
fi

printf '\n'
ui_box_rule '╭' '╮' "$GREEN"
ui_box_line 'codex-tg-wire готов' "$BOLD" "$GREEN"
ui_box_rule '╰' '╯' "$GREEN"
printf '\n'
printf '  Status: systemctl --user status %s\n' "$SERVICE_NAME"
printf '  Logs:   journalctl --user -u %s -f\n' "$SERVICE_NAME"
printf '  Config: %s\n' "$CONFIG_PATH"
printf '  State:  %s\n' "$STATE_DIRECTORY"
printf '  Next:   open the bot, send /start and follow the action buttons\n'
if [[ $START_SERVICE -eq 0 ]]; then
  printf '  Start:  systemctl --user start %s\n' "$SERVICE_NAME"
fi
printf '  Remove service only: ./install.sh --uninstall\n'
printf '\nThe user service starts with your systemd user manager. On a headless host,\n'
printf 'an administrator may enable lingering if it must survive logout.\n'
