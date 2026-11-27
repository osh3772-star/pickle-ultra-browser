#!/usr/bin/env bash
# run.sh — Pickle Ultra Browser (raw CDP, Node 22 built-ins only).
# What it replaces and what it does not: see README.md ("What this is / is not").
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"
. "$HERE/detect-code.sh"

usage() {
  cat <<'USAGE'
run.sh <cmd>
  open <url>                  페이지 열기: 접근성 스냅샷 + %%MARK%%(ref·selector) + 판정 줄
  read <url>                  본문 읽기: 텍스트 + 판정 줄
  click <url> <ref|css>       이동 후 클릭 (데몬 p.click: CDP Input.*), 2초 settle
  type <url> <ref|css> <txt>  일반 텍스트 입력 (p.type, 비밀번호 필드는 거부)
  scroll <url> [n]            n회 스크롤(기본 5), 지연 로딩 본문 확보
  shot <url> <out.png>        뷰포트 PNG 저장, 경로·바이트 수
  extract <url> <css>         매칭 요소 [i, ref, sel, text, href] JSON 한 줄 (최대 200)
  batch <steps.txt>           원본 batch 드라이버(단계별 %%BATCH-STEP%%, 끝에 %%BATCH%%)
  batch-urls <url-file>       URL 목록 → steps.txt 생성 후 batch (URL마다 판정 줄)
  -f <script.js>              임의 JS (p.elements/click/type/press/snapshot/drainEvents)
  keep | resume               유휴 자동 종료 끄기 / 다시 켜기 (세션·쿠키 유지)
  status | warm | stop        데몬 상태 / 미리 기동 / 종료
  doctor                      환경 점검 (Node·Chromium·공유 라이브러리·권한) — 종료코드 0이면 정상
%%CHAIN%% lane=L1 mode=<m> status=<ok|fail> code=<F-*> elapsed_s=<n> chars=<n> [url=..] next=<none|builtin-browser|builtin-browser-vault>
프로필(쿠키·세션): <tree>/.state/profile  (PICKLE_ULTRA_PROFILE로 변경)
USAGE
}
case "${1:-}" in ""|-h|--help|help) usage; exit 0 ;; esac

export CHROME_PATH="${CHROME_PATH:-$HERE/chrome-wrapper.sh}"
if [ ! -x "$CHROME_PATH" ]; then
  echo "run.sh: CHROME_PATH 실행 불가: $CHROME_PATH" >&2; exit 1
fi
export PICKLE_ULTRA_HEADLESS="${PICKLE_ULTRA_HEADLESS:-1}"
PU_CHROME_BIN=$(pu_resolve_chrome 2>/dev/null || true)
PU_CHROME_FULL=$(pu_chrome_full_version "$PU_CHROME_BIN" 2>/dev/null || true)
PU_CHROME_MAJOR="${PU_CHROME_FULL%%.*}"
[ -n "$PU_CHROME_MAJOR" ] || PU_CHROME_MAJOR=159
[ -n "$PU_CHROME_FULL" ] || PU_CHROME_FULL=159.0.8154.6
PICKLE_ULTRA_TIMEOUT=60
STATE="$PICKLE_ULTRA_STATE_DIR"
mkdir -p "$STATE"

stop_watchdog() {
  local wf="$STATE/watchdog.pid" pid c
  [ -f "$wf" ] || return 0
  pid=$(cat "$wf" 2>/dev/null || true)
  if [ -n "${pid:-}" ]; then
    for c in $(cat "/proc/$pid/task/$pid/children" 2>/dev/null || true); do kill "$c" 2>/dev/null || true; done
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$wf"
}
arm_idle() {
  date +%s > "$STATE/last-used"
  stop_watchdog
  [ -f "$STATE/keep" ] && return 0
  IDLE_STOP_SEC="${IDLE_STOP_SEC:-600}" nohup "$HERE/idle-stop.sh" >/dev/null 2>&1 &
  echo $! > "$STATE/watchdog.pid"
  disown 2>/dev/null || true
}

case "${1:-}" in
  keep)   touch "$STATE/keep"; stop_watchdog; echo "idle auto-stop OFF (데몬 유지, 세션·쿠키 보존)"; exit 0 ;;
  doctor) shift; exec "$HERE/doctor.sh" "$@" ;;
  resume) rm -f "$STATE/keep"; arm_idle; echo "idle auto-stop ON (${IDLE_STOP_SEC:-600}s)"; exit 0 ;;
  stop)
    node "$HERE/cdp-client.mjs" --stop 2>/dev/null || true
    stop_watchdog
    rm -f "$STATE/last-used"
    # 데몬이 이미 죽었는데 소켓 파일만 남은 경우까지 정리한다 (리스너 없음 확인 후 삭제).
    sleep 1
    if ! python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX)
try:
    s.settimeout(1); s.connect(sys.argv[1]); sys.exit(0)
except Exception:
    sys.exit(1)' "$STATE/cdp-daemon.sock" 2>/dev/null; then
      rm -f "$STATE/cdp-daemon.sock" "$STATE/cdp-daemon.pid"
    fi
    exit 0 ;;
  status) exec node "$HERE/cdp-client.mjs" --status ;;
  batch)  shift; exec "$HERE/batch.sh" "$@" ;;
  warm)
    arm_idle
    WARMJS=$(mktemp "$TMPDIR/warm-XXXXXX.js"); WARMERR=$(mktemp "$TMPDIR/warm-XXXXXX.txt")
    printf 'const t = await taskSpace("pu-warm");\nconst p = await t.newPage();\nawait t.finish({keep: []});\nconsole.log("pu-warm");\n' > "$WARMJS"
    WRC=0
    timeout 30 node "$HERE/cdp-client.mjs" < "$WARMJS" 2> "$WARMERR" || WRC=$?
    if [ $WRC -ne 0 ] && grep -qiE 'daemon\.sock|ECONNREFUSED' "$WARMERR" 2>/dev/null; then
      sleep 1; WRC=0
      timeout 30 node "$HERE/cdp-client.mjs" < "$WARMJS" 2> "$WARMERR" || WRC=$?
    fi
    [ -s "$WARMERR" ] && cat "$WARMERR" >&2
    rm -f "$WARMJS" "$WARMERR"
    if [ $WRC -eq 0 ]; then echo "daemon warm"; else echo "warm failed rc=$WRC" >&2; exit 1; fi
    exit 0 ;;
esac

START=$(date +%s.%N)
elapsed() { awk -v s="$START" -v e="$(date +%s.%N)" 'BEGIN{printf "%.1f", e-s}'; }
result_line() { # mode status code chars next [extra]
  echo "%%CHAIN%% lane=L1 mode=${1} status=${2} code=${3} elapsed_s=$(elapsed) chars=${4}${6:+ ${6}} next=${5}"
}
next_for_code() {
  case "$1" in
    F-AUTH) echo builtin-browser-vault ;;
    F-BOT|F-IP|F-EMPTY) echo builtin-browser ;;
    *) echo none ;;
  esac
}
jget() { python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
v=d.get(sys.argv[2],"")
print("" if v is None else v)' "$1" "$2"; }
jstr() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

run_client() {
  local infile="$1" errf rc=0
  errf=$(mktemp "$TMPDIR/err-XXXXXX.txt")
  timeout $PICKLE_ULTRA_TIMEOUT node "$HERE/cdp-client.mjs" < "$infile" 2> "$errf" || rc=$?
  if [ $rc -ne 0 ] && grep -qiE 'daemon\.sock|ECONNREFUSED' "$errf" 2>/dev/null; then
    sleep 1; rc=0
    timeout $PICKLE_ULTRA_TIMEOUT node "$HERE/cdp-client.mjs" < "$infile" 2> "$errf" || rc=$?
  fi
  [ -s "$errf" ] && cat "$errf" >&2
  rm -f "$errf"
  return $rc
}

UAJS=$(cat <<JSEOF
  try { await p.cdp('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${PU_CHROME_MAJOR}.0.0.0 Safari/537.36',
    acceptLanguage: 'ko-KR,ko,en-US,en',
    platform: 'Linux',
    userAgentMetadata: {
      brands: [{brand: 'Google Chrome', version: '${PU_CHROME_MAJOR}'}, {brand: 'Chromium', version: '${PU_CHROME_MAJOR}'}, {brand: 'Not A(Brand', version: '8'}],
      fullVersionList: [{brand: 'Google Chrome', version: '${PU_CHROME_FULL}'}, {brand: 'Chromium', version: '${PU_CHROME_FULL}'}, {brand: 'Not A(Brand', version: '8.0.0.0'}],
      fullVersion: '${PU_CHROME_FULL}',
      platform: 'Linux', platformVersion: '', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false
    }
  }); } catch (e) { /* 래퍼 플래그·프로필 기본값이 남는다 */ }
JSEOF
)
navjs() { # url-json settle-ms
  cat <<JSEOF
  try { await p.goto(${1}); } catch (e) { /* committed — 계속 */ }
  {
    const dl = Date.now() + ${2};
    let prev = -1, same = 0;
    while (Date.now() < dl) {
      let n = 0;
      try { n = await p.evaluate(() => (document.body ? (document.body.innerText || '').trim().length : 0)); } catch (e) {}
      if (n >= 1500) break;
      if (n >= 200 && n === prev) { if (++same >= 3) break; } else same = 0;
      prev = n;
      await new Promise(r => setTimeout(r, 150));
    }
  }
JSEOF
}
# CSS 경로 생성기 (페이지 안에서 실행). data-pu-id 가 있으면 ref로도 가리킬 수 있다.
CSSPATHFN=$(cat <<'JSEOF'
const __cssp = (el) => {
  const parts = []; let cur = el, depth = 0;
  while (cur && cur.nodeType === 1 && depth < 6) {
    if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
    let sel = cur.tagName.toLowerCase();
    const cls = (typeof cur.className === 'string' ? cur.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) sel += '.' + cls.map(c => CSS.escape(c)).join('.');
    const par = cur.parentElement;
    if (par) {
      const same = Array.from(par.children).filter(c => c.tagName === cur.tagName);
      if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
    }
    parts.unshift(sel); cur = cur.parentElement; depth++;
  }
  return parts.join(' > ');
};
JSEOF
)
SETTLE_MS=${PU_SETTLE_MS:-4000}
[ "${PU_SETTLE:-}" = "0" ] && SETTLE_MS=0

# ---------------------------------------------------------------- read / open
if [ "${1:-}" = "open" ] || [ "${1:-}" = "read" ]; then
  MODE=$1; shift
  URL=${1:?usage: run.sh open|read <url>}
  arm_idle
  URLJSON=$(jstr "$URL")
  TMPJS=$(mktemp "$TMPDIR/pu-XXXXXX.js")
  RAW=$(mktemp "$TMPDIR/pu-raw-XXXXXX.txt")
  OUT=$(mktemp "$TMPDIR/pu-out-XXXXXX.txt")
  trap 'rm -f "$TMPJS" "$RAW" "$OUT"' EXIT
  if [ "$MODE" = "open" ] && [ "${PU_MARKS:-1}" != "0" ]; then
    MARKJS=$(cat <<JSEOF
  try {
$CSSPATHFN
    const __el = await p.elements();
    const __paths = await p.evaluate(() => {
$CSSPATHFN
      const o = {};
      document.querySelectorAll('[data-pu-id]').forEach(e => { o[e.getAttribute('data-pu-id')] = __cssp(e); });
      return o;
    });
    for (const it of (__el.elements || [])) {
      const t = String(it.text || it.label || it.placeholder || it.value || '').replace(/\\s+/g, ' ').slice(0, 60);
      console.log('%%MARK%% ref=' + it.id + ' sel=' + (__paths[it.id] || '') + ' tag=' + it.kind + (it.href ? ' href=' + it.href : '') + ' text="' + t + '"');
    }
  } catch (e) { console.warn('marks failed: ' + e.message); }
JSEOF
)
  else
    MARKJS=''
  fi
  run_attempt() { # snapcall trimmode -> $OUT
    local snapcall="$1" trim="$2" rc=0
    cat > "$TMPJS" <<EOF
let t;
try {
  t = await taskSpace("ub" + Date.now());
  const p = await t.newPage();
$UAJS
$(navjs "$URLJSON" "$SETTLE_MS")
  console.log($snapcall);
$MARKJS
} finally {
  if (t) { try { await t.finish({keep: []}); } catch (e) {} }
}
EOF
    run_client "$TMPJS" > "$RAW" || rc=$?
    if [ $rc -eq 0 ]; then
      python3 "$HERE/snaptrim.py" "$trim" < "$RAW" > "$OUT" || cp "$RAW" "$OUT"
    fi
    return $rc
  }

  VIA=-
  if [ "$MODE" = "read" ]; then
    RC=0; run_attempt 'await p.snapshot({scope: "full_page"})' text || RC=$?
    VIA=full
    CHARS=0; [ $RC -eq 0 ] && CHARS=$(wc -m < "$OUT")
    if [ $RC -ne 0 ] || [ "$CHARS" -lt 100 ]; then
      RC2=0; run_attempt 'await p.snapshot()' text || RC2=$?
      CHARS2=0; [ $RC2 -eq 0 ] && CHARS2=$(wc -m < "$OUT")
      if [ $RC2 -eq 0 ] && [ "$CHARS2" -ge "$CHARS" ]; then RC=$RC2; CHARS=$CHARS2; VIA=viewport; fi
    fi
  else
    RC=0; run_attempt 'await p.snapshot()' trim || RC=$?
    CHARS=0; [ $RC -eq 0 ] && CHARS=$(wc -m < "$OUT")
  fi

  if [ $RC -ne 0 ]; then
    if [ $RC -eq 124 ]; then CODE=F-TIMEOUT; else CODE=F-NET; fi
    head -30 "$RAW" >&2
    result_line "$MODE" fail "$CODE" 0 none
    exit 1
  fi
  CODE=$(pu_detect_code "$OUT")
  [ "$CODE" = "-" ] && CODE=$(pu_detect_auth "$OUT" "$CHARS")
  if [ "$CODE" != "-" ]; then
    [ "${PU_DEBUG:-}" = "1" ] && cat "$OUT" >&2
    result_line "$MODE" fail "$CODE" "$CHARS" "$(next_for_code "$CODE")"; exit 1
  fi
  if [ "$MODE" = "read" ] && [ "$CHARS" -lt 100 ]; then
    [ "${PU_DEBUG:-}" = "1" ] && cat "$OUT" >&2
    result_line "$MODE" fail F-EMPTY "$CHARS" builtin-browser; exit 1
  fi
  cat "$OUT"
  printf '\n'
  result_line "$MODE" ok - "$CHARS" none
  exit 0
fi

# ---------------------------------------------------------------- actions
case "${1:-}" in
  click|type|scroll|shot|extract)
    ACT=$1; shift
    URL=${1:?usage: run.sh $ACT <url> ...}; shift
    arm_idle
    URLJSON=$(jstr "$URL")
    PROBE=$(mktemp "$TMPDIR/probe-XXXXXX.txt")
    META=$(mktemp "$TMPDIR/meta-XXXXXX.json")
    ITEMS=$(mktemp "$TMPDIR/items-XXXXXX.json")
    TMPJS=$(mktemp "$TMPDIR/act-XXXXXX.js")
    RAW=$(mktemp "$TMPDIR/act-raw-XXXXXX.txt")
    OUTPNG=''
    trap 'rm -f "$PROBE" "$META" "$ITEMS" "$TMPJS" "$RAW" $OUTPNG' EXIT
    ACTIONJS=''
    case "$ACT" in
      click)
        REF=${1:?usage: run.sh click <url> <ref|css-selector>}
        REFJSON=$(jstr "$REF")
        ACTIONJS=$(cat <<JSEOF
  Object.assign(__EXTRA__, { target: ${REFJSON} });
  await p.elements().catch(() => ({}));   // data-pu-id 부여 (ref 문자열이면 그대로 쓴다)
  const __st = await p.evaluate((t) => {
    const e = /^e\\d+$/.test(t) ? document.querySelector('[data-pu-id="' + t + '"]') : document.querySelector(t);
    if (!e) return null;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    return { tag: e.tagName.toLowerCase(), tagId: e.getAttribute('data-pu-id') || null };
  }, ${REFJSON});
  if (!__st) { __MISSING__ = 'selector_not_found'; }
  else {
    const __r = await p.click(/^e\\d+$/.test(${REFJSON}) ? ${REFJSON} : { selector: ${REFJSON} });
    __EXTRA__.clicked = __r.clicked || __st.tag;
    await new Promise(r => setTimeout(r, 2000));
  }
JSEOF
        )
        ;;
      type)
        REF=${1:?usage: run.sh type <url> <ref|css-selector> <text>}
        TEXT=${2:?usage: run.sh type <url> <ref|css-selector> <text>}
        REFJSON=$(jstr "$REF"); TEXTJSON=$(jstr "$TEXT")
        ACTIONJS=$(cat <<JSEOF
  Object.assign(__EXTRA__, { target: ${REFJSON} });
  await p.elements().catch(() => ({}));
  const __f = await p.evaluate((t) => {
    const e = /^e\\d+$/.test(t) ? document.querySelector('[data-pu-id="' + t + '"]') : document.querySelector(t);
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    return { type: (e.getAttribute('type') || '').toLowerCase(), tagId: e.getAttribute('data-pu-id') || null };
  }, ${REFJSON});
  if (!__f) { __MISSING__ = 'selector_not_found'; }
  else if (__f.type === 'password') { __EXTRA__.refused = 'password_field'; }
  else {
    await p.type(/^e\\d+$/.test(${REFJSON}) ? ${REFJSON} : { selector: ${REFJSON} }, ${TEXTJSON}, { clear: true });
    await new Promise(r => setTimeout(r, 300));
    __EXTRA__.value = await p.evaluate((t) => {
      const e = /^e\\d+$/.test(t) ? document.querySelector('[data-pu-id="' + t + '"]') : document.querySelector(t);
      return e && 'value' in e ? String(e.value).slice(0, 80) : null;
    }, ${REFJSON});
  }
JSEOF
        )
        ;;
      scroll)
        N=${1:-5}
        case "$N" in ''|*[!0-9]*) N=5 ;; esac
        ACTIONJS=$(cat <<JSEOF
  Object.assign(__EXTRA__, { scrolls: ${N} });
  for (let i = 0; i < ${N}; i++) {
    await p.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 450));
  }
  await new Promise(r => setTimeout(r, 600));
  __EXTRA__.scrollY = await p.evaluate(() => Math.round(window.scrollY));
JSEOF
        )
        ;;
      shot)
        OUTPNG=${1:?usage: run.sh shot <url> <out.png>}
        case "$OUTPNG" in /*) ;; *) OUTPNG="$PWD/$OUTPNG" ;; esac
        PNGJSON=$(jstr "$OUTPNG")
        ACTIONJS=$(cat <<JSEOF
  {
    const __b64 = await p.screenshot();
    const __fs2 = await import('node:fs');
    __fs2.writeFileSync(${PNGJSON}, Buffer.from(__b64, 'base64'));
    Object.assign(__EXTRA__, { path: ${PNGJSON} });
  }
JSEOF
        )
        ;;
      extract)
        SEL=${1:?usage: run.sh extract <url> <css-selector>}
        SELJSON=$(jstr "$SEL"); ITEMJSON=$(jstr "$ITEMS")
        ACTIONJS=$(cat <<JSEOF
  Object.assign(__EXTRA__, { selector: ${SELJSON} });
  await p.elements().catch(() => ({}));   // data-pu-id 부여 → ref 표식
  const __it = await p.evaluate((s) => {
$CSSPATHFN
    const out = [];
    for (const el of document.querySelectorAll(s)) {
      if (out.length >= 200) break;
      const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      const o = { i: out.length + 1, ref: el.getAttribute('data-pu-id') || null, sel: __cssp(el), text: t };
      if (el.href) o.href = String(el.href).slice(0, 500);
      if (el.getAttribute && el.getAttribute('src')) o.src = el.getAttribute('src').slice(0, 500);
      out.push(o);
    }
    return out;
  }, ${SELJSON});
  __EXTRA__.count = __it.length;
  {
    const __fs3 = await import('node:fs');
    __fs3.writeFileSync(${ITEMJSON}, JSON.stringify(__it));
  }
JSEOF
        )
        ;;
    esac

    cat > "$TMPJS" <<EOF
let t;
let __EXTRA__ = {};
let __MISSING__ = null;
const __fs = await import('node:fs');
try {
  t = await taskSpace("ub" + Date.now());
  const p = await t.newPage();
$UAJS
$(navjs "$URLJSON" "$SETTLE_MS")
$ACTIONJS
  let __pr = null;
  try {
    __pr = await p.evaluate(() => {
      const b = document.body ? (document.body.innerText || '') : '';
      const h = document.documentElement ? document.documentElement.outerHTML : '';
      return { url: location.href, title: document.title, chars: b.trim().length,
        pw: !!document.querySelector('input[type="password"]'),
        head: (document.title + '\n' + h.slice(0, 6000)) };
    });
  } catch (e) { __pr = null; }
  const __meta = __pr
    ? Object.assign({ url: __pr.url, title: __pr.title, chars: __pr.chars, pw: __pr.pw }, __EXTRA__, __MISSING__ ? { missing: __MISSING__ } : {})
    : Object.assign({ url: '', title: '', chars: 0, pw: false }, __EXTRA__, __MISSING__ ? { missing: __MISSING__ } : {});
  if (__pr) __fs.writeFileSync($(jstr "$PROBE"), __pr.head);
  __fs.writeFileSync($(jstr "$META"), JSON.stringify(__meta));
} finally {
  if (t) { try { await t.finish({keep: []}); } catch (e) {} }
}
EOF
    RC=0; run_client "$TMPJS" > "$RAW" || RC=$?
    if [ $RC -ne 0 ]; then
      CODE=F-NET; [ $RC -eq 124 ] && CODE=F-TIMEOUT
      head -20 "$RAW" >&2
      result_line "$ACT" fail "$CODE" 0 none "url=$URL"
      exit 1
    fi
    NCHARS=$(jget "$META" chars); [ -n "$NCHARS" ] || NCHARS=0
    FINALURL=$(jget "$META" url)
    case "$FINALURL" in chrome-error:*) echo "run.sh: 브라우저 오류 페이지 (대상 없음/연결 실패)" >&2; result_line "$ACT" fail F-NET 0 none "url=$FINALURL"; exit 1 ;; esac
    MISSING=$(jget "$META" missing)
    REFUSED=$(jget "$META" refused)
    CODE=$(pu_detect_code "$PROBE")
    [ "$CODE" = "-" ] && CODE=$(pu_detect_auth "$PROBE" "$NCHARS")
    if [ -n "$REFUSED" ]; then
      echo "run.sh: 비밀번호 필드는 이 빌드가 채우지 않는다 — 내장 브라우저 + vault 몫" >&2
      result_line "$ACT" fail F-AUTH "$NCHARS" builtin-browser-vault "url=$FINALURL"
      exit 1
    fi
    if [ "$CODE" != "-" ]; then
      result_line "$ACT" fail "$CODE" "$NCHARS" "$(next_for_code "$CODE")" "url=$FINALURL"
      exit 1
    fi
    if [ -n "$MISSING" ]; then
      result_line "$ACT" fail F-SELECTOR 0 none "url=$FINALURL"
      exit 1
    fi
    case "$ACT" in
      extract) cat "$ITEMS"; printf '\n' ;;
      type) echo "$FINALURL (chars=$NCHARS) value=\"$(jget "$META" value)\"" ;;
      shot)
        BYTES=$(python3 -c 'import os,sys; print(os.path.getsize(sys.argv[1]) if os.path.exists(sys.argv[1]) else 0)' "$OUTPNG")
        if [ "${BYTES:-0}" -le 0 ]; then result_line "$ACT" fail F-EMPTY 0 none "url=$FINALURL path=$OUTPNG"; exit 1; fi
        echo "$OUTPNG ($BYTES bytes)" ;;
      *) echo "$FINALURL ($NCHARS chars)" ;;
    esac
    result_line "$ACT" ok - "$NCHARS" none "url=$FINALURL"
    exit 0 ;;
esac

# ---------------------------------------------------------------- batch-urls
if [ "${1:-}" = "batch-urls" ]; then
  shift
  LIST=${1:?usage: run.sh batch-urls <url-file>}
  [ -f "$LIST" ] || { echo "run.sh: 목록 파일 없음: $LIST" >&2; exit 1; }
  STEPS=$(mktemp "$TMPDIR/steps-XXXXXX.txt")
  trap 'rm -f "$STEPS"' EXIT
  while IFS= read -r U || [ -n "$U" ]; do
    U=$(printf '%s' "$U" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -z "$U" ] && continue
    case "$U" in \#*) continue ;; esac
    case "$U" in *[[:space:]]*) echo "batch-urls: 공백 포함 URL 건너뜀: $U" >&2; continue ;; esac
    echo "read $U" >> "$STEPS"
  done < "$LIST"
  BOUT=$(mktemp "$TMPDIR/batch-out-XXXXXX.txt")
  BRC=0
  "$HERE/batch.sh" "$STEPS" > "$BOUT" 2>/dev/null || BRC=$?
  # 단계 헤더의 URL을 그 단계의 %%CHAIN%% 줄에 url= 로 붙인다 (URL마다 한 줄 계약).
  python3 - "$BOUT" <<'PY'
import sys, re
cur = ""
for line in open(sys.argv[1]):
    s = line.rstrip("\n")
    m = re.match(r"%%BATCH-STEP%% \d+ (?:read|open) (\S+)", s)
    if m:
        cur = m.group(1)
    if s.startswith("%%CHAIN%%") and " url=" not in s:
        s = s.replace(" next=", " url=" + cur + " next=")
    print(s)
PY
  rm -f "$BOUT"
  exit $BRC
fi
# ---------------------------------------------------------------- raw JS
arm_idle
if [ "${1:-}" = "-f" ]; then
  RC=0; run_client "${2:?usage: run.sh -f <script.js>}" || RC=$?
  result_line js "$([ $RC -eq 0 ] && echo ok || echo fail)" "$([ $RC -eq 124 ] && echo F-TIMEOUT || echo -)" 0 none
  [ $RC -eq 0 ] && exit 0 || exit 1
fi
if [ -n "${1:-}" ]; then
  TMPJS=$(mktemp "$TMPDIR/pu-XXXXXX.js")
  printf '%s\n' "$1" > "$TMPJS"
  RC=0; run_client "$TMPJS" || RC=$?
  rm -f "$TMPJS"
  result_line js "$([ $RC -eq 0 ] && echo ok || echo fail)" "$([ $RC -eq 124 ] && echo F-TIMEOUT || echo -)" 0 none
  [ $RC -eq 0 ] && exit 0 || exit 1
fi
usage >&2
exit 2
