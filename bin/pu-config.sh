# pu-config.sh — path resolution for Pickle Ultra Browser.
# Sourced by run.sh, chrome-wrapper.sh, fetch.sh, chain.sh, idle-stop.sh, doctor.sh.
# This build is a direct-egress tree: proxy, relay and NSS branches of the
# earlier harness build were removed. What is left is path resolution only —
# node / chromium / shared libraries, the state directory, and TMPDIR
# (kept inside the tree because /tmp is often a small tmpfs).
# shellcheck shell=bash

# This file lives in <tree>/bin/, and every script path is relative to it.
PU_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Tree root (<tree>/): config.env, .state/, docs/, README.md live here.
PU_HOME="$(dirname "$PU_BIN")"
# Parent of the tree. Default is the tree's parent directory.
PU_ROOT="${PU_ROOT:-$(dirname "$PU_HOME")}"
# Where node / awk / chrome-deps live (pickle-bootstrap.sh fills this in).
PU_TOOLS="${PU_TOOLS:-$PU_HOME/.tools}"

if [ -f "$PU_HOME/config.env" ]; then
  set -a; . "$PU_HOME/config.env"; set +a
fi

export PATH="$PU_TOOLS/node/bin:$PU_TOOLS/bin:$PATH"
command -v node >/dev/null 2>&1 || \
  echo "pu-config: node not found — run pickle-bootstrap.sh first ($PU_TOOLS/node/bin)" >&2

# awk is used for elapsed_s. Some slim images ship mawk without the awk name;
# link it into $PU_TOOLS/bin once instead of failing every timing call.
if ! command -v awk >/dev/null 2>&1; then
  if command -v mawk >/dev/null 2>&1 && mkdir -p "$PU_TOOLS/bin" 2>/dev/null; then
    [ -e "$PU_TOOLS/bin/awk" ] || ln -s "$(command -v mawk)" "$PU_TOOLS/bin/awk" 2>/dev/null || true
    command -v awk >/dev/null 2>&1 || export PATH="$PU_TOOLS/bin:$PATH"
  fi
fi

# --- directories -----------------------------------------------------------
# State (socket, pid, logs, profile) lives in <tree>/.state/. Nothing secret
# is stored here — it is runtime output only.
PICKLE_ULTRA_STATE_DIR="${PICKLE_ULTRA_STATE_DIR:-$PU_HOME/.state}"
PICKLE_ULTRA_PROFILE="${PICKLE_ULTRA_PROFILE:-$PICKLE_ULTRA_STATE_DIR/profile}"
PU_TMP="${PU_TMP:-$PU_HOME/.tmp}"
mkdir -p "$PICKLE_ULTRA_STATE_DIR" "$PU_TMP" 2>/dev/null || true
export TMPDIR="$PU_TMP"
export PICKLE_ULTRA_STATE_DIR PICKLE_ULTRA_PROFILE
# Tree root as the intake tooling sees it; the local intake form lives here
# (inbox.tsv / inbox.csv, mode 0600, git-ignored).
export PICKLE_ULTRA_HOME="${PICKLE_ULTRA_HOME:-$PU_HOME}"
# Chain route cache (runtime state, L1 results only).
export PU_ROUTE_CACHE="${PU_ROUTE_CACHE:-$PICKLE_ULTRA_STATE_DIR/route-cache.json}"

# --- shared libraries ------------------------------------------------------
# Chromium needs libnss3/libnspr4 and friends that a slim image may lack.
# vendor/fetch_chrome_deps.py extracts them (no root) into $PU_TOOLS/chrome-deps/lib.
if [ -d "$PU_TOOLS/chrome-deps/lib" ]; then
  export LD_LIBRARY_PATH="$PU_TOOLS/chrome-deps/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# --- Chromium binary -------------------------------------------------------
# PICKLE_ULTRA_CHROME (config.env) > CHROME_BIN env > Playwright cache
# (PLAYWRIGHT_BROWSERS_PATH > $HOME/.cache/ms-playwright > $PU_ROOT/.cache/ms-playwright)
# > PATH. If several exist, the newest revision wins. On failure the attempted
# paths go to stderr.
pu_resolve_chrome() {
  local c d root
  for c in "${PICKLE_ULTRA_CHROME:-}" "${CHROME_BIN:-}"; do
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  local roots=()
  [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && roots+=("$PLAYWRIGHT_BROWSERS_PATH")
  roots+=("$HOME/.cache/ms-playwright" "$PU_ROOT/.cache/ms-playwright")
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    c=$(ls -d "$root"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
    c=$(ls -d "$root"/chromium_headless_shell-*/chrome-linux*/headless_shell 2>/dev/null | sort -V | tail -1)
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  for c in google-chrome-stable google-chrome chromium chromium-browser chrome; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  {
    echo "pu-config: no Chromium binary found. Attempted paths:"
    echo "  - \$PICKLE_ULTRA_CHROME / \$CHROME_BIN (missing or not executable)"
    echo "  - Playwright cache: ${roots[*]}"
    echo "  - PATH"
    echo "Fix: bash pickle-bootstrap.sh (or set PICKLE_ULTRA_CHROME=<path> in config.env)"
  } >&2
  return 1
}

# Full Chromium version ("159.0.8154.6"); empty on failure.
pu_chrome_full_version() { "$1" --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){3}' | head -1; }
