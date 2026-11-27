#!/usr/bin/env bash
# batch driver — run several steps inside ONE process/session.
# Why: every separate call that (re)starts the daemon or touches a new host
# pays the cold start again; a batch keeps the daemon warm across steps.
#
# Usage: batch.sh <steps-file>
#   Steps file, one step per line (blank lines and # comments are skipped):
#     warm
#     keep | resume | stop
#     read  [--lean|--fp] <url>
#     open  [--lean|--fp] <url>
#     js    <script-file>
#   Each step's stdout is passed through, preceded by a header line:
#     %%BATCH-STEP%% <n> <step text>
#   Final line:
#     %%BATCH%% steps=<n> ok=<n> fail=<n> elapsed_s=<s>
#   Exit code: 0 when every step succeeded, 1 otherwise (all steps still run).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"
STEPS="${1:?usage: batch.sh <steps-file>}"
[ -f "$STEPS" ] || { echo "batch.sh: steps file not found: $STEPS" >&2; exit 1; }

START=$(date +%s.%N)
N=0; OK=0; FAIL=0
while IFS= read -r line || [ -n "$line" ]; do
  # trim leading/trailing whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  N=$((N+1))
  echo "%%BATCH-STEP%% $N $line"
  # word-split the step line intentionally (URLs/paths must not contain spaces)
  set -- $line
  cmd="${1:-}"; shift || true
  RC=0
  case "$cmd" in
    read|open) "$HERE/run.sh" "$cmd" "$@" || RC=$? ;;
    js)        "$HERE/run.sh" -f "${1:?js step needs a script file}" || RC=$? ;;
    warm|keep|resume|stop) "$HERE/run.sh" "$cmd" || RC=$? ;;
    *) echo "batch.sh: unknown step: $cmd" >&2; RC=1 ;;
  esac
  if [ $RC -eq 0 ]; then OK=$((OK+1)); else FAIL=$((FAIL+1)); fi
done < "$STEPS"
ELAPSED=$(awk -v s="$START" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}')
echo "%%BATCH%% steps=$N ok=$OK fail=$FAIL elapsed_s=$ELAPSED"
[ $FAIL -eq 0 ]
