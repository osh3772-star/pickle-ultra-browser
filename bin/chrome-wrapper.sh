#!/usr/bin/env bash
# chrome-wrapper.sh — CDP 데몬이 "Chrome"으로 띄우는 실행 파일 (CHROME_PATH).
# 원본 래퍼에서 프록시·socat 릴레이·NSS 블록을 걷어낸 판.
# 남긴 것(2026-11-20 지문 조정, 전부 래퍼 층):
#  - 호출자가 붙이는 --disable-gpu 제거 + --use-angle=swiftshader: 이 플래그가
#    없으면 WebGL 컨텍스트가 아예 안 생겨 실브라우저와 다른 지문이 된다(실측).
#  - --user-agent: 헤드리스 기본 UA에 박히는 "HeadlessChrome" 표기를 뗀 정식
#    Chrome UA. 버전은 해석된 바이너리에서 도출(PU_UA로 재정의 가능).
#  - --lang=ko-KR: navigator.language(s)와 기본 Accept-Language를 한국어 우선으로.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"

REAL_CHROME=$(pu_resolve_chrome) || exit 1
FULL=$(pu_chrome_full_version "$REAL_CHROME" || true)
MAJOR="${FULL%%.*}"
UA="${PU_UA:-Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR:-159}.0.0.0 Safari/537.36}"
ARGS=()
for a in "$@"; do
  [ "$a" = "--disable-gpu" ] && continue
  ARGS+=("$a")
done
exec "$REAL_CHROME" \
  --use-angle=swiftshader \
  "--user-agent=$UA" \
  --lang=ko-KR \
  "${ARGS[@]}"
