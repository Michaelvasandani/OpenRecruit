#!/usr/bin/env bash
# Move this Mac's OpenRecruit state (Scouts, schedules, Signals, job board, API keys,
# Candidate Profiles, agent workspaces) to a remote host, ONCE.
#   deploy/migrate-local-state.sh user@host
#
# Stop the local host first (Settings → Quit completely) so no run is mid-flight.
# The remote host is stopped while its state is replaced, then restarted.
#
# Claude conversations do not move: they live in ~/.claude on this Mac, not in
# OPENTRADE_HOME. Every agent's `last_session_id` is cleared in the copy so the
# first wake on the remote host starts a fresh session instead of failing to resume
# one that only exists here (three such failures would mark the agent broken).
set -euo pipefail

target="${1:?usage: deploy/migrate-local-state.sh user@host}"
home="${OPENTRADE_HOME:-$HOME/.opentrade}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

command -v sqlite3 >/dev/null || { echo "sqlite3 not found" >&2; exit 1; }
[ -f "$home/app.db" ] || { echo "no database at $home/app.db" >&2; exit 1; }
if [ -f "$home/host.json" ] && kill -0 "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$home/host.json")" 2>/dev/null; then
  echo "the local host is still running — quit OpenRecruit completely first" >&2
  exit 1
fi

# `.backup` copies a consistent snapshot including the WAL, unlike cp.
sqlite3 "$home/app.db" ".backup '$stage/app.db'"
sqlite3 "$stage/app.db" "UPDATE agents SET last_session_id = NULL; UPDATE scouts SET resumable_session_ref = NULL;"
for d in agents profiles; do [ -d "$home/$d" ] && cp -R "$home/$d" "$stage/$d"; done

echo "scouts: $(sqlite3 "$stage/app.db" 'select count(*) from scouts'), signals: $(sqlite3 "$stage/app.db" 'select count(*) from signals')"
ssh "$target" 'systemctl --user stop openrecruit-host.service; mkdir -p ~/.opentrade/migration-backup && cp ~/.opentrade/app.db ~/.opentrade/migration-backup/ 2>/dev/null; rm -f ~/.opentrade/app.db ~/.opentrade/app.db-wal ~/.opentrade/app.db-shm'
rsync -a "$stage/" "$target:.opentrade/"
ssh "$target" 'chmod 600 ~/.opentrade/app.db; systemctl --user start openrecruit-host.service; sleep 2; systemctl --user is-active openrecruit-host.service && tail -2 ~/.opentrade/host.log'
echo "migrated. Now: Settings → Connection → Remote machine → $target → Test → Apply"
