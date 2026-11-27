#!/usr/bin/env bash
# selftest-intake.sh — one command that checks the whole intake harness.
#
# Creates two throwaway profiles (10 email-style logins with 6 passwords;
# 8 student-id + social logins with 0 passwords), builds a REAL private sheet
# for each with `vault-sheet-init.sh`, re-runs it to prove idempotency, adds a
# login to prove only the new row is appended, fills two password cells the way
# the user would, runs `intake_all --source sheet`, and checks that the cells
# are cleared and the values landed in a throwaway vault.
#
# Everything it creates is removed afterwards (sheets to the trash, temp dirs
# deleted). No value is ever printed.
#
#   bash extensions/vault-intake/selftest-intake.sh
#   bash extensions/vault-intake/selftest-intake.sh --keep     # keep the temp dir
#
# Exit codes: 0 every check passed · 1 a check failed · 2 no Google access
#             (in that case use extensions/vault-intake/vault-form.sh + extensions/vault-intake/intake.sh --source file)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../bin/pu-config.sh"
exec python3 "$HERE/selftest_intake.py" "$@"
