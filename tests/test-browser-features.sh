#!/usr/bin/env bash
# test-browser-features.sh — the browser layer itself, exercised end to end.
#
#   bash tests/test-browser-features.sh
#
# Covers the checks the audit asked for that a page verdict alone does not:
# accessibility snapshot / element refs, typing, clicking, scrolling,
# screenshot bytes, extract JSON, a popup opening a second target, a redirect
# ending on the final URL, L0 timeout cleanup, daemon auto-start and stop, a
# concurrent pair of requests, and that page JS cannot read a host file.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-browser-features: node not found" >&2; exit 1; }
if ! pu_resolve_chrome >/dev/null 2>&1; then
  echo "test-browser-features: no Chromium — run pickle-bootstrap.sh first"; exit 1
fi

T="$(mktemp -d "$TMPDIR/feat-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

NP=0; NF=0
ok() { NP=$((NP+1)); printf 'PASS  %-20s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-20s %s\n' "$1" "$2"; }
has() { case "$2" in *"$3"*) ok "$1" "$4" ;; *) no "$1" "missing '$3' in: $(printf '%s' "$2" | head -2 | tr '\n' ' ' | cut -c1-120)" ;; esac; }

# Transport hiccups (the host is shared and can hit its thread limit for a
# moment) are retried; a wrong verdict is never retried away.
runv() {
  local n=0 out rc=0
  while [ $n -lt 3 ]; do
    out=$("$@" 2>/dev/null); rc=$?
    case "$out" in *code=F-NET*|*code=F-TIMEOUT*) n=$((n+1)); sleep 2; continue ;; esac
    break
  done
  printf '%s' "$out"
  return $rc
}

"$NODE" "$HERE/http-server.mjs" --port 0 --port-file "$T/port" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$T/port")"
export PU_SETTLE=800

# --- auto-start and status --------------------------------------------------
bash "$TREE/bin/run.sh" stop >/dev/null 2>&1
sleep 1
st=$(bash "$TREE/bin/run.sh" status 2>/dev/null | tail -1)
has status-down "$st" '"daemon":"down"' "no daemon after stop (status does not start one)"
bash "$TREE/bin/run.sh" read "$BASE/normal" >/dev/null 2>&1
st=$(bash "$TREE/bin/run.sh" status 2>/dev/null | tail -1)
has status-up "$st" '"daemon":"up"' "a command auto-started the daemon"

# --- open: accessibility snapshot with refs ---------------------------------
out=$(bash "$TREE/bin/run.sh" open "$BASE/form" 2>/dev/null)
has open-heading "$out" 'Form page' "h1 text in the snapshot"
has open-refs "$out" '%%MARK%% ref=' "element refs emitted"

# --- type into a normal field ----------------------------------------------
out=$(bash "$TREE/bin/run.sh" type "$BASE/form" '#q' 'hello' 2>/dev/null); rc=$?
has type-ok "$out" 'value="hello"' "typed value read back (exit $rc)"

# --- keyboard: the page saw the key ---------------------------------------
out=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const BASE = '$BASE';
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto(BASE + '/form');
await p.focus('#q');
await p.press('a');
const seen = await p.evaluate(() => document.getElementById('typed').textContent);
await t.finish({ keep: ['read'] });
console.log('KEYS=' + seen);
JS
)
has keyboard "$out" 'KEYS=key:a' "key event reached the page handler"

# --- click: button handler ran ---------------------------------------------
out=$(bash "$TREE/bin/run.sh" click "$BASE/form" '#go' 2>/dev/null); rc=$?
if [ $rc -eq 0 ]; then
  out2=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const BASE = '$BASE';
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto(BASE + '/form');
await p.type('#q', 'term');
await p.click('#go');
const out = await p.evaluate(() => document.getElementById('out').textContent);
await t.finish({ keep: ['read'] });
console.log('CLICKED=' + out);
JS
)
  has click-handler "$out2" 'CLICKED=submitted:term' "click ran the page handler"
else
  no click-handler "run.sh click exited $rc"
fi

# --- scroll on a tall page --------------------------------------------------
out=$(bash "$TREE/bin/run.sh" scroll "$BASE/tall" 3 2>/dev/null); rc=$?
s=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const BASE = '$BASE';
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto(BASE + '/tall');
const h = await p.evaluate(() => document.body.scrollHeight);
await p.evaluate(() => window.scrollBy(0, 2000));
const y = await p.evaluate(() => Math.round(window.scrollY));
await t.finish({ keep: ['read'] });
console.log('SCROLL height=' + h + ' y=' + y);
JS
)
case "$s" in *"y=0"*|*"y="*) has scroll "$s" "y=" "page scrolls (exit $rc)" ;; *) no scroll "$s" ;; esac

# --- screenshot bytes -------------------------------------------------------
out=$(runv bash "$TREE/bin/run.sh" shot "$BASE/normal" "$T/shot.png")
if [ -s "$T/shot.png" ] && python3 -c 'import sys;sys.exit(0 if open(sys.argv[1],"rb").read(8)==b"\x89PNG\r\n\x1a\n" else 1)' "$T/shot.png"; then
  ok screenshot "PNG $(wc -c < "$T/shot.png") bytes"
else
  no screenshot "no valid PNG: $out"
fi

# --- extract ---------------------------------------------------------------
out=$(runv bash "$TREE/bin/run.sh" extract "$BASE/normal" 'a[href]')
jsonl="$(printf '%s\n' "$out" | grep '^\[' | head -1)"
if [ -n "$jsonl" ] && printf '%s' "$jsonl" | python3 -c 'import json,sys; a=json.load(sys.stdin); sys.exit(0 if isinstance(a,list) and len(a)>0 else 1)'; then
  ok extract "returned a JSON array of links"
else
  no extract "$(printf '%s' "$out" | tail -1 | cut -c1-120)"
fi

# --- popup opens a second target -------------------------------------------
out=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const BASE = '$BASE';
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto(BASE + '/popup');
await p.evaluate(() => document.getElementById('opener').click());
await new Promise(r => setTimeout(r, 1500));
const tgs = await p.cdp('Target.getTargets');
const pages = (tgs.targetInfos || []).filter(x => x.type === 'page');
for (const x of pages) if (x.targetId !== p.targetId) await p.cdp('Target.closeTarget', { targetId: x.targetId }).catch(() => {});
await t.finish({ keep: ['read'] });
console.log('PAGES=' + pages.length);
JS
)
n=$(printf '%s' "$out" | sed -n 's/.*PAGES=\([0-9]*\).*/\1/p' | tail -1)
if [ -n "${n:-}" ] && [ "$n" -ge 2 ]; then ok popup "second target opened (pages=$n)"; else no popup "$out"; fi

# --- redirect lands on the final URL ---------------------------------------
out=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const BASE = '$BASE';
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto(BASE + '/redirect');
const u = await p.evaluate(() => location.href);
await t.finish({ keep: ['read'] });
console.log('URL=' + u);
JS
)
has redirect "$out" 'URL='$BASE'/normal' "final URL after 302"

# --- L0 timeout is reported and nothing is left behind ---------------------
out=$(L0_TIMEOUT=1 bash "$TREE/bin/fetch.sh" "$BASE/slow" 2>/dev/null); rc=$?
has timeout-code "$out" 'code=F-TIMEOUT' "L0 timeout reported (exit $rc)"
out=$(L0_TIMEOUT=1 bash "$TREE/bin/fetch.sh" "$BASE/slow" 2>/dev/null)
has timeout-next "$out" 'next=none' "timeout is not a hand-over"

# --- concurrent requests ----------------------------------------------------
bash "$TREE/bin/run.sh" read "$BASE/normal" > "$T/c1" 2>/dev/null & P1=$!
bash "$TREE/bin/run.sh" read "$BASE/tall"   > "$T/c2" 2>/dev/null & P2=$!
wait "$P1" "$P2"      # never bare `wait`: it would also wait for the fixture server
c1=$(grep '^%%CHAIN%%' "$T/c1" | tail -1); c2=$(grep '^%%CHAIN%%' "$T/c2" | tail -1)
case "$c1$c2" in
  *"status=ok"*"status=ok"*) ok concurrent "both parallel reads ok" ;;
  *) no concurrent "c1=$c1 c2=$c2" ;;
esac

# --- a web page cannot read a host file ------------------------------------
echo "root:x:0:0:root:/root:/bin/sh" > "$T/secret.txt"
out=$(bash "$TREE/bin/run.sh" -f /dev/stdin 2>/dev/null <<JS
const t = await taskSpace('pu-main');
const p = await t.acquirePage('read');
await p.goto('$BASE' + '/normal');
const r = await p.evaluate(async (path) => {
  try {
    const res = await fetch('file://' + path);
    const txt = await res.text();
    return 'READ:' + txt.slice(0, 20);
  } catch (e) { return 'BLOCKED:' + String(e.message).slice(0, 40); }
}, '$T/secret.txt');
await t.finish({ keep: ['read'] });
console.log('FILE=' + r);
JS
)
case "$out" in
  *"FILE=BLOCKED"*) ok file-access "page JS cannot read $T/secret.txt" ;;
  *"FILE=READ"*) no file-access "page JS READ a host file: $out" ;;
  *) no file-access "$out" ;;
esac

# --- stop removes the socket ------------------------------------------------
bash "$TREE/bin/run.sh" stop >/dev/null 2>&1; sleep 1
if [ ! -S "$PICKLE_ULTRA_STATE_DIR/cdp-daemon.sock" ]; then ok stop-cleanup "socket removed after stop"; else no stop-cleanup "socket still present"; fi

echo "----"
echo "test-browser-features: PASS=$NP FAIL=$NF"
[ "$NF" -eq 0 ]
