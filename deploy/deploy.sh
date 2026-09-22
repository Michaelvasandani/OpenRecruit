#!/usr/bin/env bash
# Build the host bundle and ship it to a server over SSH.
#   deploy/deploy.sh user@host
# The target is any ssh destination (an alias from ~/.ssh/config works too).
set -euo pipefail

target="${1:?usage: deploy/deploy.sh user@host}"
repo="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo/app"
bun run build
bun run bundle:host

# --delete keeps the install dir an exact mirror; node_modules is server-built, so keep it.
rsync -az --delete --exclude node_modules "$repo/dist-host/" "$target:openrecruit-host/"
ssh "$target" 'bash openrecruit-host/deploy/install.sh'
