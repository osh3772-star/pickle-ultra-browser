#!/usr/bin/env bash
# pickle-bootstrap.sh — install/repair Pickle Ultra Browser without root.
# Idempotent: whatever is already there is skipped, so it is safe to re-run
# after a sandbox reset or a failed first attempt.
#
#   bash pickle-bootstrap.sh
#
# What it does
#   1) Node 22 LTS tarball -> $PU_TOOLS/node  (plain .tar.gz: some images lack xz)
#   2) Playwright Chromium -> ~/.cache/ms-playwright (npx; TMPDIR stays inside the tree,
#      because /tmp is often a small tmpfs)
#   3) Chromium shared libraries, extracted from Debian .deb files into the tree
#      (no root, no apt: dpkg-deb -x) -> $PU_TOOLS/chrome-deps/lib
#   4) awk (mawk) -- used for elapsed_s and absent from slim images -> $PU_TOOLS/bin
#   5) config.env from config.env.example (only when absent) + verification
#      (warm the daemon, read example.com, stop it)
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

say() { printf '\n== %s ==\n' "$*"; }

say "1) Node $NODE_VER → $PU_TOOLS/node"
if [ -x "$PU_TOOLS/node/bin/node" ] && "$PU_TOOLS/node/bin/node" -v 2>/dev/null | grep -q '^v22'; then
  echo "already: $("$PU_TOOLS/node/bin/node" -v)"
else
  mkdir -p "$PU_TOOLS/node"
  ( cd "$PU_TOOLS/node" \
    && curl -sSL -o node.tar.gz "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" \
    && tar -xzf node.tar.gz --strip-components=1 \
    && rm -f node.tar.gz ) || exit 1
  # 중단된 추출 뒤 남은 0바이트 npm/npx 심볼릭 링크 복구
  ( cd "$PU_TOOLS/node/bin" || exit 1
    for pair in "npm:../lib/node_modules/npm/bin/npm-cli.js" \
                "npx:../lib/node_modules/npm/bin/npx-cli.js"; do
      name=${pair%%:*}; tgt=${pair#*:}
      if [ ! -s "$name" ] || [ ! -x "$name" ]; then rm -f "$name"; ln -s "$tgt" "$name"; fi
    done )
  echo "installed: $(node -v)"
fi

say "2) Playwright Chromium"
CHROME_BIN_FOUND=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
if [ -n "$CHROME_BIN_FOUND" ]; then
  echo "already: $CHROME_BIN_FOUND"
else
  ( cd "$HERE" && npx --yes playwright@latest install chromium 2>&1 | grep -vE '^\|' | tail -5 )
  CHROME_BIN_FOUND=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
fi
[ -n "$CHROME_BIN_FOUND" ] || { echo "chromium install failed"; exit 1; }

say "3) Chromium shared libraries (extract .deb, no root)"
DEPS="$PU_TOOLS/chrome-deps/lib"
export PU_CHROME="$CHROME_BIN_FOUND"
if LD_LIBRARY_PATH="$DEPS" ldd "$CHROME_BIN_FOUND" 2>/dev/null | grep -q 'not found'; then
  FCD="$PU_TOOLS/fetch_chrome_deps.py"
  [ -f "$FCD" ] || FCD="$HERE/vendor/fetch_chrome_deps.py"
  python3 "$FCD" || exit 1
else
  echo "already: $(ls "$DEPS" 2>/dev/null | wc -l) libs, none missing"
fi

say "4) awk (missing on slim images — needed for elapsed_s)"
if command -v awk >/dev/null 2>&1; then
  echo "already: $(command -v awk)"
else
  python3 - <<'PY'
import lzma, os, subprocess, urllib.request
t = os.environ.get("PU_TOOLS") or os.path.expanduser("~/pickle-ultra/.tools")
w = os.path.join(t, "awk"); os.makedirs(w, exist_ok=True); os.makedirs(os.path.join(t, "bin"), exist_ok=True)
idx = os.path.join(t, "chrome-deps", "idx", "Packages.xz")
if os.path.exists(idx):
    raw = lzma.open(idx, "rt", encoding="utf-8", errors="replace").read()
    fn = None
    for st in raw.split("\n\n"):
        if st.startswith("Package: mawk\n"):
            for l in st.split("\n"):
                if l.startswith("Filename: "): fn = l.split(": ", 1)[1]
            break
    if fn:
        deb = os.path.join(w, "mawk.deb")
        if not os.path.exists(deb):
            urllib.request.urlretrieve("https://deb.debian.org/debian/" + fn, deb)
        subprocess.run(["dpkg-deb", "-x", deb, os.path.join(w, "root")], check=True)
        subprocess.run(["cp", "-a", os.path.join(w, "root/usr/bin/mawk"), os.path.join(t, "bin/mawk")])
        link = os.path.join(t, "bin/awk")
        if not os.path.lexists(link): os.symlink(os.path.join(t, "bin/mawk"), link)
        print("installed: " + os.path.join(t, "bin/awk"))
PY
  command -v awk >/dev/null 2>&1 || echo "awk install failed — only elapsed_s is blank, results are unaffected"
fi

say "5) config.env"
[ -f "$HERE/config.env" ] || cp "$HERE/config.env.example" "$HERE/config.env"
chmod +x "$HERE"/*.sh "$HERE"/bin/*.sh

say "6) verify"
export PU_CHROME="$CHROME_BIN_FOUND"
PU_SETTLE=0 "$HERE/bin/run.sh" warm || exit 1
"$HERE/bin/run.sh" read https://example.com | tail -2
"$HERE/bin/run.sh" stop
echo
echo "done. next: bash $HERE/bin/run.sh doctor   |   bash $HERE/bin/vault-sheet-init.sh"
