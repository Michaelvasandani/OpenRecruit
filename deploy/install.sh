#!/usr/bin/env bash
# Runs ON the server, from the uploaded bundle (~/openrecruit-host). Installs the
# host's npm deps for this machine and (re)starts it as a systemd user service.
# Idempotent — deploy.sh calls it on every deploy.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null; then
  echo "node not found. Install Node.js 22+ first, e.g.:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) { console.error("Node >= 22.12 required, found "+process.versions.node); process.exit(1) }'

# node-pty has no Linux prebuilds and compiles from source.
for tool in python3 make g++; do
  command -v "$tool" >/dev/null || {
    echo "missing build tool: $tool  (sudo apt-get install -y python3 make g++)" >&2
    exit 1
  }
done

npm install --omit=dev --no-audit --no-fund

command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] ||
  echo "warning: claude CLI not found — install it and run 'claude' once to log in, or Scout runs will fail" >&2

mkdir -p "$HOME/.config/systemd/user"
cp deploy/openrecruit-host.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable openrecruit-host.service
systemctl --user restart openrecruit-host.service

# Keep the user manager (and so the host) alive with no login session.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  sudo -n loginctl enable-linger "$USER" 2>/dev/null ||
    echo "warning: run 'sudo loginctl enable-linger $USER' so the host survives logout" >&2
fi

sleep 2
systemctl --user --no-pager --lines=5 status openrecruit-host.service || true
