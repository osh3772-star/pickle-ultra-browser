#!/usr/bin/env bash
# run-tests.sh — every check in one command.
#
#   bash tests/run-tests.sh                 # all suites
#   bash tests/run-tests.sh detect chain    # named suites only
#
# Suites: detect routecache chain bootstrap guard leak features selftest
#         doctor intake detectfail vaultlogin planguard
# Each suite prints its own PASS/FAIL lines; this runner adds one summary line
# per suite and a total. Exit 0 only when no suite failed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"

ALL="detect routecache chain bootstrap guard leak features selftest doctor intake-file intake detectfail vaultlogin planguard"
if [ $# -eq 0 ] || [ "$1" = "all" ]; then set -- $ALL; fi

run_suite() { # name -> prints "SUITE name PASS=n FAIL=n SKIP=n rc="
  local name="$1" out rc pf
  # Browser-heavy suites each boot their own daemon; stop the previous one so
  # the thread budget of a small container starts clean (a leftover daemon plus
  # a fresh one can exhaust ulimit -u and look like a product failure).
  case "$name" in
    guard|leak|features|selftest|detectfail|vaultlogin) bash "$TREE/bin/run.sh" stop >/dev/null 2>&1; sleep 1 ;;
  esac
  case "$name" in
    detect)    out=$(python3 "$HERE/test-detect.py" 2>&1); rc=$? ;;
    routecache) out=$(bash "$HERE/test-routecache.sh" 2>&1); rc=$? ;;
    chain)     out=$(bash "$HERE/test-chain-vault.sh" 2>&1); rc=$? ;;
    bootstrap) out=$(bash "$HERE/test-bootstrap.sh" 2>&1); rc=$? ;;
    guard)     out=$(bash "$HERE/test-daemon-guard.sh" 2>&1); rc=$? ;;
    leak)      out=$(bash "$HERE/test-thread-leak.sh" 10 2>&1); rc=$? ;;
    features)  out=$(bash "$HERE/test-browser-features.sh" 2>&1); rc=$? ;;
    selftest)  out=$(bash "$TREE/bin/selftest.sh" 2>&1); rc=$? ;;
    doctor)    out=$(bash "$TREE/bin/doctor.sh" 2>&1); rc=$? ;;
    intake)    out=$(bash "$TREE/extensions/vault-intake/selftest-intake.sh" 2>&1); rc=$? ;;
    intake-file) out=$(bash "$HERE/test-intake-file.sh" 2>&1); rc=$? ;;
    detectfail) out=$(bash "$HERE/test-detect-failure.sh" 2>&1); rc=$? ;;
    vaultlogin) out=$(bash "$HERE/test-vault-login.sh" 2>&1); rc=$? ;;
    planguard) out=$(bash "$HERE/plan-guards.sh" 2>&1); rc=$? ;;
    *) echo "unknown suite: $name" >&2; return 2 ;;
  esac
  # unittest prints "Ran 26 tests ... OK"; the bash suites print "name: PASS=n FAIL=n [SKIP=n]"
  pf=$(printf '%s\n' "$out" | grep -oE 'PASS=[0-9]+ FAIL=[0-9]+( SKIP=[0-9]+)?' | tail -1)
  if [ -z "$pf" ]; then
    if printf '%s\n' "$out" | grep -qE '^OK$'; then
      n=$(printf '%s\n' "$out" | sed -n 's/^Ran \([0-9]*\) tests.*/\1/p' | tail -1)
      pf="PASS=${n:-?} FAIL=0"
    else
      pf="PASS=? FAIL=?"
    fi
  fi
  printf '%s\n' "$out" > "${TMPDIR:-/tmp}/suite-$name.log" 2>/dev/null || true
  echo "SUITE $name $pf rc=$rc"
  printf '%s\n' "$out" | grep -E '^(FAIL|SKIP)' | sed 's/^/       /'
  return $rc
}

FAILED=0; SUM=""
for s in "$@"; do
  echo "RUN  $s"
  line=$(run_suite "$s"); rc=$?
  echo "$line"
  SUM="$SUM
$line"
  [ $rc -ne 0 ] && FAILED=$((FAILED+1))
done

echo "======================================================================"
sum_of() { printf '%s\n' "$SUM" | grep -oE "$1=[0-9]+" | cut -d= -f2 | awk '{s+=$1} END{print s+0}'; }
p=$(sum_of PASS); f=$(sum_of FAIL); sk=$(sum_of SKIP)
echo "run-tests: suites=$(echo "$@" | wc -w) failed_suites=$FAILED PASS=${p:-?} FAIL=${f:-?} SKIP=${sk:-0}"
[ "$FAILED" -eq 0 ]
