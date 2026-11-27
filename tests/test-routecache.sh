#!/usr/bin/env bash
# test-routecache.sh — bin/routecache.py behaviour, including the failures that
# made it unsafe to rely on (DEFECT-004).
#
#   bash tests/test-routecache.sh
#
# Checked: missing cache / create / read / TTL expiry / invalidation (clear) /
# concurrent writers (no lost entries, valid JSON) / corrupt file recovery.
# The cache stays a diagnostic record: chain.sh only writes to it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
RC="$TREE/bin/routecache.py"

T="$(mktemp -d "${TMPDIR:-/tmp}/rc-XXXXXX")" || exit 1
trap 'rm -rf "$T"' EXIT
export PU_ROUTE_CACHE="$T/cache/route-cache.json"

NP=0; NF=0
ok() { NP=$((NP+1)); printf 'PASS  %-22s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-22s %s\n' "$1" "$2"; }

# 1. missing cache answers with empty values, exit 0
out=$(python3 "$RC" get example.com); rc=$?
if [ $rc -eq 0 ] && [ "$out" = "l0=- l1=-" ]; then ok missing "$out"; else no missing "rc=$rc out=$out"; fi

# 2. create + read back
python3 "$RC" set https://www.example.com/page l1 F-BOT
out=$(python3 "$RC" get www.example.com)
[ "$out" = "l0=- l1=F-BOT" ] && ok create-read "$out" || no create-read "$out"

# 3. the cache file is private
mode=$(stat -c '%a' "$PU_ROUTE_CACHE" 2>/dev/null || stat -f '%Lp' "$PU_ROUTE_CACHE")
[ "$mode" = "600" ] && ok file-mode "0600" || no file-mode "mode=$mode"

# 4. TTL: an entry older than 7 days is ignored
python3 - "$PU_ROUTE_CACHE" <<'PY'
import json, sys, time
p = sys.argv[1]
d = json.load(open(p))
d["old.example"] = {"l1": "F-IP", "ts": time.time() - 8 * 24 * 3600}
json.dump(d, open(p, "w"))
PY
out=$(python3 "$RC" get old.example)
[ "$out" = "l0=- l1=-" ] && ok ttl-expiry "$out" || no ttl-expiry "$out"

# 5. prune drops the expired entry from the file
python3 "$RC" prune >/dev/null
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if "old.example" not in d else 1)' "$PU_ROUTE_CACHE"; then
  ok prune "expired entry removed"
else no prune "expired entry still present"; fi

# 6. invalidation
python3 "$RC" clear www.example.com >/dev/null
out=$(python3 "$RC" get www.example.com)
[ "$out" = "l0=- l1=-" ] && ok invalidate "$out" || no invalidate "$out"

# 7. concurrent writers: 20 processes, every domain must survive, JSON must parse
for i in $(seq 1 20); do python3 "$RC" set "d$i.example" l1 ok & done
wait
n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$PU_ROUTE_CACHE" 2>/dev/null || echo ERR)
[ "$n" = "20" ] && ok concurrency "20/20 domains kept" || no concurrency "kept=$n"

# 8. corrupt file: a warning-free empty answer, then it works again
printf 'not json at all\n' > "$PU_ROUTE_CACHE"
out=$(python3 "$RC" get www.example.com); rc=$?
if [ $rc -eq 0 ] && [ "$out" = "l0=- l1=-" ] && [ -f "$PU_ROUTE_CACHE.corrupt" ]; then
  ok corrupt-recovery "quarantined to .corrupt"
else no corrupt-recovery "rc=$rc out=$out"; fi
python3 "$RC" set www.example.com l1 F-AUTH
out=$(python3 "$RC" get www.example.com)
[ "$out" = "l0=- l1=F-AUTH" ] && ok corrupt-then-write "$out" || no corrupt-then-write "$out"

echo "----"
echo "test-routecache: PASS=$NP FAIL=$NF"
[ "$NF" -eq 0 ]
