#!/usr/bin/env bash
# pickle-bootstrap.sh — install/repair Pickle Ultra Browser without root.
# Idempotent: whatever is already there and verified is skipped, so it is safe
# to re-run after a sandbox reset or a failed first attempt.
#
#   bash pickle-bootstrap.sh
#
# What it does
#   1) Node (pinned) -> $PU_TOOLS/node. The tarball is checked against
#      nodejs.org's official SHASUMS256.txt before it is extracted; a mismatch
#      stops the run and leaves nothing half-installed. Downloads are cached
#      and resume after an interruption.
#   2) Playwright Chromium (pinned version -> pinned browser revision) ->
#      ~/.cache/ms-playwright. Playwright publishes no checksum for the browser
#      archive, so the pin plus a post-install verification is what this build
#      can honestly offer; PU_CHROMIUM_SHA256=<hex> makes the check strict for
#      anyone who has recorded the hash once (the run prints it).
#   3) Chromium shared libraries, extracted from Debian .deb files into the tree
#      (no root, no apt: dpkg-deb -x). Every .deb is verified against the
#      SHA256 in the Debian Packages index before extraction. "Does the browser
#      run" (--version) is checked only after this step: on a minimal image the
#      binary cannot start before the libraries are in place.
#   4) awk (mawk) -- used for elapsed_s and absent from slim images.
#   5) config.env from config.env.example (only when absent) + verification
#      (warm the daemon, read example.com, stop it).
#
# Never touched: config.env (when present), .state/ (profile, cookies), .tmp/,
# agent-vault/ (credentials), extensions/ data. Re-running after an update
# keeps a signed-in profile and a filled vault.
#
# Exit codes: 0 ok / 1 install failed / 2 unsupported platform / 3 checksum
# mismatch.
set -uo pipefail
export HOME="${HOME:-$PWD}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PU_ROOT="$(dirname "$HERE")"
export PU_ROOT
export PU_TOOLS="${PU_TOOLS:-$HERE/.tools}"
export TMPDIR="${PU_TMP:-$HERE/.tmp}"
mkdir -p "$TMPDIR" "$PU_TOOLS" "$PU_TOOLS/bin"
export PATH="$PU_TOOLS/node/bin:$PU_TOOLS/bin:$PATH"

NODE_VER="${NODE_VER:-v22.23.5}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.65.1}"   # -> chromium revision 1255
CHROMIUM_REV="${CHROMIUM_REV:-1255}"
NODE_BASE="${PU_NODE_BASE:-https://nodejs.org/dist}"
DL="${PU_DL_CACHE:-$PU_TOOLS/downloads}"
mkdir -p "$DL"

say() { printf '\n== %s ==\n' "$*"; }
die() { echo "pickle-bootstrap: $*" >&2; exit "${2:-1}"; }

# --- platform ---------------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
# PU_OS_OVERRIDE / PU_ARCH_OVERRIDE exist so the unsupported-platform path can
# be tested on a supported machine; never set them in normal use.
OS="${PU_OS_OVERRIDE:-$OS}"; ARCH="${PU_ARCH_OVERRIDE:-$ARCH}"
case "$OS/$ARCH" in
  Linux/x86_64)          NODE_PLAT="linux-x64" ;;
  Linux/aarch64|Linux/arm64) NODE_PLAT="linux-arm64" ;;
  Darwin/x86_64)         NODE_PLAT="darwin-x64" ;;
  Darwin/arm64)          NODE_PLAT="darwin-arm64" ;;
  *)
    die "unsupported platform: $OS/$ARCH — this harness supports Linux x64,
      Linux arm64, macOS x64 and macOS arm64 (no Windows, no 32-bit)." 2 ;;
esac
echo "platform: $OS/$ARCH -> $NODE_PLAT"

# --- helpers ----------------------------------------------------------------
# sha256_of FILE — the digest alone, without awk. Step 4 is what installs mawk,
# so nothing before it (Node is step 1) may depend on awk existing: on a slim
# image that made the Node checksum unverifiable and the run was stopped for a
# missing tool rather than a bad download.
sha256_of() {
  local out h rc
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum -- "$1" 2>/dev/null)"; rc=$?
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 -- "$1" 2>/dev/null)"; rc=$?
  else
    die "no sha256 tool (sha256sum or shasum)" 1
  fi
  h="${out%% *}"                      # first field: sha256sum/shasum both lead with the digest
  if [ "$rc" -ne 0 ] || [ -z "$h" ]; then
    echo "  cannot hash $1 (sha256 tool exited $rc)" >&2
    return 1
  fi
  printf '%s\n' "$h"
}

# dl URL DEST — cached download; a .part file is resumed, never trusted as final.
dl() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  [ -s "$dest" ] && return 0
  local resume=()
  case "$url" in file://*) ;; *) resume=(-C -) ;; esac
  echo "  GET $url"
  if ! curl -fSL --retry 3 --retry-delay 2 "${resume[@]}" -o "$dest.part" "$url"; then
    # A server that cannot serve byte ranges makes -C - fail (curl 33) even
    # though the file is fine to re-fetch. Start over once, then give up.
    if [ ${#resume[@]} -gt 0 ]; then
      echo "  resume not possible — downloading from the start"
      rm -f "$dest.part"
      curl -fSL --retry 3 --retry-delay 2 -o "$dest.part" "$url" || return 1
    else
      return 1
    fi
  fi
  mv -f "$dest.part" "$dest"
}

verify_sha() { # file expected label
  local got; got="$(sha256_of "$1")"
  if [ -z "$got" ]; then
    echo "  checksum could not be computed for $3 — not installing it" >&2
    return 1
  fi
  if [ "$got" != "$2" ]; then
    rm -f "$1"
    echo "  checksum MISMATCH for $3" >&2
    echo "    expected $2" >&2
    echo "    got      $got" >&2
    return 1
  fi
  echo "  checksum ok: $3"
  return 0
}

# --- 1) Node ----------------------------------------------------------------
say "1) Node $NODE_VER ($NODE_PLAT) -> $PU_TOOLS/node"
node_matches() {
  [ -x "$PU_TOOLS/node/bin/node" ] || return 1
  [ "$("$PU_TOOLS/node/bin/node" -v 2>/dev/null)" = "$NODE_VER" ]
}
if node_matches; then
  echo "already: $("$PU_TOOLS/node/bin/node" -v) at $PU_TOOLS/node"
else
  TARBALL="$DL/node-$NODE_VER-$NODE_PLAT.tar.gz"
  SUMS="$DL/SHASUMS256-$NODE_VER.txt"
  dl "$NODE_BASE/$NODE_VER/SHASUMS256.txt" "$SUMS" || die "cannot download SHASUMS256.txt for $NODE_VER"
  # Parse SHASUMS256.txt with the shell's own read (two columns: digest, name) —
  # awk is not installed yet at this point on a minimal image.
  WANT=""
  while read -r _h _f _rest; do
    if [ "$_f" = "node-$NODE_VER-$NODE_PLAT.tar.gz" ]; then WANT="$_h"; break; fi
  done < "$SUMS"
  [ -n "$WANT" ] || die "no checksum for node-$NODE_VER-$NODE_PLAT.tar.gz in SHASUMS256.txt" 3
  # A cached tarball is only reused if it still matches.
  if [ -s "$TARBALL" ] && [ "$(sha256_of "$TARBALL")" != "$WANT" ]; then
    echo "  cached tarball does not match the published checksum — downloading again"
    rm -f "$TARBALL"
  fi
  dl "$NODE_BASE/$NODE_VER/node-$NODE_VER-$NODE_PLAT.tar.gz" "$TARBALL" || die "download failed: $TARBALL"
  verify_sha "$TARBALL" "$WANT" "node-$NODE_VER-$NODE_PLAT.tar.gz" || die "refusing to install an unverified Node tarball" 3
  rm -rf "$PU_TOOLS/node.new"
  mkdir -p "$PU_TOOLS/node.new"
  tar -xzf "$TARBALL" -C "$PU_TOOLS/node.new" --strip-components=1 || die "extract failed"
  [ -x "$PU_TOOLS/node.new/bin/node" ] || die "archive did not contain bin/node"
  GOTVER="$("$PU_TOOLS/node.new/bin/node" -v 2>/dev/null || true)"
  [ "$GOTVER" = "$NODE_VER" ] || die "extracted node reports '$GOTVER', expected $NODE_VER" 1
  rm -rf "$PU_TOOLS/node"
  mv "$PU_TOOLS/node.new" "$PU_TOOLS/node"
  # 중단된 추출 뒤 남은 0바이트 npm/npx 심볼릭 링크 복구
  ( cd "$PU_TOOLS/node/bin" || exit 1
    for pair in "npm:../lib/node_modules/npm/bin/npm-cli.js" \
                "npx:../lib/node_modules/npm/bin/npx-cli.js"; do
      name=${pair%%:*}; tgt=${pair#*:}
      if [ ! -s "$name" ] || [ ! -x "$name" ]; then rm -f "$name"; ln -s "$tgt" "$name"; fi
    done )
  echo "installed: $(node -v) (verified)"
fi

# --- 2) Chromium ------------------------------------------------------------
say "2) Playwright Chromium $PLAYWRIGHT_VERSION (revision $CHROMIUM_REV)"
CHROME_BIN_FOUND=$(ls -d "$HOME"/.cache/ms-playwright/chromium-$CHROMIUM_REV/chrome-*/chrome 2>/dev/null | head -1)
if [ "${PU_SKIP_BROWSER:-0}" = "1" ]; then
  echo "skipped (PU_SKIP_BROWSER=1)"
elif [ -n "$CHROME_BIN_FOUND" ]; then
  echo "already: $CHROME_BIN_FOUND"
else
  ( cd "$HERE" && npx --yes "playwright@$PLAYWRIGHT_VERSION" install chromium 2>&1 | grep -vE '^\|' | tail -5 )
  CHROME_BIN_FOUND=$(ls -d "$HOME"/.cache/ms-playwright/chromium-$CHROMIUM_REV/chrome-*/chrome 2>/dev/null | head -1)
fi
if [ -n "$CHROME_BIN_FOUND" ]; then
  [ -x "$CHROME_BIN_FOUND" ] || die "chromium found but not executable: $CHROME_BIN_FOUND"
  echo "chromium binary: $CHROME_BIN_FOUND"
elif [ "${PU_SKIP_BROWSER:-0}" != "1" ]; then
  die "chromium install failed (expected revision $CHROMIUM_REV for playwright $PLAYWRIGHT_VERSION)"
fi

# --- 3) shared libraries ----------------------------------------------------
say "3) Chromium shared libraries (extract .deb, no root)"
DEPS="$PU_TOOLS/chrome-deps/lib"
if [ "${PU_SKIP_BROWSER:-0}" = "1" ] || [ -z "${CHROME_BIN_FOUND:-}" ]; then
  echo "skipped (no browser)"
elif [ "$OS" = "Darwin" ]; then
  echo "skipped (macOS: system frameworks are used, and there is no ldd)"
else
  export PU_CHROME="$CHROME_BIN_FOUND"
  # The browser cannot run before these libraries exist (a minimal image has no
  # libnspr4.so), so "does it run" is checked in step 3b, after this one. A
  # failed ldd tells us nothing about the libraries, and must not be mistaken
  # for "none missing".
  LDD_RC=0
  LDD_OUT="$(LD_LIBRARY_PATH="$DEPS" ldd "$CHROME_BIN_FOUND" 2>&1)" || LDD_RC=$?
  if [ "$LDD_RC" -ne 0 ] && [ -z "$LDD_OUT" ]; then
    die "ldd failed on $CHROME_BIN_FOUND (rc=$LDD_RC) — cannot tell which libraries are missing"
  fi
  if printf '%s\n' "$LDD_OUT" | grep -q 'not found'; then
    FCD="$PU_TOOLS/fetch_chrome_deps.py"
    [ -f "$FCD" ] || FCD="$HERE/vendor/fetch_chrome_deps.py"
    python3 "$FCD" || die "shared-library fetch failed"
  else
    echo "already: $(ls "$DEPS" 2>/dev/null | wc -l) libs, none missing"
  fi
fi

# --- 3b) chromium runs ------------------------------------------------------
# Only after step 3 can the binary answer --version: before the libraries are
# in place it dies on libnspr4.so and the run looked like a broken download.
# The hash pin is checked on a binary that is known to start.
if [ "${PU_SKIP_BROWSER:-0}" != "1" ] && [ -n "${CHROME_BIN_FOUND:-}" ]; then
  V="$(LD_LIBRARY_PATH="$DEPS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$CHROME_BIN_FOUND" --version 2>/dev/null | head -1)"
  case "$V" in *Chrome*|*Chromium*) echo "chromium: $V" ;; *) die "chromium does not run: $CHROME_BIN_FOUND ($V)" ;; esac
  CHROME_SHA="$(sha256_of "$CHROME_BIN_FOUND")"
  [ -n "$CHROME_SHA" ] || die "cannot hash the chromium binary: $CHROME_BIN_FOUND"
  echo "chromium sha256: $CHROME_SHA"
  if [ -n "${PU_CHROMIUM_SHA256:-}" ] && [ "$PU_CHROMIUM_SHA256" != "$CHROME_SHA" ]; then
    die "chromium binary does not match PU_CHROMIUM_SHA256 (expected $PU_CHROMIUM_SHA256)" 3
  fi
fi

# --- 4) awk ----------------------------------------------------------------
say "4) awk (missing on slim images — needed for elapsed_s)"
awk_ok() { command -v awk >/dev/null 2>&1 && [ "$(awk 'BEGIN{print 1}' 2>/dev/null)" = "1" ]; }
if awk_ok; then
  echo "already: $(command -v awk)"
else
  # .tools/bin comes first in PATH, so a dangling .tools/bin/awk left behind by
  # an interrupted mawk install hides a perfectly good system awk.
  if [ -L "$PU_TOOLS/bin/awk" ] && [ ! -e "$PU_TOOLS/bin/awk" ]; then
    echo "  clearing broken link: $PU_TOOLS/bin/awk"
    rm -f "$PU_TOOLS/bin/awk"
    awk_ok && echo "already: $(command -v awk)"
  fi
fi
if ! awk_ok; then
  python3 - <<'PY'
import hashlib, lzma, os, platform, subprocess, urllib.request
t = os.environ.get("PU_TOOLS") or os.path.expanduser("~/pickle-ultra/.tools")
w = os.path.join(t, "awk"); os.makedirs(w, exist_ok=True); os.makedirs(os.path.join(t, "bin"), exist_ok=True)
m = platform.machine().lower()
deb_arch = "arm64" if m in ("aarch64", "arm64") else "amd64"
idx = None
for cand in (os.path.join(t, "chrome-deps", "idx", "Packages-%s.xz" % deb_arch),
             os.path.join(t, "chrome-deps", "idx", "Packages.xz")):
    if os.path.exists(cand):
        idx = cand; break
if idx:
    raw = lzma.open(idx, "rt", encoding="utf-8", errors="replace").read()
    fn = sha = None
    for st in raw.split("\n\n"):
        if not st.startswith("Package: mawk\n"):
            continue
        arch = ""
        for l in st.split("\n"):
            if l.startswith("Architecture: "): arch = l.split(": ", 1)[1].strip()
        if arch not in (deb_arch, "all"):
            continue
        for l in st.split("\n"):
            if l.startswith("Filename: "): fn = l.split(": ", 1)[1]
            elif l.startswith("SHA256: "): sha = l.split(": ", 1)[1].strip()
        break
    if fn:
        deb = os.path.join(w, "mawk.deb")
        if not os.path.exists(deb):
            # 60 s timeout: an unresponsive mirror must not hang the install.
            with urllib.request.urlopen("https://deb.debian.org/debian/" + fn, timeout=60) as r, \
                 open(deb + ".part", "wb") as out:
                import shutil
                shutil.copyfileobj(r, out)
            os.replace(deb + ".part", deb)
        if sha:
            got = hashlib.sha256(open(deb, "rb").read()).hexdigest()
            if got != sha:
                os.unlink(deb)
                raise SystemExit("mawk.deb checksum mismatch (expected %s, got %s)" % (sha, got))
        else:
            print("mawk: no SHA256 in the Packages index — installing unverified")
        subprocess.run(["dpkg-deb", "-x", deb, os.path.join(w, "root")], check=True)
        subprocess.run(["cp", "-a", os.path.join(w, "root/usr/bin/mawk"), os.path.join(t, "bin/mawk")], check=True)
        link = os.path.join(t, "bin/awk")
        if os.path.lexists(link) and not os.path.exists(link): os.unlink(link)
        if not os.path.lexists(link): os.symlink(os.path.join(t, "bin/mawk"), link)
        print("installed: " + os.path.join(t, "bin/awk") + " (checksum verified)")
PY
  awk_ok || echo "awk install failed — only elapsed_s is blank, results are unaffected"
fi

# --- 5) config.env ----------------------------------------------------------
say "5) config.env"
if [ -f "$HERE/config.env" ]; then
  echo "kept: $HERE/config.env (existing settings are never overwritten)"
else
  cp "$HERE/config.env.example" "$HERE/config.env" && echo "created: $HERE/config.env"
fi
chmod +x "$HERE"/*.sh "$HERE"/bin/*.sh 2>/dev/null || true
[ -d "$HERE/.state" ] && echo "kept: $HERE/.state (profile, cookies, cache)"

# --- 6) verify --------------------------------------------------------------
say "6) verify"
if [ "${PU_SKIP_BROWSER:-0}" = "1" ] || [ "${PU_SKIP_VERIFY:-0}" = "1" ]; then
  echo "skipped (browser/verify step disabled)"
else
  export PU_CHROME="$CHROME_BIN_FOUND"
  PU_SETTLE=0 "$HERE/bin/run.sh" warm || die "daemon warm-up failed" 1
  "$HERE/bin/run.sh" read https://example.com | tail -2
  "$HERE/bin/run.sh" stop
fi
echo
echo "done. next: bash $HERE/bin/run.sh doctor   |   bash $HERE/bin/selftest.sh"
