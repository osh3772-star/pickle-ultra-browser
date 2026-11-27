#!/usr/bin/env bash
# vault-sheet-init.sh — create (or top up) the user's private intake sheet.
#
# Run ONCE after install, with the installing agent's own user:
#   bash extensions/vault-intake/vault-sheet-init.sh                 # read the agent's vault login list
#   bash extensions/vault-intake/vault-sheet-init.sh --new           # force a fresh sheet
#   bash extensions/vault-intake/vault-sheet-init.sh --from-json f   # offline/test source
#
# What ends up in the sheet:
#   tab "in"   A: 사이트   B: 아이디 (prefilled from the vault)   C: 비밀번호 (empty, user fills)
#   E1/F1      sites that sign in with a social account instead of a password
#
# No password or TOTP value is read or printed at any point; the vault CLI
# exposes metadata only.
#
# Exit codes: 0 ok/skip · 1 fail (see the one-line result)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bin/pu-config.sh"
NODE="$(pu_node)" || { echo "fail code=node reason=node-not-found"; exit 1; }
exec "$NODE" "$HERE/vault-sheet.mjs" init "$@"
