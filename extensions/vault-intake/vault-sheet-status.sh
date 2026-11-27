#!/usr/bin/env bash
# vault-sheet-status.sh — should I run intake now?
#
# Prints counts only, never a value and never a username:
#   status source=sheet listed=<n> waiting=<n> unfilled=<n> checked_at=<iso>
#   status source=inbox listed=<n> waiting=<n> unfilled=<n> checked_at=<iso> path=<file>
#   skip no-form                     (nothing built yet)
#   fail code=read                   (sheet configured but unreadable -> fall back to the form)
#
#   waiting   rows with a password cell filled   -> run extensions/vault-intake/intake.sh now
#   unfilled  sites still without a password     -> nothing to do yet
#
# The run is recorded as last_status_at in the config file, so the agent can
# say when it last looked. Values never enter this path.
#
#   bash extensions/vault-intake/vault-sheet-status.sh           # one line
#   bash extensions/vault-intake/vault-sheet-status.sh --json    # same fields as JSON
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bin/pu-config.sh"
NODE="$(pu_node)" || { echo "fail code=node reason=node-not-found"; exit 1; }
exec "$NODE" "$HERE/vault-sheet.mjs" status "$@"
