#!/usr/bin/env bash
# test-vault-login.sh — regression tests for bin/vault-login.mjs (PUB-301/302/
# 304/305/307). No real account, no real vault: a throwaway fixture server
# (tests/login-server.mjs), a throwaway vault and a state dir under /tmp.
#
#   bash tests/test-vault-login.sh
#
# What it proves:
#   * the entry's site and the URL host must agree (https, except loopback) —
#     refused as origin_mismatch before anything is opened
#   * a symlink at --state-file / --wait-answer-file is refused
#   * right credentials -> status=logged_in; wrong ones -> login_failed
#   * a submit that lands on another host -> origin_mismatch, not "success"
#   * the --wait-answer-file bridge drives a CAPTCHA step to completion
#   * the password and the URL query never appear in stdout or the state file,
#     and state/screenshot files are 0600
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-vault-login: node not found" >&2; exit 1; }
VAULT_PY="$TREE/agent-vault/vault.py"

# Isolated scratch space, explicitly under /tmp: no .state, no real vault.
T="$(mktemp -d /tmp/vault-login-XXXXXX)" || exit 1
TMPDIR="$T"; export TMPDIR
VAULT="$T/vault"
STATE="$T/state"
export PICKLE_ULTRA_STATE_DIR="$STATE"
export PICKLE_ULTRA_PROFILE="$T/profile"
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  PICKLE_ULTRA_STATE_DIR="$STATE" "$NODE" "$TREE/bin/cdp-client.mjs" --stop >/dev/null 2>&1 || true
  sleep 0.5
  rm -rf "$T" || true
}
trap cleanup EXIT

NP=0; NF=0; NS=0
ok() { NP=$((NP+1)); printf 'PASS  %-20s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-20s %s\n' "$1" "$2"; }
sk() { NS=$((NS+1)); printf 'SKIP  %-20s %s\n' "$1" "$2"; }

USER_NAME="alice"
SECRET="pw-fixture-$RANDOM$RANDOM"
TOKEN="tok-$RANDOM$RANDOM"
OUT=""; RC=0
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

"$NODE" "$HERE/login-server.mjs" --port-file "$T/port" --user "$USER_NAME" --pw "$SECRET" --captcha 1234 \
  > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT="$(cat "$T/port" 2>/dev/null || true)"
if [ -z "$PORT" ]; then
  echo "test-vault-login: fixture server did not start" >&2
  cat "$T/server.log" >&2
  exit 1
fi
BASE="http://127.0.0.1:$PORT"

# run_login [args...] -> $OUT (stdout), $RC
run_login() {
  OUT=$(PU_VAULT_DIR="$VAULT" timeout 150 "$NODE" "$TREE/bin/vault-login.mjs" "$@" 2>"$T/last.err")
  RC=$?
}

# ---------------------------------------------------------------- origin gate
run_login "$BASE/login" example.com
if [ "$RC" -ne 0 ] && has "$OUT" '"status":"origin_mismatch"' && has "$OUT" '"reason":"host_mismatch"'; then
  ok origin-host-mismatch "site=example.com vs host=127.0.0.1 refused before launch"
else
  no origin-host-mismatch "rc=$RC out=$OUT"
fi

run_login "http://example.com/login" example.com
if [ "$RC" -ne 0 ] && has "$OUT" '"reason":"insecure_scheme"'; then
  ok origin-plain-http "plain http to a non-loopback host refused"
else
  no origin-plain-http "rc=$RC out=$OUT"
fi

run_login "https://login.example.net/enter" example.com
if [ "$RC" -ne 0 ] && has "$OUT" '"reason":"host_mismatch"'; then
  ok origin-other-host "unrelated https host refused"
else
  no origin-other-host "rc=$RC out=$OUT"
fi

# ------------------------------------------------- symlinked output paths
mkdir -p "$T/sy"
: > "$T/sy/real-state"
ln -s "$T/sy/real-state" "$T/sy/state-link"
run_login "$BASE/login" 127.0.0.1 --state-file "$T/sy/state-link"
if [ "$RC" -ne 0 ] && has "$OUT" '"status":"unsafe_path"' && has "$OUT" '"reason":"symlink"'; then
  ok symlink-state "symlinked --state-file refused"
else
  no symlink-state "rc=$RC out=$OUT"
fi

: > "$T/sy/real-answer"
ln -s "$T/sy/real-answer" "$T/sy/answer-link"
run_login "$BASE/login" 127.0.0.1 --wait-answer-file "$T/sy/answer-link"
if [ "$RC" -ne 0 ] && has "$OUT" '"status":"unsafe_path"'; then
  ok symlink-answer "symlinked --wait-answer-file refused"
else
  no symlink-answer "rc=$RC out=$OUT"
fi

# ---------------------------------------------------------------- browser cases
if ! pu_resolve_chrome >/dev/null 2>&1; then
  sk browser-login "no Chromium — browser cases skipped"
else
  PU_VAULT_DIR="$VAULT" python3 "$VAULT_PY" init >/dev/null || {
    echo "test-vault-login: cannot initialise a throwaway vault" >&2; exit 1; }

  # A matching loopback URL passes the gate. The value has no TAB and no JSON,
  # so no username/password can be parsed -> missing_credentials: proof the
  # gate let it through and nothing was typed.
  printf '%s\n' "single-token-value" | PU_VAULT_DIR="$VAULT" python3 "$VAULT_PY" store 127.0.0.1 --purpose "gate probe" >/dev/null
  run_login "$BASE/login" 127.0.0.1
  if has "$OUT" '"status":"missing_credentials"'; then
    ok loopback-allowed "http://127.0.0.1 accepted, then missing_credentials"
  else
    no loopback-allowed "rc=$RC out=$(printf '%s' "$OUT" | head -c 300)"
  fi

  printf '%s\t%s\n' "$USER_NAME" "$SECRET" | PU_VAULT_DIR="$VAULT" python3 "$VAULT_PY" store 127.0.0.1 --force --purpose "fixture login" >/dev/null

  # --- success -------------------------------------------------------------
  run_login "$BASE/login?token=$TOKEN" 127.0.0.1 --state-file "$T/ok.json" --shot "$T/ok.png"
  if [ "$RC" -eq 0 ] && has "$OUT" '"status":"logged_in"'; then
    ok login-success "correct entry -> status=logged_in"
  else
    no login-success "rc=$RC out=$(printf '%s' "$OUT" | head -c 400)"
  fi
  if [ -f "$T/ok.json" ] && [ "$(stat -c '%a' "$T/ok.json" 2>/dev/null)" = "600" ]; then
    ok state-mode "state file is 0600"
  else
    no state-mode "mode=$(stat -c '%a' "$T/ok.json" 2>/dev/null || echo missing)"
  fi
  if ! has "$OUT" "$SECRET" && ! { [ -f "$T/ok.json" ] && grep -q "$SECRET" "$T/ok.json"; }; then
    ok secret-hidden "password never printed or written"
  else
    no secret-hidden "the fixture password appeared in output/state"
  fi
  if ! has "$OUT" "$TOKEN" && ! { [ -f "$T/ok.json" ] && grep -q "$TOKEN" "$T/ok.json"; }; then
    ok query-stripped "URL query dropped from output and state"
  else
    no query-stripped "the token appeared in output/state"
  fi

  # --- wrong password ------------------------------------------------------
  printf '%s\t%s\n' "$USER_NAME" "wrong-$SECRET" | PU_VAULT_DIR="$VAULT" python3 "$VAULT_PY" store 127.0.0.1 --force --purpose "fixture login (wrong)" >/dev/null
  run_login "$BASE/login" 127.0.0.1 --state-file "$T/bad.json"
  if [ "$RC" -eq 0 ] && has "$OUT" '"status":"login_failed"'; then
    ok login-failure "wrong password -> status=login_failed (not success)"
  else
    no login-failure "rc=$RC out=$(printf '%s' "$OUT" | head -c 400)"
  fi

  # --- a submit that lands on another host --------------------------------
  run_login "$BASE/escape" 127.0.0.1 --state-file "$T/esc.json"
  if [ "$RC" -eq 0 ] && has "$OUT" '"status":"origin_mismatch"' && has "$OUT" '"reason":"host_mismatch"'; then
    ok post-submit-escape "foreign host after submit -> origin_mismatch (not logged_in)"
  else
    no post-submit-escape "rc=$RC out=$(printf '%s' "$OUT" | head -c 400)"
  fi

  # --- CAPTCHA bridge ------------------------------------------------------
  printf '%s\t%s\n' "$USER_NAME" "$SECRET" | PU_VAULT_DIR="$VAULT" python3 "$VAULT_PY" store 127.0.0.1 --force --purpose "fixture login" >/dev/null
  rm -f "$T/ans.txt" "$T/cap.json" "$T/cap.png" "$T/cap.rc"
  (
    PU_VAULT_DIR="$VAULT" timeout 150 "$NODE" "$TREE/bin/vault-login.mjs" "$BASE/captcha" 127.0.0.1 \
      --wait-answer-file "$T/ans.txt" --state-file "$T/cap.json" --shot "$T/cap.png" --wait-timeout 90 \
      > "$T/cap.out" 2>"$T/cap.err"
    echo $? > "$T/cap.rc"
  ) &
  CAP_PID=$!
  CAP_SEEN=0
  for i in $(seq 1 200); do
    if [ -f "$T/cap.json" ] && grep -q '"status":"captcha"' "$T/cap.json" 2>/dev/null; then CAP_SEEN=1; break; fi
    kill -0 "$CAP_PID" 2>/dev/null || break
    sleep 0.25
  done
  if [ "$CAP_SEEN" = "1" ]; then
    ok wait-answer-wait "state file reported captcha and waited for the answer"
    printf '1234\n' > "$T/ans.txt"
    wait "$CAP_PID" 2>/dev/null
    CAPOUT="$(cat "$T/cap.out" 2>/dev/null)"
    CAPRC="$(cat "$T/cap.rc" 2>/dev/null || echo 1)"
    if [ "$CAPRC" = "0" ] && has "$CAPOUT" '"status":"logged_in"'; then
      ok wait-answer-login "answer file -> status=logged_in"
    else
      no wait-answer-login "rc=$CAPRC out=$(printf '%s' "$CAPOUT" | head -c 400)"
    fi
    if [ -f "$T/cap.png" ] && [ "$(stat -c '%a' "$T/cap.png" 2>/dev/null)" = "600" ]; then
      ok shot-mode "CAPTCHA screenshot is 0600"
    else
      no shot-mode "mode=$(stat -c '%a' "$T/cap.png" 2>/dev/null || echo missing)"
    fi
    if ! has "$CAPOUT" "$SECRET" && ! { [ -f "$T/cap.json" ] && grep -q "$SECRET" "$T/cap.json"; }; then
      ok captcha-secret-hidden "password never printed during the bridge"
    else
      no captcha-secret-hidden "password appeared during the bridge"
    fi
  else
    kill "$CAP_PID" 2>/dev/null || true
    wait "$CAP_PID" 2>/dev/null
    no wait-answer-wait "no captcha state (out=$(printf '%s' "$(cat "$T/cap.out" 2>/dev/null)" | head -c 300))"
  fi

  # --- two clients starting the daemon at once (PUB-205) -------------------
  # One Chrome at a time: this sandbox has ulimit -u=256 and a second browser
  # tree is itself a resource failure. So the previous daemon is stopped first
  # and the two clients race for ONE fresh daemon, which is the case the lock
  # is for.
  PICKLE_ULTRA_STATE_DIR="$STATE" "$NODE" "$TREE/bin/cdp-client.mjs" --stop >/dev/null 2>&1 || true
  sleep 1
  LOCKSTATE="$T/lock-state"
  printf 'const t = await taskSpace("lockprobe"); const p = await t.acquirePage("p"); console.log("ok"); await t.finish({keep:[p]});\n' > "$T/probe.js"
  # A separate profile as well as a separate state dir: one Chrome profile
  # cannot be open twice, and that would mask a lock failure as a profile error.
  PICKLE_ULTRA_STATE_DIR="$LOCKSTATE" PICKLE_ULTRA_PROFILE="$T/lock-profile" timeout 150 "$NODE" "$TREE/bin/cdp-client.mjs" < "$T/probe.js" > "$T/l1.out" 2>&1 &
  LA=$!
  PICKLE_ULTRA_STATE_DIR="$LOCKSTATE" PICKLE_ULTRA_PROFILE="$T/lock-profile" timeout 150 "$NODE" "$TREE/bin/cdp-client.mjs" < "$T/probe.js" > "$T/l2.out" 2>&1 &
  LB=$!
  wait "$LA"; RA=$?
  wait "$LB"; RB=$?
  LAUNCHES=$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*sandbox=' "$LOCKSTATE/cdp-daemon.log" 2>/dev/null || echo 0)
  if [ "$RA" -eq 0 ] && [ "$RB" -eq 0 ] && [ "$LAUNCHES" = "1" ] && [ ! -d "$LOCKSTATE/daemon.start.lock" ]; then
    ok concurrent-start "two clients -> one daemon launch, lock cleaned up"
  else
    no concurrent-start "rc=$RA/$RB launches=$LAUNCHES lock=$( [ -d "$LOCKSTATE/daemon.start.lock" ] && echo left || echo gone ) out=$(head -c 200 "$T/l1.out" "$T/l2.out" 2>/dev/null | tr '\n' ' ')"
  fi
  PICKLE_ULTRA_STATE_DIR="$LOCKSTATE" "$NODE" "$TREE/bin/cdp-client.mjs" --stop >/dev/null 2>&1 || true
fi

echo "----"
echo "test-vault-login: PASS=$NP FAIL=$NF SKIP=$NS"
[ "$NF" -eq 0 ]
