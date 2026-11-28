#!/usr/bin/env bash
# test-detect-failure.sh — a verdict-engine failure must never look like a
# normal page (PUB-203).
#
#   bash tests/test-detect-failure.sh
#
# "-" means "the engine judged this page and found no block". When the engine
# crashes, prints nothing, prints broken JSON or an unknown code, the callers
# must report F-DETECT instead. PU_DETECT_ENGINE is the test seam that swaps
# the engine for a failing one without touching the tree.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-detect-failure: node not found" >&2; exit 1; }

T="$(mktemp -d /tmp/vl-detect-XXXXXX)" || exit 1
TMPDIR="$T"; export TMPDIR
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  PICKLE_ULTRA_STATE_DIR="$T/state" "$NODE" "$TREE/bin/cdp-client.mjs" --stop >/dev/null 2>&1 || true
  sleep 0.3
  rm -rf "$T" || true
}
trap cleanup EXIT

NP=0; NF=0; NS=0
ok() { NP=$((NP+1)); printf 'PASS  %-20s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-20s %s\n' "$1" "$2"; }
sk() { NS=$((NS+1)); printf 'SKIP  %-20s %s\n' "$1" "$2"; }

"$NODE" "$HERE/http-server.mjs" --port-file "$T/port" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT="$(cat "$T/port" 2>/dev/null || true)"
[ -n "$PORT" ] || { echo "test-detect-failure: fixture server did not start" >&2; exit 1; }
BASE="http://127.0.0.1:$PORT"

# --- engine-level contract -------------------------------------------------
printf '<html><head><title>ok</title></head><body><p>%s</p></body></html>' \
  "$(printf 'normal body text %.0s' $(seq 1 20))" > "$T/normal.html"

code=$(python3 "$TREE/bin/detect-page.py" --mode l0 --html "$T/normal.html" --http 200 | tr -d '\n')
case "$code" in
  *'"code": "-"'*) ok engine-ok "real engine still answers a normal page with -" ;;
  *) no engine-ok "got: $code" ;;
esac

printf 'this is not json\n' > "$T/bad-dom.json"
python3 "$TREE/bin/detect-page.py" --mode l1 --dom "$T/bad-dom.json" >/dev/null 2>"$T/e1"
rc=$?
[ "$rc" -ne 0 ] && ok engine-bad-dom "malformed DOM facts -> non-zero exit ($rc)" || no engine-bad-dom "exit 0"

# --- shim: detect-code.sh --------------------------------------------------
printf 'plain text about a page %.0s' $(seq 1 30) > "$T/text.txt"
code=$(bash "$TREE/bin/detect-code.sh" "$T/text.txt")
[ "$code" = "-" ] && ok shim-normal "normal text -> -" || no shim-normal "got '$code'"

code=$(PU_DETECT_ENGINE=/bin/false bash "$TREE/bin/detect-code.sh" "$T/text.txt")
[ "$code" = "F-DETECT" ] && ok shim-failing-engine "engine crash -> F-DETECT" || no shim-failing-engine "got '$code'"

# a broken engine also has to come through pu_detect_auth, which only ever
# reported F-AUTH or "-" before
out=$(PU_DETECT_ENGINE=/bin/false bash -c ". '$TREE/bin/detect-code.sh'; pu_detect_auth '$T/normal.html'")
[ "$out" = "F-DETECT" ] && ok shim-auth "pu_detect_auth -> F-DETECT" || no shim-auth "got '$out'"

# --- fetch.sh (L0) ---------------------------------------------------------
out=$(PICKLE_ULTRA_STATE_DIR="$T/state" timeout 60 bash "$TREE/bin/fetch.sh" "$BASE/normal" 2>/dev/null)
line=$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)
case "$line" in
  *"status=ok"*"code=-"*) ok fetch-normal "normal page -> status=ok code=-" ;;
  *) no fetch-normal "$line" ;;
esac

out=$(PICKLE_ULTRA_STATE_DIR="$T/state" PU_DETECT_ENGINE=/bin/false timeout 60 bash "$TREE/bin/fetch.sh" "$BASE/normal" 2>/dev/null)
line=$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)
case "$line" in
  *"status=fail"*"code=F-DETECT"*) ok fetch-engine "engine crash -> status=fail code=F-DETECT" ;;
  *) no fetch-engine "$line" ;;
esac

# --- run.sh (L1) -----------------------------------------------------------
if pu_resolve_chrome >/dev/null 2>&1; then
  # One daemon warm-up first: without it a cold ECONNREFUSED would be reported
  # as F-NET and hide what this case is about.
  PICKLE_ULTRA_STATE_DIR="$T/state" timeout 60 bash "$TREE/bin/run.sh" warm >/dev/null 2>&1 || true
  out=$(PICKLE_ULTRA_STATE_DIR="$T/state" PU_SETTLE=500 timeout 120 bash "$TREE/bin/run.sh" read "$BASE/normal" 2>/dev/null)
  line=$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)
  case "$line" in
    *"status=ok"*"code=-"*) ok l1-normal "L1 normal page -> status=ok code=-" ;;
    *) no l1-normal "$line" ;;
  esac

  out=$(PICKLE_ULTRA_STATE_DIR="$T/state" PU_SETTLE=500 PU_DETECT_ENGINE=/bin/false timeout 120 bash "$TREE/bin/run.sh" read "$BASE/normal" 2>/dev/null)
  line=$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)
  case "$line" in
    *"status=fail"*"code=F-DETECT"*) ok l1-engine "engine crash -> status=fail code=F-DETECT" ;;
    *) no l1-engine "$line" ;;
  esac
else
  sk l1-normal "no Chromium"
  sk l1-engine "no Chromium"
fi

echo "----"
echo "test-detect-failure: PASS=$NP FAIL=$NF SKIP=$NS"
[ "$NF" -eq 0 ]
