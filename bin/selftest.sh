#!/usr/bin/env bash
# selftest.sh — offline 3-lane check, no internet and no login needed.
#
# Builds three local pages and runs `chain.sh read` against each:
#   normal.html    a normal page          -> exit 0, next=none
#   blocked.html   a bot challenge page   -> exit 3, code=F-BOT, next=builtin-browser
#   login.html     a password login wall  -> exit 4, code=F-AUTH, next=builtin-browser-vault
#
# The blocked case needs Chromium (the L1 lane runs after L0 sees the
# challenge); when no Chromium is found that case is SKIPped and the rest
# still run.
#
#   bash bin/selftest.sh
# Exit code: 0 when every executed case passed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/pu-config.sh"

T="$(mktemp -d "$TMPDIR/selftest-XXXXXX")" || exit 1
trap 'rm -rf "$T"' EXIT

cat > "$T/normal.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Normal page</title></head>
<body><main><h1>Inventory report</h1><p>This is an ordinary public page used by the selftest.
It contains enough body text that the L0 fetcher treats it as a real document rather than an
empty shell. The lane chain should finish at L0 with status ok and next=none.</p>
<p>Row 1: 12 units. Row 2: 7 units. Row 3: 31 units. Row 4: 4 units. Row 5: 18 units.</p>
<p>End of the normal page fixture.</p></main></body></html>
HTML

cat > "$T/blocked.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Just a moment...</title></head>
<body><h1>Checking your browser before accessing example.test</h1>
<p>Please enable JavaScript and cookies to continue. Verifying you are human.</p></body></html>
HTML

cat > "$T/login.html" <<'HTML'
<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body><h1>로그인이 필요합니다</h1>
<p>아이디와 비밀번호를 입력해 주세요.</p>
<form><input name="id"><input type="password" name="pw"><button>로그인</button></form></body></html>
HTML

NPASS=0; NFAIL=0; NSKIP=0
pass() { NPASS=$((NPASS+1)); printf 'PASS  %-8s %s\n' "$1" "$2"; }
fail() { NFAIL=$((NFAIL+1)); printf 'FAIL  %-8s %s\n' "$1" "$2"; }
skip() { NSKIP=$((NSKIP+1)); printf 'SKIP  %-8s %s\n' "$1" "$2"; }

check() { # name file expect_exit expect_code expect_next
  local name="$1" file="$2" want_rc="$3" want_code="$4" want_next="$5" out rc line
  out="$(bash "$HERE/chain.sh" read "file://$T/$file" 2>/dev/null)"; rc=$?
  line="$(printf '%s\n' "$out" | grep '^%%CHAIN%%' | tail -1)"
  if [ "$rc" != "$want_rc" ]; then
    fail "$name" "exit $rc (expected $want_rc)"; return
  fi
  case "$line" in *" code=$want_code "*) ;; *) fail "$name" "code mismatch in: ${line:-<no verdict line>}"; return ;; esac
  case "$line" in *" next=$want_next"*) ;; *) fail "$name" "next mismatch in: $line"; return ;; esac
  pass "$name" "exit $rc ${want_code} next=$want_next"
}

echo "selftest: Pickle Ultra Browser — $HERE"
check "normal"  normal.html  0 "-"       "none"
if pu_resolve_chrome >/dev/null 2>&1; then
  check "blocked" blocked.html 3 "F-BOT"  "builtin-browser"
else
  skip "blocked" "no Chromium — run pickle-bootstrap.sh, then re-run"
fi
check "login"   login.html   4 "F-AUTH" "builtin-browser-vault"

echo "----"
echo "selftest: PASS=$NPASS FAIL=$NFAIL SKIP=$NSKIP"
[ "$NFAIL" -eq 0 ]
