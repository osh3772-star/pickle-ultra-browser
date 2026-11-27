#!/usr/bin/env bash
# chain.sh — Pickle Ultra Browser 3-lane routing.
#   chain.sh read <url>   L0(curl) → L1(raw CDP)
#   chain.sh open <url>   L1만
#
# 진입 분류(먼저): 로그인·결제·사용자 동반 흐름이면 레인을 아예 타지 않는다.
#   → %%CHAIN%% lane=none status=skip code=F-AUTH chars=0 elapsed_s=0 next=builtin-browser-vault
# 그 외에는 L0 → L1 순서로 시도하고, 결과는 항상 한 줄, 마지막 필드가 next= 다.
#   next=none                   성공
#   next=builtin-browser        차단(F-BOT/F-IP)·빈 본문 — 내장 browser_* 툴로
#   next=builtin-browser-vault  로그인벽(F-AUTH) — 내장 브라우저 + vault/browser_fill_secret
# L2는 이 빌드에 구현하지 않는다(내장 브라우저 툴은 셸에서 호출되지 않는다).
# 종료코드: 0 ok / 3 브라우저 인계 / 4 볼트 인계 / 1 그 외 실패
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"

MODE="${1:?usage: chain.sh read|open <url>}"
URL="${2:?usage: chain.sh read|open <url>}"
START=$(date +%s.%N)
elapsed() { awk -v s="$START" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}'; }

T0=$(mktemp "$TMPDIR/chain-l0-XXXXXX.txt")
T1=$(mktemp "$TMPDIR/chain-l1-XXXXXX.txt")
trap 'rm -f "$T0" "$T1"' EXIT
field() { sed -n "s/.* $2=\([^ ]*\).*/\1/p" "$1" | tail -1; }
body() { grep -v '^%%CHAIN%%' "$1"; }
cache_set() { python3 "$HERE/routecache.py" set "$DOMAIN" l1 "$1" 2>/dev/null || true; }

emit_ok()     { echo "%%CHAIN%% lane=$1 status=ok code=- chars=$2 elapsed_s=$(elapsed) path=$3 next=none"; exit 0; }
emit_vault()  { echo "%%CHAIN%% lane=$1 status=skip code=F-AUTH chars=$2 elapsed_s=$(elapsed) path=$3 next=builtin-browser-vault"; exit 4; }
emit_hand()   { echo "%%CHAIN%% lane=$1 status=fail code=$2 chars=$3 elapsed_s=$(elapsed) path=$4 reason=$2 next=builtin-browser"; exit 3; }
emit_hard()   { echo "%%CHAIN%% lane=$1 status=fail code=$2 chars=$3 elapsed_s=$(elapsed) path=$4 reason=$2 next=none"; exit 1; }

# ---------------------------------------------------------------- 진입 분류
DOMAIN=$(python3 -c 'import sys; from urllib.parse import urlparse; print((urlparse(sys.argv[1]).hostname or "").lower())' "$URL")
PATHQ=$(python3 -c 'import sys; from urllib.parse import urlparse
u=urlparse(sys.argv[1]); print((u.path or "/").lower() + (("?" + u.query.lower()) if u.query else ""))' "$URL")
# Skip list: entry points that always need a session (login, checkout, account
# pages). Empty by default — the page-signal check below still catches login
# walls. Add hosts in config.env (AUTH_SKIP_HOSTS) or per call (PU_AUTH_SKIP).
# Format: host or host/path-prefix, comma separated, e.g. shop.example.com/login
SKIP="${PU_AUTH_SKIP:-${AUTH_SKIP_HOSTS:-}}"
for e in ${SKIP//,/ }; do
  eh=${e%%/*}; ep=""
  case "$e" in */*) ep="/${e#*/}" ;; esac
  case "$DOMAIN" in
    "$eh"|*."$eh") ;;
    *) continue ;;
  esac
  if [ -z "$ep" ] || [ "${PATHQ#"$ep"}" != "$PATHQ" ]; then
    echo "chain: 로그인·결제 흐름(${e}) — 레인 시도 없음, 내장 브라우저+vault로" >&2
    echo "%%CHAIN%% lane=none status=skip code=F-AUTH chars=0 elapsed_s=0 next=builtin-browser-vault"
    exit 4
  fi
done

# ---------------------------------------------------------------- L1 only (open)
run_l1() {
  local out="$1"
  "$HERE/run.sh" "$MODE" "$URL" > "$out" 2>/dev/null
}
judge_l1() { # file -> emits and exits
  local f="$1" st code chars
  st=$(field "$f" status); code=$(field "$f" code); chars=$(field "$f" chars)
  [ -n "${chars:-}" ] || chars=0
  if [ "$st" = "ok" ]; then cache_set ok; body "$f"; emit_ok L1 "$chars" "$2"; fi
  case "$code" in
    F-AUTH) cache_set F-AUTH; emit_vault L1 "$chars" "$2" ;;
    F-BOT|F-IP|F-EMPTY) cache_set "$code"; emit_hand L1 "${code}" "$chars" "$2" ;;
    *) cache_set "${code:-F-NET}"; emit_hard L1 "${code:-F-NET}" "$chars" "$2" ;;
  esac
}

if [ "$MODE" = "open" ]; then
  run_l1 "$T1"
  judge_l1 "$T1" "L1:?" 
fi

# ---------------------------------------------------------------- read: L0 → L1
"$HERE/fetch.sh" "$URL" > "$T0" 2>/dev/null
ST=$(field "$T0" status); CODE=$(field "$T0" code); CH=$(field "$T0" chars)
[ -n "${CH:-}" ] || CH=0
if [ "$ST" = "ok" ]; then
  body "$T0"; emit_ok L0 "$CH" "L0:ok"
fi
if [ "$CODE" = "F-AUTH" ]; then
  emit_vault L0 "$CH" "L0:F-AUTH"
fi
PATHREC="L0:${CODE:-F-NET}"

run_l1 "$T1"
ST=$(field "$T1" status); CODE1=$(field "$T1" code); CH1=$(field "$T1" chars)
[ -n "${CH1:-}" ] || CH1=0
if [ "$ST" = "ok" ]; then
  cache_set ok
  body "$T1"
  emit_ok L1 "$CH1" "${PATHREC}>L1:ok"
fi
case "$CODE1" in
  F-AUTH) cache_set F-AUTH; emit_vault L1 "$CH1" "${PATHREC}>L1:F-AUTH" ;;
  F-BOT|F-IP|F-EMPTY) cache_set "$CODE1"; emit_hand L1 "$CODE1" "$CH1" "${PATHREC}>L1:${CODE1}" ;;
  *) cache_set "${CODE1:-F-NET}"; emit_hard L1 "${CODE1:-F-NET}" "$CH1" "${PATHREC}>L1:${CODE1:-F-NET}" ;;
esac
