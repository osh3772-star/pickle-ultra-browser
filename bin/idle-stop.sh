#!/usr/bin/env bash
# idle-stop.sh — run.sh가 호출마다 무장시키는 유휴 종료 워치독.
# IDLE_STOP_SEC(기본 600) 동안 새 호출(.state/last-used 갱신)이 없으면 데몬을 멈춘다.
# 브라우저(크로미움+데몬)가 수백 MB를 계속 물고 있지 않게 하는 장치일 뿐이다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"
STATE="$PICKLE_ULTRA_STATE_DIR"
IDLE="${IDLE_STOP_SEC:-600}"
sleep "$IDLE"
LAST=0
[ -f "$STATE/last-used" ] && LAST=$(cat "$STATE/last-used" 2>/dev/null || echo 0)
AGE=$(( $(date +%s) - ${LAST:-0} ))
if [ "$AGE" -ge "$(( IDLE - 2 ))" ]; then
  node "$HERE/cdp-client.mjs" --stop >/dev/null 2>&1 || true
fi
exit 0
