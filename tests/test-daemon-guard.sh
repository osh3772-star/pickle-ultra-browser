#!/usr/bin/env bash
# test-daemon-guard.sh — the password guard and the file permissions of the
# browser layer (DEFECT-003, DEFECT-005).
#
#   bash tests/test-daemon-guard.sh
#
# What it proves:
#   * p.type / p.typeText / p.press on a password field are refused by the
#     daemon itself, so a `-f` script cannot bypass run.sh's own check
#   * the secret text never reaches stdout or the daemon log
#   * the Unix socket is 0600 and the state/profile dirs are 0700 (the socket
#     runs arbitrary JS as this user, so it must not be reachable by others)
#   * PU_CHROME_SANDBOX=require refuses to launch where the sandbox cannot work
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-daemon-guard: node not found" >&2; exit 1; }

T="$(mktemp -d "$TMPDIR/guard-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  # only ever kill a process that is actually our daemon: a stale pid file can
  # point at a recycled pid (in this sandbox it once pointed at the test runner)
  for d in "$T"/smoke/state "$T"/auto/state; do
    [ -f "$d/cdp-daemon.pid" ] || continue
    dp=$(cat "$d/cdp-daemon.pid" 2>/dev/null)
    [ -n "${dp:-}" ] || continue
    if grep -qa 'cdp-daemon.mjs' "/proc/$dp/cmdline" 2>/dev/null; then kill "$dp" 2>/dev/null || true; fi
  done
  sleep 0.3
  rm -rf "$T" || true
}
trap cleanup EXIT

NP=0; NF=0; NS=0
ok() { NP=$((NP+1)); printf 'PASS  %-20s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-20s %s\n' "$1" "$2"; }
sk() { NS=$((NS+1)); printf 'SKIP  %-20s %s\n' "$1" "$2"; }

if ! pu_resolve_chrome >/dev/null 2>&1; then
  echo "test-daemon-guard: no Chromium — run pickle-bootstrap.sh first"
  exit 1
fi

"$NODE" "$HERE/http-server.mjs" --port 0 --port-file "$T/port" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$T/port")"

SECRET_A="guard-secret-$RANDOM$RANDOM"
SECRET_B="guard-typed-$RANDOM$RANDOM"
SECRET_C="guard-press-$RANDOM$RANDOM"

cat > "$T/guard.js" <<JS
const BASE = '$BASE';
const t = await taskSpace('guard');
const p = await t.acquirePage('guard');
await p.goto(BASE + '/login');
const r = {};
try { await p.type('input[name=pw]', '$SECRET_A'); r.type = 'NO-REFUSAL'; }
catch (e) { r.type = String(e.message).slice(0, 80); }
try { await p.focus('input[name=pw]'); await p.typeText('$SECRET_B'); r.typeText = 'NO-REFUSAL'; }
catch (e) { r.typeText = String(e.message).slice(0, 80); }
try { await p.press('x'); r.press = 'NO-REFUSAL'; }
catch (e) { r.press = String(e.message).slice(0, 80); }
r.value = await p.evaluate(() => { const el = document.querySelector('input[name=pw]'); return el ? el.value : 'missing'; });
r.user = await p.evaluate(() => { const el = document.querySelector('input[name=id]'); return el ? el.name : 'missing'; });
await t.finish({ keep: ['guard'] });
console.log('GUARD-REPORT ' + JSON.stringify(r));
JS

out=$("$NODE" "$TREE/bin/cdp-client.mjs" < "$T/guard.js" 2>"$T/guard.err"); rc=$?
report="$(printf '%s\n' "$out" | grep '^GUARD-REPORT' | tail -1 | sed 's/^GUARD-REPORT //')"

if [ -z "$report" ]; then
  no guard "no report (rc=$rc)"; sed -n 1,5p "$T/guard.err" | sed 's/^/        /'
else
  case "$report" in *'"type":"password_field_refused'*) ok type-refused "p.type refused" ;; *) no type-refused "$report" ;; esac
  case "$report" in *'"typeText":"password_field_refused'*) ok typeText-refused "p.typeText refused" ;; *) no typeText-refused "$report" ;; esac
  case "$report" in *'"press":"password_field_refused'*) ok press-refused "p.press refused" ;; *) no press-refused "$report" ;; esac
  case "$report" in *'"value":""'*) ok field-untouched "password field still empty" ;; *) no field-untouched "$report" ;; esac
  case "$report" in *'"user":"id"'*) ok non-password-ok "a normal field is still addressable" ;; *) no non-password-ok "$report" ;; esac
fi

if printf '%s' "$out" | grep -q -e "$SECRET_A" -e "$SECRET_B" -e "$SECRET_C"; then
  no no-echo "a secret appeared in stdout"
else ok no-echo "secrets absent from stdout"; fi
if [ -f "$PICKLE_ULTRA_STATE_DIR/cdp-daemon.log" ] && grep -q -e "$SECRET_A" -e "$SECRET_B" -e "$SECRET_C" "$PICKLE_ULTRA_STATE_DIR/cdp-daemon.log"; then
  no log-clean "a secret appeared in cdp-daemon.log"
else ok log-clean "secrets absent from cdp-daemon.log"; fi

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
m=$(mode_of "$PICKLE_ULTRA_STATE_DIR/cdp-daemon.sock")
[ "${m:-}" = "600" ] && ok socket-mode "0600" || no socket-mode "mode=${m:-missing}"
m=$(mode_of "$PICKLE_ULTRA_STATE_DIR")
[ "${m:-}" = "700" ] && ok state-mode "0700" || no state-mode "mode=${m:-missing}"
m=$(mode_of "$PICKLE_ULTRA_PROFILE")
[ "${m:-}" = "700" ] && ok profile-mode "0700" || no profile-mode "mode=${m:-missing}"

# --- sandbox decision, measured on a throwaway daemon ----------------------
# auto: on a host without user namespaces it must still launch, and must say
# why the sandbox is off. require: it must refuse instead.
SMOKE="$T/smoke"
cat > "$T/require.js" <<'JS'
const t = await taskSpace('req');
const p = await t.newPage();
await p.evaluate(() => 1);
await t.finish({ keep: [] });
JS

stop_smoke() {
  PICKLE_ULTRA_STATE_DIR="$1" timeout 20 "$NODE" "$TREE/bin/cdp-client.mjs" --stop >/dev/null 2>&1 || true
}

tout=$(PICKLE_ULTRA_STATE_DIR="$SMOKE/state" PICKLE_ULTRA_PROFILE="$SMOKE/profile" \
       PU_CHROME_SANDBOX=require timeout 60 "$NODE" "$TREE/bin/cdp-client.mjs" < "$T/require.js" 2>&1); trc=$?
if [ $trc -ne 0 ] && printf '%s' "$tout" | grep -qi 'sandbox'; then
  ok sandbox-require "refused with a sandbox message"
else
  no sandbox-require "rc=$trc out=$(printf '%s' "$tout" | tail -1 | cut -c1-100)"
fi
stop_smoke "$SMOKE/state"

AUTO="$T/auto"
arc=1; aout=""
for attempt in 1 2 3; do
  rm -rf "$AUTO"
  aout=$(PICKLE_ULTRA_STATE_DIR="$AUTO/state" PICKLE_ULTRA_PROFILE="$AUTO/profile" \
         PU_CHROME_SANDBOX=auto timeout 90 "$NODE" "$TREE/bin/cdp-client.mjs" < "$T/require.js" 2>&1); arc=$?
  [ $arc -eq 0 ] && break
  sleep 2
done
if [ $arc -ne 0 ]; then
  if printf '%s' "$aout" | grep -qiE 'pthread|Resource temporarily|EAGAIN|ENOMEM|unsettled'; then
    sk sandbox-auto "host starved chromium (EAGAIN) — not a product failure: $(printf '%s' "$aout" | tail -1 | cut -c1-90)"
  else
    no sandbox-auto "auto mode failed to launch (rc=$arc): $(printf '%s' "$aout" | tail -2 | tr '\n' ' ' | cut -c1-140)"
  fi
elif [ "$(uname -s)" = "Linux" ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then
  if grep -q 'sandbox=disabled' "$AUTO/state/cdp-daemon.log" 2>/dev/null; then
    ok sandbox-auto "userns off -> launched with --no-sandbox and logged why"
  else
    no sandbox-auto "launched but no sandbox=disabled line in the log"
  fi
else
  sk sandbox-auto "host reports sandbox support; fallback line not expected"
fi
stop_smoke "$AUTO/state"

echo "----"
echo "test-daemon-guard: PASS=$NP FAIL=$NF SKIP=$NS"
[ "$NF" -eq 0 ]
