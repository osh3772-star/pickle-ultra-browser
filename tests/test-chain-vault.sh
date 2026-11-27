#!/usr/bin/env bash
# test-chain-vault.sh — the login-wall hand-off depends on the vault.
#
#   bash tests/test-chain-vault.sh
#
# Requirement (2026-11-27): when agent-vault already holds a credential for the
# host, chain.sh must not send the caller to the built-in browser. It reports
# next=ultra-vault / exit 5 so the calling agent continues in this harness with
# the vault. Without a stored credential the old target stays: exit 4,
# next=builtin-browser-vault.
#
# Cases: stored / not stored / different host / parent domain / AUTH_SKIP with
# and without a credential / the stored value never appears in the output.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(dirname "$HERE")"
. "$TREE/bin/pu-config.sh"
NODE="$(pu_node || true)"
[ -n "$NODE" ] || { echo "test-chain-vault: node not found" >&2; exit 1; }

T="$(mktemp -d "$TMPDIR/cv-XXXXXX")" || exit 1
SRV_PID=""
cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$SRV_PID" ] && wait "$SRV_PID" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

NP=0; NF=0; NS=0
ok() { NP=$((NP+1)); printf 'PASS  %-22s %s\n' "$1" "$2"; }
no() { NF=$((NF+1)); printf 'FAIL  %-22s %s\n' "$1" "$2"; }
sk() { NS=$((NS+1)); printf 'SKIP  %-22s %s\n' "$1" "$2"; }

SECRET="vault-secret-$RANDOM$RANDOM"
VAULT="$T/vault"
mkdir -p "$VAULT"
PU_VAULT_DIR="$VAULT" python3 "$TREE/agent-vault/vault.py" init >/dev/null || {
  echo "test-chain-vault: cannot initialise a throwaway vault (python cryptography missing?)"; exit 1; }
printf '%s\n' "$SECRET" | PU_VAULT_DIR="$VAULT" python3 "$TREE/agent-vault/vault.py" store 127.0.0.1 --purpose "fixture login" >/dev/null

"$NODE" "$HERE/http-server.mjs" --port 0 --port-file "$T/port" > "$T/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
BASE="http://127.0.0.1:$(cat "$T/port")"
PATHQ="/login"

run_chain() { # extra env... -> sets OUT, RC
  local -a envs=("$@")
  OUT=$(env "${envs[@]}" PU_SETTLE="${PU_SETTLE:-800}" bash "$TREE/bin/chain.sh" read "$BASE/login" 2>/dev/null)
  RC=$?
}

# 1. credential stored for this host
run_chain PU_VAULT_DIR="$VAULT"
line="$(printf '%s\n' "$OUT" | grep '^%%CHAIN%%' | tail -1)"
if [ "$RC" = 5 ] && printf '%s' "$line" | grep -q 'next=ultra-vault'; then
  ok vault-hit "exit 5 next=ultra-vault"
else
  no vault-hit "rc=$RC line=$line"
fi
case "$line" in *"vault=127.0.0.1"*) ok vault-name "entry name reported" ;; *) no vault-name "$line" ;; esac
case "$line" in *"path="*"L1:F-AUTH"*) ok vault-l1-tried "L1 was attempted before handing off" ;; *) no vault-l1-tried "$line" ;; esac
if printf '%s' "$OUT" | grep -q "$SECRET"; then no secret-hidden "the stored value appeared in output"; else ok secret-hidden "value never printed"; fi

# 2. no credential for this host
run_chain PU_VAULT_DIR="$T/empty-vault"
line="$(printf '%s\n' "$OUT" | grep '^%%CHAIN%%' | tail -1)"
if [ "$RC" = 4 ] && printf '%s' "$line" | grep -q 'next=builtin-browser-vault'; then
  ok vault-miss "exit 4 next=builtin-browser-vault"
else
  no vault-miss "rc=$RC line=$line"
fi

# 3. a credential for another host must not match
V2="$T/vault2"; mkdir -p "$V2"
PU_VAULT_DIR="$V2" python3 "$TREE/agent-vault/vault.py" init >/dev/null
printf 'x\n' | PU_VAULT_DIR="$V2" python3 "$TREE/agent-vault/vault.py" store example.com --purpose "other site" >/dev/null
run_chain PU_VAULT_DIR="$V2"
line="$(printf '%s\n' "$OUT" | grep '^%%CHAIN%%' | tail -1)"
if [ "$RC" = 4 ]; then ok vault-other-host "exit 4 (no match)"; else no vault-other-host "rc=$RC line=$line"; fi

# 4. AUTH_SKIP: with a credential the lanes are tried instead of skipped
run_chain PU_VAULT_DIR="$VAULT" PU_AUTH_SKIP=127.0.0.1
line="$(printf '%s\n' "$OUT" | grep '^%%CHAIN%%' | tail -1)"
if [ "$RC" = 5 ] && printf '%s' "$line" | grep -q 'next=ultra-vault'; then
  ok auth-skip-vault "lanes tried, exit 5"
else
  no auth-skip-vault "rc=$RC line=$line"
fi

# 5. AUTH_SKIP without a credential keeps the old skip
run_chain PU_VAULT_DIR="$T/empty-vault" PU_AUTH_SKIP=127.0.0.1
line="$(printf '%s\n' "$OUT" | grep '^%%CHAIN%%' | tail -1)"
if [ "$RC" = 4 ] && printf '%s' "$line" | grep -q 'lane=none'; then
  ok auth-skip-miss "exit 4, lane=none"
else
  no auth-skip-miss "rc=$RC line=$line"
fi

# 6. parent-domain matching (unit): an entry named naver.com answers www.naver.com
V3="$T/vault3"; mkdir -p "$V3"
PU_VAULT_DIR="$V3" python3 "$TREE/agent-vault/vault.py" init >/dev/null
printf 'x\n' | PU_VAULT_DIR="$V3" python3 "$TREE/agent-vault/vault.py" store naver.com --purpose "login https://www.naver.com" >/dev/null
m=$(PU_VAULT_DIR="$V3" python3 "$TREE/bin/vault-match.py" www.naver.com)
[ "$m" = "naver.com" ] && ok parent-domain "www.naver.com -> naver.com" || no parent-domain "got '$m'"
m=$(PU_VAULT_DIR="$V3" python3 "$TREE/bin/vault-match.py" shop.example.co.kr)
[ -z "$m" ] && ok parent-domain-miss "shop.example.co.kr unmatched" || no parent-domain-miss "got '$m'"
printf 'y\n' | PU_VAULT_DIR="$V3" python3 "$TREE/agent-vault/vault.py" store example.co.kr --purpose "kr shop" >/dev/null
m=$(PU_VAULT_DIR="$V3" python3 "$TREE/bin/vault-match.py" shop.example.co.kr)
[ "$m" = "example.co.kr" ] && ok two-level-suffix "shop.example.co.kr -> example.co.kr" || no two-level-suffix "got '$m'"

echo "----"
echo "test-chain-vault: PASS=$NP FAIL=$NF SKIP=$NS"
[ "$NF" -eq 0 ]
