#!/usr/bin/env bash
# fetch.sh — L0 레인: 브라우저 없이 curl + stdlib python으로 본문만 뽑는다.
# Usage: fetch.sh <url>
# 마지막 stdout 줄은 항상 구조화 결과:
#   %%CHAIN%% lane=L0 mode=read status=ok|fail code=<F-*> elapsed_s=<n> chars=<n> http=<code>
# 실패면 본문을 출력하지 않는다(진단은 stderr). 프록시 없음 — 이 환경은 직결.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${1:?usage: fetch.sh <url>}"
. "$HERE/pu-config.sh"
. "$HERE/detect-code.sh"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36'
MAXTIME="${L0_TIMEOUT:-20}"
MINCHARS="${L0_MINCHARS:-100}"
START=$(date +%s.%N)
elapsed() { awk -v s="$START" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}'; }
result() { # status code chars http next
  echo "%%CHAIN%% lane=L0 mode=read status=$1 code=$2 elapsed_s=$(elapsed) chars=$3 http=$4 next=$5";
}

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
if [ "$HTTP" = "403" ] || [ "$HTTP" = "429" ]; then
  result fail F-IP 0 "$HTTP" none; exit 1
fi
case "$HTTP" in
  2*|3*) ;;
  *) result fail F-NET 0 "$HTTP" none; exit 1 ;;
esac

python3 "$HERE/html2text.py" < "$HTML" > "$TXT" 2>/dev/null
CHARS=$(wc -m < "$TXT")
CODE=$(pu_detect_code "$TXT")
if [ "$CODE" != "-" ]; then
  result fail "$CODE" "$CHARS" "$HTTP" builtin-browser; exit 1
fi
# 로그인벽은 원본 HTML(비밀번호 입력란)까지 보고 판정한다.
CODE=$(pu_detect_auth "$HTML" "$CHARS")
if [ "$CODE" != "-" ]; then
  result fail "$CODE" "$CHARS" "$HTTP" builtin-browser-vault; exit 1
fi
if [ "$CHARS" -lt "$MINCHARS" ]; then
  result fail F-EMPTY "$CHARS" "$HTTP" builtin-browser; exit 1
fi
cat "$TXT"
printf '\n'
result ok - "$CHARS" "$HTTP" none
exit 0
