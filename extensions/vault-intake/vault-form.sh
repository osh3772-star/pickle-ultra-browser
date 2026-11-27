#!/usr/bin/env bash
# vault-form.sh — write the intake form as a local file (no Google needed).
#
# Use when the agent's Google account is not connected, so the private sheet
# cannot be created or read: the same three columns (사이트 / 아이디 / 비밀번호)
# travel as a file that the user opens on their own phone, fills in the
# password column only, and sends back through chat. `extensions/vault-intake/intake.sh` (or
# `intake_all.py --source file`) imports it into the vault and shreds it.
#
#   bash extensions/vault-intake/vault-form.sh                       # .tsv at $PICKLE_ULTRA_HOME/inbox.tsv
#   bash extensions/vault-intake/vault-form.sh --format csv          # widest app support
#   bash extensions/vault-intake/vault-form.sh --from-json f.json    # offline/test source
#   bash extensions/vault-intake/vault-form.sh --out /path/form.tsv
#
# The usernames are pre-filled from the vault's login list (metadata only —
# no password or TOTP value is read or printed). The file is written 0600.
# Re-running keeps a value the user already typed and only appends new sites.
#
# Exit codes: 0 ok/skip · 1 fail (see the one-line result)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bin/pu-config.sh"
exec python3 "$HERE/vault_form.py" "$@"
