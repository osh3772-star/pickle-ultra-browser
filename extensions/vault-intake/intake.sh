#!/usr/bin/env bash
# intake.sh — move the rows the user filled in into the vault.
#
#   bash extensions/vault-intake/intake.sh                          # auto: sheet if configured and readable, else the local form
#   bash extensions/vault-intake/intake.sh --source sheet           # the private Google Sheet
#   bash extensions/vault-intake/intake.sh --source file            # the local form (inbox.tsv / inbox.csv)
#   bash extensions/vault-intake/intake.sh --source file --file P   # a specific returned form
# (There is no --test mode. tests/test-intake-file.sh builds a throwaway vault and
#  home, writes a form, fills it and runs this same command end to end.)
#
# Two sources, one rule: the values travel gog stdout / file -> vault stdin
# only, are never printed or logged, and the row is cleared once it is stored.
# With --source file and every row stored, the form and its copies under
# attachments/ are shredded and deleted (pass --attachments-dir for a chat
# attachment folder outside the default).
#
# The sheet id comes from the config file (~/.config/pickle-ultra/config.json),
# never from a constant in this script, so one checkout serves many users.
# A sheet that cannot be read falls back to the local form once — no retry loop.
#
# Exit codes: 0 all rows stored and cleared · 1 something failed (see the lines)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bin/pu-config.sh"
NODE="$(pu_node)" || { echo "fail code=node reason=node-not-found"; exit 1; }
GOG="${PU_GOG:-gog}"
exec "$NODE" "$HERE/intake-all.mjs" --gog "$GOG" "$@"
