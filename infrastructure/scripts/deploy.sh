#!/usr/bin/env bash
set -euo pipefail
exec flock --exclusive --wait 1800 /var/www/TruevineVoice/.deployment.lock \
  node "$(dirname "$0")/deploy.mjs" "$@"
