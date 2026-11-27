#!/usr/bin/env bash
# selftest.sh — offline check of the whole chain against a local HTTP server.
#
# Why a server instead of local files (2026-11-27, DEFECT-002):
# this test used to read fixtures through `file://` URLs. curl returns status
# 000 for file://, so a perfectly normal local page was reported F-NET and the
# "normal" case could only pass by accident. Now tests/http-server.mjs serves
# the fixtures over real HTTP with real status codes (200/403/429/500), a
# JS-rendered page, a redirect and login walls. Nothing is special-cased to let
# local files through — the lanes are exercised exactly as they are in
# production.
#
# What is checked: the structured verdict line (lane/status/code/next and, for
# the L1 success case, the path), not just the exit code.
#
#   bash bin/selftest.sh
#   PU_TEST_KEEP=1 bash bin/selftest.sh     # keep the server log for debugging
#
# Exit code: 0 when every executed case passed. A case that needs Chromium is
# SKIPped (never counted as PASS) when no binary is installed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"
TREE="$(dirname "$HERE")"
SRV="$TREE/tests/http-server.mjs"
FIX="$TREE/tests/fixtures"

T="$(mktemp -d "$TMPDIR/selftest-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  if [ -n "$SRV_PID" ]; then
    kill "$SRV_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$SRV_PID" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
  fi
  if [ "${PU_TEST_KEEP:-}" = 1 ]; then echo "selftest: kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

NODEBIN="$(pu_node || true)"
if [ -z "$NODEBIN" ]; then
  echo "selftest: node not found — run pickle-bootstrap.sh first" >&2
  exit 1
fi
if [ ! -f "$SRV" ]; then echo "selftest: fixture server missing: $SRV" >&2; exit 1; fi
[ -d "$FIX" ] || { echo "selftest: fixtures missing: $FIX" >&2; exit 1; }

"$NODEBIN" "$SRV" --port 0 --port-file "$T/port" --fixtures "$FIX" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port" 2>/dev/null || true)
if [ -z "${PORT:-}" ]; then
  echo "selftest: fixture server did not start" >&2
  cat "$T/server.log" >&2
  exit 1
fi
BASE="http://127.0.0.1:$PORT"

NPASS=0; NFAIL=0; NSKIP=0
pass() { NPASS=$((NPASS+1)); printf 'PASS  %-18s %s\n' "$1" "$2"; }
fail() { NFAIL=$((NFAIL+1)); printf 'FAIL  %-18s %s\n' "$1" "$2"; }
skip() { NSKIP=$((NSKIP+1)); printf 'SKIP  %-18s %s\n' "$1" "$2"; }

HAVE_CHROME=0
pu_resolve_chrome >/dev/null 2>&1 && HAVE_CHROME=1

# verdict <name> <mode:chain|run> <path> <want_rc> <want_status> <want_code> <want_next> [want_path_substr]
verdict() {
  local name="$1" mode="$2" path="$3" want_rc="$4" want_st="$5" want_code="$6" want_next="$7" want_path="${8:-}"
  local out rc line got_st got_code got_next got_path
  # A hung lane must fail this case, not hang the whole suite.
  local CASE_TIMEOUT="${PU_CASE_TIMEOUT:-60}"
  # Without Chromium the chain cannot finish an L1 attempt, so a failure case
  # would end as F-NET instead of its L0 verdict. In that state the L0 lane is
  # what is being tested: run fetch.sh and expect its exit code (0 ok / 1 fail).
  if [ "$mode" = "chain" ] && [ "$HAVE_CHROME" = 0 ]; then
    # report the L0 lane's own shape instead of a chain that cannot finish
    mode="fetch"
    case "$want_rc" in 0) want_rc=0 ;; *) want_rc=1 ;; esac
    [ "$want_st" = "skip" ] && want_st="fail"
  fi
  if [ "$mode" = "chain" ]; then
    out=$(timeout "$CASE_TIMEOUT" env PU_SETTLE="${PU_SETTLE:-2000}" bash "$HERE/chain.sh" read "$BASE$path" 2>"$T/$name.err"); rc=$?
  elif [ "$mode" = "fetch" ]; then
    # L0 only: the lane that owns transport failures (F-NET/F-TIMEOUT).
    out=$(timeout "$CASE_TIMEOUT" bash "$HERE/fetch.sh" "$BASE$path" 2>"$T/$name.err"); rc=$?
  else
    out=$(timeout "$CASE_TIMEOUT" env PU_SETTLE="${PU_SETTLE:-2000}" bash "$HERE/run.sh" read "$BASE$path" 2>"$T/$name.err"); rc=$?
  fi
  [ "$rc" = 124 ] && { fail "$name" "timed out after ${CASE_TIMEOUT}s"; return; }
  line="$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)"
  if [ -z "$line" ]; then
    fail "$name" "no verdict line (exit $rc)"; sed -n 1,3p "$T/$name.err" | sed 's/^/        /'; return
  fi
  got_st=$(printf '%s\n' "$line" | sed -n 's/.* status=\([^ ]*\).*/\1/p')
  got_code=$(printf '%s\n' "$line" | sed -n 's/.* code=\([^ ]*\).*/\1/p')
  got_next=$(printf '%s\n' "$line" | sed -n 's/.* next=\([^ ]*\).*/\1/p')
  got_path=$(printf '%s\n' "$line" | sed -n 's/.* path=\([^ ]*\).*/\1/p')
  local why=""
  [ "$rc" = "$want_rc" ] || why="$why exit=$rc(want $want_rc)"
  [ "$got_st" = "$want_st" ] || why="$why status=$got_st(want $want_st)"
  [ "$got_code" = "$want_code" ] || why="$why code=$got_code(want $want_code)"
  [ "$got_next" = "$want_next" ] || why="$why next=$got_next(want $want_next)"
  if [ -n "$want_path" ]; then
    case "$got_path" in *"$want_path"*) ;; *) why="$why path=$got_path(want *$want_path*)" ;; esac
  fi
  if [ -z "$why" ]; then pass "$name" "exit $rc $got_code next=$got_next${got_path:+ path=$got_path}"
  else fail "$name" "$why"; fi
}

echo "selftest: Pickle Ultra Browser — $HERE"
echo "selftest: fixtures on 127.0.0.1:$PORT (chromium: $([ $HAVE_CHROME = 1 ] && echo yes || echo no))"

# --- L0 lane: status, blocking, and the false-positive regressions ----------
verdict normal            chain /normal            0 ok   -      none
verdict normal-ko         chain /normal-ko         0 ok   -      none
verdict doc-about-403     chain /doc-403           0 ok   -      none
verdict doc-about-403-ko  chain /doc-403-ko        0 ok   -      none
verdict doc-about-403-ja  chain /doc-403-ja        0 ok   -      none
verdict public-login-link chain /public-login-link 0 ok   -      none
verdict public-login-box  chain /public-login-box  0 ok   -      none
verdict redirect          chain /redirect          0 ok   -      none
verdict http-403          chain /forbidden         3 fail F-IP   builtin-browser
verdict http-429          chain /ratelimit         3 fail F-IP   builtin-browser
verdict block-ko          chain /ko-block          3 fail F-IP   builtin-browser
verdict block-ja          chain /ja-block          3 fail F-IP   builtin-browser
verdict challenge         chain /challenge         3 fail F-BOT  builtin-browser
verdict challenge-ja      chain /challenge-ja      3 fail F-BOT  builtin-browser
verdict http-500-l0       fetch /error             1 fail F-NET  none
if [ $HAVE_CHROME = 1 ]; then
  verdict http-500-chain  chain /error             3 fail F-EMPTY builtin-browser
else
  skip http-500-chain     "no Chromium — the chain's L1 half is not exercised"
fi
verdict login-wall        chain /login             4 skip F-AUTH builtin-browser-vault
verdict login-attrs       chain /login-attrs       4 skip F-AUTH builtin-browser-vault
verdict login-ja          chain /login-ja          4 skip F-AUTH builtin-browser-vault

# --- L1 lane: pages that only exist after the browser runs ------------------
if [ $HAVE_CHROME = 1 ]; then
  verdict js-rendered     chain /js              0 ok   -      none L1:ok
  verdict dynamic-login   chain /dynamic-login   4 skip F-AUTH builtin-browser-vault L1:F-AUTH
  verdict empty-shell     chain /empty           3 fail F-EMPTY builtin-browser L1:F-EMPTY
else
  skip js-rendered   "no Chromium — run pickle-bootstrap.sh, then re-run"
  skip dynamic-login "no Chromium"
  skip empty-shell   "no Chromium"
fi

# --- password refusal: the CLI must refuse and must not echo the secret -----
SECRET="pw-selftest-$RANDOM$RANDOM"
out=$(PU_SETTLE=0 bash "$HERE/run.sh" type "$BASE/login" 'input[type=password]' "$SECRET" 2>&1); trc=$?
line="$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)"
if [ $HAVE_CHROME = 0 ]; then
  skip type-password "no Chromium — requires the browser layer"
elif [ $trc -ne 1 ]; then
  fail type-password "exit $trc (expected 1)"
elif ! printf '%s\n' "$line" | grep -q 'code=F-AUTH'; then
  fail type-password "verdict was: ${line:-<none>}"
elif printf '%s' "$out" | grep -q "$SECRET"; then
  fail type-password "the typed secret appeared in output"
else
  pass type-password "exit 1 F-AUTH, secret not echoed"
fi

echo "----"
echo "selftest: PASS=$NPASS FAIL=$NFAIL SKIP=$NSKIP"
[ "$NFAIL" -eq 0 ]
