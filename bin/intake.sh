#!/usr/bin/env bash
# intake.sh — move the rows the user filled in into the vault.
#
#   bash bin/intake.sh                          # auto: sheet if configured and readable, else the local form
#   bash bin/intake.sh --source sheet           # the private Google Sheet
#   bash bin/intake.sh --source file            # the local form (inbox.tsv / inbox.csv)
#   bash bin/intake.sh --source file --file P   # a specific returned form
#   bash bin/intake.sh --test                   # same, but with a throwaway row, then cleanup
#
# Two sources, one rule: the values travel gog stdout / file -> python stdin
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
. "$HERE/pu-config.sh"
GOG="${PU_GOG:-gog}"

SHEET_ID=$(python3 "$HERE/pu_config.py" get sheet_id 2>/dev/null || true)
RANGE=$(python3 "$HERE/pu_config.py" get sheet_range 2>/dev/null || true)
RANGE="${RANGE:-in!A2:C200}"

exec python3 "$HERE/intake_all.py" --sheet-id "$SHEET_ID" --range "$RANGE" --gog "$GOG" "$@"
