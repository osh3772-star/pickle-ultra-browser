#!/usr/bin/env bash
# fetch.sh — L0 레인: 브라우저 없이 curl + 표준 라이브러리만으로 본문만 뽑는다.
# Usage: fetch.sh <url>
# 마지막 stdout 줄은 항상 구조화 결과:
#   %%CHAIN%% lane=L0 mode=read status=ok|fail code=<F-*> elapsed_s=<n> chars=<n> http=<code> next=<..>
# 실패면 본문을 출력하지 않는다(진단은 stderr). 프록시 없음 — 이 환경은 직결.
#
# 판정은 bin/detect-page.py가 한다(HTTP 상태 + <title> + 마커 + 본문 길이·모양).
# 2026-11-27 이전에는 본문 키워드 grep만 봤기 때문에 "Access denied를 고치는
# 방법" 같은 정상 문서가 F-IP로, `type = 'password'` 표기의 입력란이 로그인벽
# 감지에서 빠지는 오판이 있었다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${1:?usage: fetch.sh <url>}"
. "$HERE/pu-config.sh"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36'
MAXTIME="${L0_TIMEOUT:-20}"
MINCHARS="${L0_MINCHARS:-100}"
START=$(date +%s.%N)
elapsed() { awk -v s="$START" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}'; }
result() { # status code chars http next
  echo "%%CHAIN%% lane=L0 mode=read status=$1 code=$2 elapsed_s=$(elapsed) chars=$3 http=$4 next=$5";
}
# PUB-203: engine failure is F-DETECT, never "-" (a normal page).
ENGINE="${PU_DETECT_ENGINE:-$HERE/detect-page.py}"
code_of() { python3 -c 'import json,sys
raw = sys.stdin.read().strip()
if not raw:
    print("F-DETECT"); sys.exit(0)
try:
    code = json.loads(raw).get("code")
except Exception:
    print("F-DETECT"); sys.exit(0)
code = "" if code is None else str(code).strip()
if code not in {"-", "F-AUTH", "F-BOT", "F-IP", "F-EMPTY", "F-RATE",
                "F-SERVER", "F-NOTFOUND", "F-NET", "F-TIMEOUT", "F-DETECT"}:
    print("F-DETECT"); sys.exit(0)
print(code)'; }

HTML=$(mktemp "$TMPDIR/l0-XXXXXX.html")
TXT=$(mktemp "$TMPDIR/l0-XXXXXX.txt")
ERR=$(mktemp "$TMPDIR/l0-XXXXXX.err")
trap 'rm -f "$HTML" "$TXT" "$ERR"' EXIT

HTTP=$(curl -sS -A "$UA" -L --max-time "$MAXTIME" -o "$HTML" -w '%{http_code}' "$URL" 2>"$ERR")
RC=$?
if [ $RC -ne 0 ]; then
  if [ $RC -eq 28 ]; then result fail F-TIMEOUT 0 000 none; else result fail F-NET 0 000 none; fi
  cat "$ERR" >&2
  exit 1
fi

python3 "$HERE/html2text.py" < "$HTML" > "$TXT" 2>/dev/null
CHARS=$(wc -m < "$TXT")

# One engine for status/title/markers/shape/password fields.
# F-EMPTY from the engine means "no body text"; the MINCHARS gate below owns
# that verdict, so an empty answer falls through to it.
CODE=$( { python3 "$ENGINE" --mode l0 --html "$HTML" --http "${HTTP:-0}" --text-chars "$CHARS" || true; } | code_of )
[ "$CODE" = "F-EMPTY" ] && CODE=-
# A non-success status that the engine did not call a block is a transport-level
# failure (500, 404, 0). The old script mapped this with a case statement and
# the rewrite dropped it, which turned a 500 into F-EMPTY.
if [ "$CODE" = "-" ]; then
  case "${HTTP:-0}" in
    2*|3*) ;;
    *) CODE=F-NET ;;
  esac
fi
if [ "$CODE" != "-" ]; then
  case "$CODE" in
    F-AUTH)                 result fail "$CODE" "$CHARS" "$HTTP" builtin-browser-vault ;;
    F-IP|F-BOT|F-EMPTY)     result fail "$CODE" "$CHARS" "$HTTP" builtin-browser ;;
    *)                      result fail "$CODE" "$CHARS" "$HTTP" none ;;   # F-DETECT / F-NET / F-TIMEOUT
  esac
  exit 1
fi
if [ "$CHARS" -lt "$MINCHARS" ]; then
  result fail F-EMPTY "$CHARS" "$HTTP" builtin-browser; exit 1
fi
cat "$TXT"
printf '\n'
result ok - "$CHARS" "$HTTP" none
exit 0
