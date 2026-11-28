#!/usr/bin/env bash
# detect-code.sh — backward-compatible shim over bin/detect-page.py.
#
# The verdict itself lives in bin/detect-page.py (one engine for L0 curl, L1
# real-DOM and plain text). This file keeps the old function names working for
# any script that still sources it:
#
#   pu_detect_code <file>          -> F-IP | F-BOT | -      (plain text file)
#   pu_detect_auth <file> [chars]  -> F-AUTH | -            (HTML file)
#   ./detect-code.sh <file>        -> prints the code
#
# Engine failures (crash, empty output, unparsable JSON, a code outside the
# documented set) are reported as F-DETECT, never as "-" (PUB-203). "-" keeps
# its old single meaning: the engine judged the page and found no block.
#
# Old behaviour that was wrong (fixed 2026-11-27): both functions grepped for
# keywords, so a document *about* "access denied" was reported blocked, and a
# password field written `type = 'password'` was invisible to the regex.
# Prefer calling detect-page.py directly — it also sees the HTTP status, the
# <title>, challenge markers and the page shape.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_pu_engine() { python3 "${PU_DETECT_ENGINE:-$HERE/detect-page.py}" "$@" 2>/dev/null; }

_pu_code_of() { # json -> code (F-DETECT when the engine did not answer)
  python3 -c 'import json,sys
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
print(code)'
}

# Plain-text verdict (no HTTP status, no title available): the text-only
# heuristic keeps the long-document guard, so a long page stays readable.
pu_detect_code() {
  local f="${1:?usage: pu_detect_code <text-file>}"
  _pu_engine --mode text --text-file "$f" | _pu_code_of
}

# HTML verdict: full structural engine. [chars] is accepted for compatibility
# and ignored — the engine measures the text itself.
pu_detect_auth() {
  local f="${1:?usage: pu_detect_auth <html-file>}"
  local code
  code=$(_pu_engine --mode l0 --html "$f" | _pu_code_of)
  case "$code" in
    F-AUTH)   echo F-AUTH ;;
    F-DETECT) echo F-DETECT ;;
    *)        echo - ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  pu_detect_code "${1:?usage: detect-code.sh <file>}"
fi
