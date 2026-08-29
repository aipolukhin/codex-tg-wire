#!/bin/sh

set -eu

# Codex binds its browser-login callback to container loopback. Forward a
# second container port so Docker can publish localhost:1455 without exposing
# the callback beyond the host. Device-code login does not use this listener.
socat TCP-LISTEN:1456,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:1455 &

exec codex "$@"
