#!/usr/bin/env bash

set -euo pipefail

readonly GH_KEYRING_URL='https://cli.github.com/packages/githubcli-archive-keyring.gpg'
readonly GH_KEYRING_SHA256='6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b'
readonly KEYRING_PATH='/etc/apt/keyrings/githubcli-archive-keyring.gpg'
readonly SOURCE_LIST_PATH='/etc/apt/sources.list.d/github-cli.list'

if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
  echo 'error: this installer supports Debian/Ubuntu systems with apt and dpkg' >&2
  exit 1
fi

if [[ ${EUID} -eq 0 ]]; then
  sudo_cmd=()
elif command -v sudo >/dev/null 2>&1; then
  sudo_cmd=(sudo)
else
  echo 'error: run as root or install sudo' >&2
  exit 1
fi

if ! command -v wget >/dev/null 2>&1; then
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y wget ca-certificates
fi

tmp_keyring=$(mktemp /tmp/githubcli-keyring.XXXXXX)
cleanup() {
  rm -f -- "$tmp_keyring"
}
trap cleanup EXIT

echo 'Downloading the official GitHub CLI signing key...'
wget -q -O "$tmp_keyring" "$GH_KEYRING_URL"
echo "$GH_KEYRING_SHA256  $tmp_keyring" | sha256sum --check --status || {
  echo 'error: GitHub CLI signing key checksum mismatch' >&2
  exit 1
}

"${sudo_cmd[@]}" install -d -m 0755 /etc/apt/keyrings /etc/apt/sources.list.d
"${sudo_cmd[@]}" install -m 0644 "$tmp_keyring" "$KEYRING_PATH"

architecture=$(dpkg --print-architecture)
repository="deb [arch=${architecture} signed-by=${KEYRING_PATH}] https://cli.github.com/packages stable main"
printf '%s\n' "$repository" | "${sudo_cmd[@]}" tee "$SOURCE_LIST_PATH" >/dev/null

"${sudo_cmd[@]}" apt-get update
"${sudo_cmd[@]}" apt-get install -y gh

echo
gh --version

if gh auth status >/dev/null 2>&1; then
  echo 'GitHub CLI is already authenticated.'
  gh auth status
  exit 0
fi

echo
echo 'Starting GitHub authentication. Follow the device-login instructions.'
gh auth login --hostname github.com --web --git-protocol https
gh auth status
