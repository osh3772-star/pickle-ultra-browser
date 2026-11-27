#!/usr/bin/env bash
# bench.sh — measured numbers for the README, nothing invented.
#
#   bash tests/bench.sh [runs]        (default 30)
#
# What is measured, on the local fixture server (loopback, so the network is
# not the variable):
#   cold   — `run.sh read` with no daemon: Chromium launch + navigation
#   warm   — the same read with the daemon already up (warm-tab reuse)
#   memory — RSS of the whole daemon tree (daemon + Chromium) after the loop
#   cpu    — utime+stime of that tree over the measured wall time
#   success — ok verdicts / attempts
# What is NOT here: the calling agent's own thinking time and token use. Those
# happen outside this tree and are not measurable from inside it; the numbers
# below are the browser + CLI cost only.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "bench: node not found" >&2; exit 1; }
RUNS="${1:-30}"

T="$(mktemp -d "$TMPDIR/bench-XXXXXX")" || exit 1
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

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
tree_rss_kb() { python3 "$HERE/threads.py" --json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
tot=0
for p in d.get("detail",[]):
    try:
        with open("/proc/%d/status"%p["pid"]) as f:
            for line in f:
                if line.startswith("VmRSS:"): tot+=int(line.split()[1]); break
    except OSError: pass
print(tot)' ; }
tree_cpu_ticks() { python3 "$HERE/threads.py" --json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
tot=0
for p in d.get("detail",[]):
    try:
        with open("/proc/%d/stat"%p["pid"]) as f:
            parts=f.read().rsplit(")",1)[1].split()
        tot+=int(parts[11])+int(parts[12])
    except OSError: pass
print(tot)' ; }

echo "bench: $RUNS warm reads of $BASE/normal"
bash "$TREE/bin/run.sh" stop >/dev/null 2>&1; sleep 1

# --- cold: daemon + Chromium launch included --------------------------------
: > "$T/cold.txt"
for i in 1 2 3; do
  bash "$TREE/bin/run.sh" stop >/dev/null 2>&1; sleep 1
  t0=$(now_ms); out=$(bash "$TREE/bin/run.sh" read "$BASE/normal" 2>/dev/null); t1=$(now_ms)
  case "$out" in *"status=ok"*) echo $(( t1 - t0 )) >> "$T/cold.txt" ;; *) echo "cold fail" >&2 ;; esac
done

# --- warm: 30 consecutive reads -------------------------------------------
: > "$T/warm.txt"
OK=0; FAIL=0
cpu0=$(tree_cpu_ticks); w0=$(now_ms)
for i in $(seq 1 "$RUNS"); do
  t0=$(now_ms); out=$(bash "$TREE/bin/run.sh" read "$BASE/normal" 2>/dev/null); t1=$(now_ms)
  case "$out" in
    *"status=ok"*) OK=$((OK+1)); echo $(( t1 - t0 )) >> "$T/warm.txt" ;;
    *) FAIL=$((FAIL+1)) ;;
  esac
done
w1=$(now_ms); cpu1=$(tree_cpu_ticks)
RSS=$(tree_rss_kb)
TICKS_PER_SEC=$(python3 -c 'import os; print(os.sysconf("SC_CLK_TCK"))')

python3 - "$T/cold.txt" "$T/warm.txt" "$OK" "$FAIL" "$RSS" "$cpu0" "$cpu1" "$w0" "$w1" "$TICKS_PER_SEC" <<'PY'
import json, statistics, sys
cold_f, warm_f, ok, fail, rss, c0, c1, w0, w1, hz = sys.argv[1:11]
def nums(p):
    try: return sorted(float(x) for x in open(p).read().split())
    except OSError: return []
cold, warm = nums(cold_f), nums(warm_f)
def stats(v):
    if not v: return {}
    v = sorted(v)
    k = max(1, int(round(0.95 * len(v))) - 1)
    return {"n": len(v), "mean": round(sum(v)/len(v)), "median": round(statistics.median(v)),
            "p95": round(v[k]), "max": round(v[-1]), "min": round(v[0])}
wall = (int(w1) - int(w0)) / 1000.0
cpu = (int(c1) - int(c0)) / float(hz)
out = {
  "runs": len(warm), "ok": int(ok), "fail": int(fail),
  "success_rate": round(100.0 * int(ok) / max(1, int(ok) + int(fail)), 1),
  "cold_ms": stats(cold), "warm_ms": stats(warm),
  "daemon_tree_rss_mb": round(int(rss) / 1024.0, 1),
  "cpu_seconds_over_wall": round(cpu, 2), "wall_seconds": round(wall, 1),
  "cpu_percent_of_one_core": round(100.0 * cpu / wall, 1) if wall else None,
}
print(json.dumps(out, indent=1, ensure_ascii=False))
open(__file__.replace("bench.sh", "bench.json") if False else "bench.json", "w").write(json.dumps(out, indent=1))
PY

cp bench.json "$TREE/.tmp/bench.json" 2>/dev/null || true
rm -f bench.json
echo "bench: wrote .tmp/bench.json"
