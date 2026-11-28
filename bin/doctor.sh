#!/usr/bin/env bash
# doctor.sh — environment check for Pickle Ultra Browser.
#
#   bash bin/doctor.sh            checks only (no browser started)
#   bash bin/doctor.sh --smoke    additionally boots a throwaway daemon with a
#                                 temp state/profile and does one eval round-trip
#
# Output: one PASS / FAIL / WARN / SKIP line per check, then a summary line:
#   doctor: PASS=<n> FAIL=<n> WARN=<n> SKIP=<n> critical-failures=<n>
# Exit code: 0 when there is no critical failure, 1 otherwise.
# Nothing here prints a credential; the vault checks look at modes only.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"

SMOKE=0
case "${1:-}" in
  --smoke) SMOKE=1 ;;
  ""|--check) ;;
  *) echo "usage: doctor.sh [--smoke]" >&2; exit 2 ;;
esac

NPASS=0; NFAIL=0; NWARN=0; NSKIP=0; NCRIT=0
ok()   { NPASS=$((NPASS+1)); printf 'PASS  %-14s %s\n' "$1" "$2"; }
bad()  { NFAIL=$((NFAIL+1)); [ "${3:-0}" = 1 ] && NCRIT=$((NCRIT+1)); printf 'FAIL  %-14s %s\n' "$1" "$2"; }
warn() { NWARN=$((NWARN+1)); printf 'WARN  %-14s %s\n' "$1" "$2"; }
skip() { NSKIP=$((NSKIP+1)); printf 'SKIP  %-14s %s\n' "$1" "$2"; }

echo "doctor: Pickle Ultra Browser — $PU_HOME"

# --- OS ---------------------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Linux|Darwin) ok "os" "$OS $ARCH" ;;
  *) bad "os" "unsupported OS: $OS $ARCH (Linux or macOS expected)" 1 ;;
esac

# --- runtime tools ----------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version 2>/dev/null)"; NODE_MAJ="${NODE_V#v}"; NODE_MAJ="${NODE_MAJ%%.*}"
  if [ "${NODE_MAJ:-0}" -ge 22 ] 2>/dev/null; then ok "node" "$NODE_V (>= 22)"
  else bad "node" "$NODE_V — Node >= 22 is required (the daemon uses Node 22 built-ins)" 1; fi
else
  bad "node" "node not found in PATH (expected $PU_TOOLS/node/bin — run pickle-bootstrap.sh)" 1
fi

if command -v python3 >/dev/null 2>&1; then
  PY_V="$(python3 --version 2>&1)"
  ok "python3" "$PY_V"
  if python3 -c 'import cryptography' 2>/dev/null; then
    ok "crypto-lib" "python cryptography present (agent-vault encryption)"
  else
    bad "crypto-lib" "python module 'cryptography' missing — agent-vault cannot encrypt (pip install cryptography)" 0
  fi
else
  bad "python3" "python3 not found (snaptrim.py / html2text.py / routecache.py / agent-vault need it)" 1
fi

if command -v curl >/dev/null 2>&1; then ok "curl" "present (L0 fetch.sh)"
else bad "curl" "curl not found — L0 fetch.sh cannot run (L1 read is unaffected)" 0; fi

if command -v awk >/dev/null 2>&1; then ok "awk" "$(command -v awk)"
elif command -v mawk >/dev/null 2>&1; then warn "awk" "awk missing but mawk is present — pu-config links it; elapsed_s may be blank"
else bad "awk" "neither awk nor mawk — elapsed_s stays blank (bootstrap installs mawk)" 0; fi

# --- Chromium ---------------------------------------------------------------
CHROME_BIN=""
if CHROME_BIN="$(pu_resolve_chrome 2>/dev/null)" && [ -n "$CHROME_BIN" ]; then
  CHROME_VER="$(pu_chrome_full_version "$CHROME_BIN" 2>/dev/null)"
  if [ -n "$CHROME_VER" ]; then
    ok "chromium" "$CHROME_BIN (version $CHROME_VER)"
  else
    # A file that answers no version is not a working browser; before this it
    # printed "(version )" and counted as a pass.
    bad "chromium" "$CHROME_BIN does not report a version (wrong file, or missing shared libraries — run: python3 vendor/fetch_chrome_deps.py)" 1
  fi
else
  bad "chromium" "no Chromium binary — run pickle-bootstrap.sh (or set PICKLE_ULTRA_CHROME in config.env)" 1
fi

if [ "$OS" = "Linux" ] && [ -n "$CHROME_BIN" ]; then
  # A failed ldd (not a dynamic binary, loader missing, path wrong) prints no
  # "not found" lines, and grep -c then reported 0 — a PASS for a question that
  # was never answered. Check the exit status and the output first.
  LDD_RC=0
  LDD_OUT="$(LD_LIBRARY_PATH="$PU_TOOLS/chrome-deps/lib" ldd "$CHROME_BIN" 2>&1)" || LDD_RC=$?
  if [ "$LDD_RC" -ne 0 ] && [ -z "$LDD_OUT" ]; then
    bad "chromium-libs" "ldd failed on $CHROME_BIN (rc=$LDD_RC) — cannot verify shared libraries" 1
  elif printf '%s\n' "$LDD_OUT" | grep -qi 'not a dynamic executable'; then
    bad "chromium-libs" "$CHROME_BIN is not a dynamic executable — wrong file?" 1
  else
    MISSING="$(printf '%s\n' "$LDD_OUT" | grep -c 'not found' || true)"
    if [ "${MISSING:-0}" -eq 0 ]; then
      ok "chromium-libs" "all shared libraries resolve"
    else
      bad "chromium-libs" "$MISSING shared libraries missing — run: python3 vendor/fetch_chrome_deps.py" 1
    fi
  fi
else
  skip "chromium-libs" "not checked on $OS"
fi

if [ -x "$HERE/chrome-wrapper.sh" ]; then ok "chrome-wrapper" "$HERE/chrome-wrapper.sh"
else bad "chrome-wrapper" "not executable: $HERE/chrome-wrapper.sh" 1; fi

# --- directories ------------------------------------------------------------
for pair in "state:$PICKLE_ULTRA_STATE_DIR" "tmp:$PU_TMP"; do
  label="${pair%%:*}"; dir="${pair#*:}"
  if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then
    probe="$dir/.doctor-probe-$$"
    if touch "$probe" 2>/dev/null; then rm -f "$probe"; ok "$label-dir" "$dir"; else bad "$label-dir" "not writable: $dir" 1; fi
  else
    bad "$label-dir" "cannot create or write: $dir" 1
  fi
done

# --- config -----------------------------------------------------------------
if [ -f "$PU_HOME/config.env" ]; then ok "config" "$PU_HOME/config.env present"
else skip "config" "no config.env — defaults apply (copy config.env.example if you need overrides)"; fi

# --- vault layout (modes only, no values) -----------------------------------
# A failed stat used to fall back to the expected value (${M:-700}), so a vault
# whose permissions could not be read was reported as a pass. Unreadable is a
# failure to answer, not an answer: it is reported below instead.
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
VROOT="$PU_HOME/agent-vault"
if [ -d "$VROOT/keys" ] || [ -d "$VROOT/entries" ]; then
  VBAD=""; VWARN=""; VUNKNOWN=""; VCRIT=0
  for d in "$VROOT/keys" "$VROOT/entries"; do
    [ -d "$d" ] || continue
    M="$(mode_of "$d")"
    if [ -z "$M" ]; then VUNKNOWN="$VUNKNOWN $d"; continue; fi
    [ "$M" = "700" ] || VBAD="$VBAD $d=$M"
  done
  # The key decrypts every entry: readable by anyone else is critical.
  for f in "$VROOT/keys/vault.key"; do
    [ -f "$f" ] || continue
    M="$(mode_of "$f")"
    if [ -z "$M" ]; then VUNKNOWN="$VUNKNOWN $f"; VCRIT=1; continue; fi
    if [ "$M" != "600" ]; then VBAD="$VBAD $f=$M"; VCRIT=1; fi
  done
  for f in "$VROOT/meta.json" "$VROOT"/entries/*.enc; do
    [ -f "$f" ] || continue
    M="$(mode_of "$f")"
    if [ -z "$M" ]; then VUNKNOWN="$VUNKNOWN $f"; continue; fi
    [ "$M" = "600" ] || VWARN="$VWARN $f=$M"
  done
  if [ -n "$VBAD" ] || [ -n "$VUNKNOWN" ]; then
    bad "vault" "wrong or unreadable permissions:${VBAD}${VUNKNOWN:+ unreadable:$VUNKNOWN}${VWARN:+ also >0600:$VWARN} — fix: chmod 700 agent-vault/keys agent-vault/entries && chmod 600 agent-vault/keys/vault.key agent-vault/meta.json agent-vault/entries/*.enc" "$VCRIT"
  elif [ -n "$VWARN" ]; then
    warn "vault" "encrypted files are more readable than 0600:${VWARN} — chmod 600 agent-vault/meta.json agent-vault/entries/*.enc"
  else
    ok "vault" "keys/ and entries/ 700, key/meta/entries 600"
  fi
else
  skip "vault" "not initialized yet — python3 agent-vault/vault.py init"
fi

# --- outbound network -------------------------------------------------------
HTTP=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://example.com 2>/dev/null)
case "$HTTP" in
  2*|3*) ok "network" "https://example.com answered $HTTP" ;;
  "") warn "network" "no answer from example.com — read/chain tests will fail until outbound HTTPS works" ;;
  *) warn "network" "example.com answered $HTTP — outbound HTTPS is filtered here" ;;
esac

# --- optional smoke ---------------------------------------------------------
if [ "$SMOKE" = 1 ]; then
  SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pu-doctor-XXXXXX" 2>/dev/null || mktemp -d)"
  printf 'const t = await taskSpace("doctor-smoke");\nconst p = await t.newPage();\nconst v = await p.evaluate(() => 21 * 2);\nawait t.finish({ keep: [] });\nconsole.log("doctor-smoke-eval=" + v);\n' > "$SMOKE_DIR/smoke.js"
  OUT="$(PICKLE_ULTRA_STATE_DIR="$SMOKE_DIR/state" PICKLE_ULTRA_PROFILE="$SMOKE_DIR/profile" \
         timeout 90 node "$HERE/cdp-client.mjs" < "$SMOKE_DIR/smoke.js" 2> "$SMOKE_DIR/smoke.err")"
  SRC=$?
  PICKLE_ULTRA_STATE_DIR="$SMOKE_DIR/state" timeout 15 node "$HERE/cdp-client.mjs" --stop >/dev/null 2>&1 || true
  if [ "$SRC" = 0 ] && printf '%s' "$OUT" | grep -q 'doctor-smoke-eval=42'; then
    ok "smoke" "temporary daemon eval round-trip OK (42), stopped"
    # --stop returns before the daemon has unlinked its socket/pid and its
    # Chromium children have finished writing their profile; removing the tree
    # right away left "Directory not empty" behind. Wait, then retry the removal.
    for _i in $(seq 1 40); do
      [ -d "$SMOKE_DIR/state" ] && [ -e "$SMOKE_DIR/state/cdp-daemon.pid" ] || break
      sleep 0.25
    done
    for _i in $(seq 1 10); do
      rm -rf "$SMOKE_DIR" 2>/dev/null && [ ! -e "$SMOKE_DIR" ] && break
      sleep 0.5
    done
    [ -e "$SMOKE_DIR" ] && echo "doctor: left $SMOKE_DIR in place (a Chromium child may still hold it) — harmless, remove it later"
  else
    echo "--- smoke log (last 20 lines of $SMOKE_DIR/smoke.err) ---"
    tail -20 "$SMOKE_DIR/smoke.err" 2>/dev/null || true
    [ -f "$SMOKE_DIR/state/cdp-daemon.log" ] && { echo "--- daemon log ---"; tail -20 "$SMOKE_DIR/state/cdp-daemon.log"; }
    bad "smoke" "daemon round-trip failed (rc=$SRC) — logs kept under $SMOKE_DIR" 1
  fi
else
  skip "smoke" "not requested (--smoke boots a throwaway daemon)"
fi

echo "----"
echo "doctor: PASS=$NPASS FAIL=$NFAIL WARN=$NWARN SKIP=$NSKIP critical-failures=$NCRIT"
[ "$NCRIT" = 0 ]
