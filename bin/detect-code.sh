#!/usr/bin/env bash
# detect-code.sh — 차단/챌린지/로그인벽 판별기. L0(fetch.sh)와 L1(run.sh)이 같이 쓴다.
# 함수:    pu_detect_code <파일>        -> F-IP | F-BOT | -
#          pu_detect_auth <파일> [chars] -> F-AUTH | -
# 스크립트: ./detect-code.sh <파일>       (단위 확인용)
# F-IP  : IP/지역 차단 (Access denied, Cloudflare error 1020/1015 등)
# F-BOT : 사람 확인 챌린지 (Managed Challenge, Turnstile, "Just a moment")
# F-AUTH: 로그인벽 (비밀번호 입력란, 로그인 요구 문구) — 이 빌드는 로그인을 대신하지 않는다
# 2026-11-27 실측 보강: 원본 목록은 Cloudflare가 실제로 내려주는 문구를 몰라
# 차단 페이지를 status=ok chars=118로 "성공" 보고했다(한국 커머스 사이트 실측).
# 두 언어를 다 넣은 이유: run.sh read는 acceptLanguage=ko-KR(한국어 차단 페이지),
# -f 스크립트는 영어 페이지를 받는다.
pu_detect_code() {
  local f="$1"
  if grep -qiE 'attention required|sorry, you have been blocked|you have been blocked|access denied|error 1020|error 1015|접속이 일시적으로 제한|접속이 제한되었습니다|비정상적인 접근이 감지' "$f"; then
    echo F-IP
  elif grep -qiE 'verify you are human|verifying you are human|are you a robot|unusual traffic from your computer|just a moment|performing security verification|checking if the site connection is secure|checking your browser|enable javascript and cookies to continue|보안 확인 수행 중|사람인지 확인하는 중' "$f"; then
    echo F-BOT
  else
    echo -
  fi
}

# 로그인벽 판정. 오탐을 줄이려고 "문구만 있는 긴 페이지"는 로그인벽으로 보지 않는다
# (공개 이벤트 본문에도 "로그인이 필요한 이벤트" 문구가 있지만 수천 자짜리
#  공개 페이지다 — 실측). 벽은 짧고, 비밀번호 입력란이 있거나 문구가 지배적이다.
pu_detect_auth() {
  local f="$1" n="${2:-}" pw=0 ph=0
  grep -qiE 'type=["'"'"']?password' "$f" && pw=1
  grep -qiE '로그인 ?후 (이용|사용|진행|가능)|로그인이 필요|로그인해 ?주세요|로그인 ?후 확인|비밀번호를 입력|아이디와 비밀번호|sign in to continue|please (log ?in|sign ?in)|you must be (logged|signed) in|카카오 ?로그인|네이버 ?로그인' "$f" && ph=1
  [ -z "$n" ] && n=$(wc -m < "$f")
  if [ "$ph" = 1 ] && [ "$n" -lt 800 ]; then echo F-AUTH; return; fi
  if [ "$pw" = 1 ] && { [ "$ph" = 1 ] || [ "$n" -lt 800 ]; }; then echo F-AUTH; return; fi
  echo -
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  pu_detect_code "${1:?usage: detect-code.sh <file>}"
fi
