#!/usr/bin/env bash
# test-bootstrap.sh — pickle-bootstrap.sh download integrity (DEFECT-007).
#
#   bash tests/test-bootstrap.sh
#
# Offline: a local HTTP server publishes a fake Node tarball plus its
# SHASUMS256.txt, so the real checks:
#   * unsupported platform stops with exit 2 before touching anything
#   * a checksum mismatch stops with exit 3 and installs nothing
#   * a correct checksum installs, and the installed node reports the pinned version
#   * a truncated cached tarball is detected and re-downloaded (interrupted run)
#   * re-running keeps config.env / .state and does not reinstall
#   * PU_CHROMIUM_SHA256 mismatch is refused (when a browser is present)
# The browser step itself is skipped (PU_SKIP_BROWSER=1) so this test needs no
# network and no Chromium.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
PY=python3

T="$(mktemp -d "${TMPDIR:-/tmp}/boot-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  if [ -n "$SRV_PID" ]; then
    kill "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
  fi
  rm -rf "$T"
}
trap cleanup EXIT

VER="v22.23.5"
PLAT="linux-x64"     # the audit host is Linux x86_64
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) PLAT="linux-x64" ;;
  Linux/aarch64|Linux/arm64) PLAT="linux-arm64" ;;
  Darwin/x86_64) PLAT="darwin-x64" ;;
  Darwin/arm64) PLAT="darwin-arm64" ;;
esac

NP=0; NF=0; NS=0
ok() { NP=$((NP+1)); printf 'PASS  %-22s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-22s %s\n' "$1" "$2"; }
sk() { NS=$((NS+1)); printf 'SKIP  %-22s %s\n' "$1" "$2"; }

# --- fake distribution -------------------------------------------------------
WEB="$T/web"; mkdir -p "$WEB/$VER"
STAGE="$T/stage/node-$VER-$PLAT"; mkdir -p "$STAGE/bin"
cat > "$STAGE/bin/node" <<EOF
#!/bin/sh
if [ "\$1" = "-v" ] || [ "\$1" = "--version" ]; then echo "$VER"; else echo "fake node \$*"; fi
EOF
chmod +x "$STAGE/bin/node"
tar -czf "$WEB/$VER/node-$VER-$PLAT.tar.gz" -C "$T/stage" "node-$VER-$PLAT"
$PY - "$WEB/$VER/node-$VER-$PLAT.tar.gz" > "$WEB/$VER/SHASUMS256.txt" <<'PY'
import hashlib, sys
p = sys.argv[1]
h = hashlib.sha256(open(p, "rb").read()).hexdigest()
print(h + "  node-" + p.rsplit("node-", 1)[1].split("/")[-1])
PY

# a second, wrong manifest
mkdir -p "$T/webbad/$VER"
cp "$WEB/$VER/node-$VER-$PLAT.tar.gz" "$T/webbad/$VER/"
printf '%s  node-%s-%s.tar.gz\n' "$(printf '0%.0s' $(seq 1 64))" "$VER" "$PLAT" > "$T/webbad/$VER/SHASUMS256.txt"

$PY -u -m http.server 0 --bind 127.0.0.1 --directory "$WEB" > "$T/http.log" 2>&1 &
SRV_PID=$!
PORT_FILE="$T/port"
for i in $(seq 1 50); do grep -q 'port' "$T/http.log" 2>/dev/null && break; sleep 0.1; done
PORT=$($PY -c 'import re,sys;print(re.search(r"port (\d+)", open(sys.argv[1]).read()).group(1))' "$T/http.log" 2>/dev/null || true)
[ -n "${PORT:-}" ] || { echo "test-bootstrap: local server did not start"; exit 1; }
$PY -u -m http.server 0 --bind 127.0.0.1 --directory "$T/webbad" > "$T/httpbad.log" 2>&1 &
BAD_PID=$!
for i in $(seq 1 50); do grep -q 'port' "$T/httpbad.log" 2>/dev/null && break; sleep 0.1; done
BADPORT=$($PY -c 'import re,sys;print(re.search(r"port (\d+)", open(sys.argv[1]).read()).group(1))' "$T/httpbad.log" 2>/dev/null || true)
cleanup2() { kill "$BAD_PID" 2>/dev/null || true; }
trap 'cleanup2; cleanup' EXIT

run_boot() { # toolsdir baseurl [extra env...]
  local tools="$1" base="$2"; shift 2
  env PU_TOOLS="$tools" PU_NODE_BASE="$base" PU_SKIP_BROWSER=1 PU_SKIP_VERIFY=1 \
      PU_DL_CACHE="$tools/downloads" TMPDIR="$T" "$@" \
      bash "$TREE/pickle-bootstrap.sh"
}

# 1. unsupported platform
out=$(PU_OS_OVERRIDE=Windows PU_ARCH_OVERRIDE=x86_64 PU_TOOLS="$T/t0" bash "$TREE/pickle-bootstrap.sh" 2>&1); rc=$?
case "$out" in *unsupported\ platform*) ok unsupported-platform "exit $rc" ;; *) no unsupported-platform "rc=$rc out=$(printf '%s' "$out" | tail -1)" ;; esac
[ "$rc" = 2 ] && ok unsupported-exit-code "exit 2" || no unsupported-exit-code "exit $rc"

# 2. checksum mismatch aborts
out=$(run_boot "$T/t1" "http://127.0.0.1:$BADPORT" 2>&1); rc=$?
if [ "$rc" = 3 ] && printf '%s' "$out" | grep -qi 'checksum MISMATCH'; then
  ok checksum-mismatch "exit 3, refused"
else
  no checksum-mismatch "rc=$rc out=$(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
fi
[ -x "$T/t1/node/bin/node" ] && no mismatch-installs-nothing "node binary exists after mismatch" || ok mismatch-installs-nothing "nothing installed"

# 3. good checksum installs
out=$(run_boot "$T/t2" "http://127.0.0.1:$PORT" 2>&1); rc=$?
if [ "$rc" = 0 ] && [ -x "$T/t2/node/bin/node" ] && [ "$("$T/t2/node/bin/node" -v)" = "$VER" ]; then
  ok good-checksum "installed fake node $VER"
else
  no good-checksum "rc=$rc out=$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi

# 4. idempotent re-run; config.env and .state survive
mkdir -p "$T/t2/.state"; echo 'cookie-jar' > "$T/t2/.state/marker"; echo 'KEEP=1' > "$T/t2/config.env"
out=$(run_boot "$T/t2" "http://127.0.0.1:$PORT" 2>&1); rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'already:'; then ok rerun "no reinstall"; else no rerun "rc=$rc"; fi
[ "$(cat "$T/t2/.state/marker" 2>/dev/null)" = "cookie-jar" ] && ok state-preserved "profile data kept" || no state-preserved "state lost"
[ "$(cat "$T/t2/config.env" 2>/dev/null)" = "KEEP=1" ] && ok config-preserved "config.env kept" || no config-preserved "config overwritten"

# 5. truncated cached tarball is detected and replaced
B="$T/t3"; mkdir -p "$B/downloads"
head -c 40 "$WEB/$VER/node-$VER-$PLAT.tar.gz" > "$B/downloads/node-$VER-$PLAT.tar.gz"
out=$(run_boot "$B" "http://127.0.0.1:$PORT" 2>&1); rc=$?
if [ "$rc" = 0 ] && [ "$("$B/node/bin/node" -v 2>/dev/null)" = "$VER" ]; then
  ok truncated-cache "re-downloaded and installed"
else
  no truncated-cache "rc=$rc out=$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi

# 6. a resumed .part file is not trusted as a finished download
C="$T/t4"; mkdir -p "$C/downloads"
head -c 40 "$WEB/$VER/node-$VER-$PLAT.tar.gz" > "$C/downloads/node-$VER-$PLAT.tar.gz.part"
out=$(run_boot "$C" "http://127.0.0.1:$PORT" 2>&1); rc=$?
if [ "$rc" = 0 ] && [ "$("$C/node/bin/node" -v 2>/dev/null)" = "$VER" ]; then
  ok partial-download "recovered"
else
  no partial-download "rc=$rc out=$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi

# 7. PU_CHROMIUM_SHA256 mismatch is refused (needs an installed browser)
if pu_resolve_chrome >/dev/null 2>&1; then
  out=$(env PU_TOOLS="$PU_TOOLS" PU_SKIP_VERIFY=1 PU_CHROMIUM_SHA256="$(printf '0%.0s' $(seq 1 64))" \
        bash "$TREE/pickle-bootstrap.sh" 2>&1); rc=$?
  if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q 'PU_CHROMIUM_SHA256'; then
    ok chromium-pin "exit 3 on hash mismatch"
  else
    no chromium-pin "rc=$rc out=$(printf '%s' "$out" | grep -i chrom | tail -1)"
  fi
else
  sk chromium-pin "no Chromium installed"
fi

echo "----"
echo "test-bootstrap: PASS=$NP FAIL=$NF SKIP=$NS"
[ "$NF" -eq 0 ]
