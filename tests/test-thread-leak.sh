#!/usr/bin/env bash
# test-thread-leak.sh — a warm daemon must not grow per call.
#
#   bash tests/test-thread-leak.sh [cycles]        (default 12)
#
# Measured on 2026-11-27 (before the fix): every `read` added one renderer
# process and ~12 threads (151 → 163 → 175 → 187 → 199 → 211 …). At
# ulimit -u=256 the daemon then died with `pthread_create: Resource
# temporarily unavailable` after 5–6 operations — the exact reason this test
# exists. After switching to a reused warm tab (cdp-daemon acquirePage) the
# same loop stays flat.
#
# Passes when: every read succeeds, the thread count stays within +15 of the
# baseline, and renderer processes do not accumulate.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-thread-leak: node not found" >&2; exit 1; }
CYCLES="${1:-12}"
[ "$(uname -s)" = "Linux" ] || { echo "test-thread-leak: /proc-based check (Linux only) — SKIP"; exit 0; }
if ! pu_resolve_chrome >/dev/null 2>&1; then
  echo "test-thread-leak: no Chromium — SKIP"; exit 0
fi

T="$(mktemp -d "$TMPDIR/leak-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

"$NODE" "$HERE/http-server.mjs" --port 0 --port-file "$T/port" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$T/port")"

stat_json() { python3 "$HERE/threads.py" --json; }
field() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$2"; }

# A fresh daemon for this run, so the baseline is ours.
bash "$TREE/bin/run.sh" stop >/dev/null 2>&1
sleep 1
if ! PU_SETTLE=200 bash "$TREE/bin/run.sh" warm >/dev/null 2>&1; then
  echo "test-thread-leak: daemon did not start — SKIP (environment)"
  exit 0
fi
BASE_JSON=$(stat_json)
base_threads=$(field "$BASE_JSON" threads); base_rend=$(field "$BASE_JSON" renderers)
echo "baseline: threads=$base_threads renderers=$base_rend"

OK=0; FAILED=0; LAST=""
for i in $(seq 1 "$CYCLES"); do
  line=""
  for attempt in 1 2 3; do
    out=$(PU_SETTLE=200 timeout 60 bash "$TREE/bin/run.sh" read "$BASE/normal" 2>/dev/null)
    line=$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)
    case "$line" in *"status=ok"*) break ;; esac
    sleep 1     # transient EAGAIN under a loaded host: retry, do not mask
  done
  case "$line" in
    *"status=ok"*) OK=$((OK+1)) ;;
    *) FAILED=$((FAILED+1)); LAST="$line" ;;
  esac
done

END_JSON=$(stat_json)
end_threads=$(field "$END_JSON" threads); end_rend=$(field "$END_JSON" renderers)
echo "after ${CYCLES}: threads=$end_threads renderers=$end_rend ok=$OK failed=$FAILED"

NP=0; NF=0
ok() { NP=$((NP+1)); printf 'PASS  %-18s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-18s %s\n' "$1" "$2"; }

[ "$FAILED" -eq 0 ] && ok all-reads "$OK/$CYCLES ok" || no all-reads "$FAILED failed; last: $LAST"
[ $((end_threads - base_threads)) -le 15 ] && ok threads-bounded "+$((end_threads - base_threads)) threads" \
  || no threads-bounded "+$((end_threads - base_threads)) threads (limit +15)"
[ $((end_rend - base_rend)) -le 2 ] && ok renderers-bounded "+$((end_rend - base_rend)) renderers" \
  || no renderers-bounded "+$((end_rend - base_rend)) renderers (limit +2)"

echo "----"
echo "test-thread-leak: PASS=$NP FAIL=$NF"
[ "$NF" -eq 0 ]
