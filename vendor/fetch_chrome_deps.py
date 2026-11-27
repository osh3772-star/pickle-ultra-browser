#!/usr/bin/env python3
"""Fetch missing Chromium shared-library dependencies into the tree, without root.

Uses the Debian trixie Packages and Contents indexes to map sonames to packages,
downloads the .deb files, and extracts them under .tools/chrome-deps (override with
PU_CHROME_DEPS). Needs dpkg-deb; Linux only.
"""
import gzip, hashlib, lzma, os, re, subprocess, sys, urllib.request

BASE = "https://deb.debian.org/debian"
TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("PU_CHROME_DEPS", os.path.join(TREE, ".tools", "chrome-deps"))
DEBS = os.path.join(WORK, "debs")
PKGS = os.path.join(WORK, "pkgs")
LIB = os.path.join(WORK, "lib")
IDX = os.path.join(WORK, "idx")
SYSLIB = ["/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu"]
def _find_chrome():
    import glob
    env = os.environ.get("PU_CHROME")
    if env and os.path.exists(env):
        return env
    hits = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))
    hits += sorted(glob.glob(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache", "ms-playwright", "chromium-*", "chrome-linux*", "chrome")))
    return hits[-1] if hits else ""

CHROME = _find_chrome()

# Core runtime already present in the image; never extract these.
BLOCK = {
    "libc6", "libc-bin", "libgcc-s1", "libstdc++6", "zlib1g", "libselinux1",
    "libpcre2-8-0", "libattr1", "libacl1", "libcap2", "libaudit1", "libtinfo6",
    "libmd0", "libbsd0", "liblzma5", "libzstd1", "libuuid1", "libblkid1",
    "libmount1", "libsystemd0", "libudev1", "libgcc-14-dev", "dpkg", "base-files",
}

for d in (DEBS, PKGS, LIB, IDX):
    os.makedirs(d, exist_ok=True)


def dl(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print(f"  GET {url}", flush=True)
    urllib.request.urlretrieve(url, dest + ".part")
    os.replace(dest + ".part", dest)
    print(f"      -> {os.path.getsize(dest)/1e6:.1f} MB", flush=True)
    return dest


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_deb(path, expected, name):
    """Every .deb must match the SHA256 the Debian Packages index published.
    Without this the install trusted whatever arrived over TLS, including a
    stale file left behind by an interrupted earlier run."""
    if not expected:
        print(f"   .. {os.path.basename(path)} has no SHA256 in the index (old mirror?)", flush=True)
        return True
    got = sha256_file(path)
    if got != expected:
        print(f"   !! checksum mismatch for {name}: expected {expected[:16]}… got {got[:16]}… — discarding", flush=True)
        try:
            os.unlink(path)
        except OSError:
            pass
        return False
    return True


def parse_packages():
    pkgs = {}
    for comp in ("main", "main"):  # single pass, main only
        pass
    path = os.path.join(IDX, "Packages.xz")
    dl(f"{BASE}/dists/trixie/main/binary-amd64/Packages.xz", path)
    raw = lzma.open(path, "rt", encoding="utf-8", errors="replace").read()
    for stanza in raw.split("\n\n"):
        if not stanza.strip():
            continue
        d = {}
        key = None
        for line in stanza.split("\n"):
            if line.startswith(" ") and key:
                continue
            if ": " in line:
                key, val = line.split(": ", 1)
                d[key] = val
        if "Package" in d and "Filename" in d:
            pkgs[d["Package"]] = d
    return pkgs


def parse_contents():
    """soname -> [packages] from the trixie main Contents index."""
    path = os.path.join(IDX, "Contents-amd64.gz")
    dl(f"{BASE}/dists/trixie/main/Contents-amd64.gz", path)
    m = {}
    pat = re.compile(r"^usr/lib/x86_64-linux-gnu/([^/]+\.so[^/]*)$")
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if ".so" not in line:
                continue
            parts = line.rstrip("\n").rsplit(None, 1)
            if len(parts) != 2:
                continue
            mm = pat.match(parts[0])
            if not mm:
                continue
            for p in parts[1].split(","):
                m.setdefault(mm.group(1), []).append(p)
    return m


def ldd_missing(libdir=None):
    env = dict(os.environ)
    if libdir:
        env["LD_LIBRARY_PATH"] = libdir
    out = subprocess.run(["ldd", CHROME], capture_output=True, text=True, env=env).stdout
    miss = []
    for line in out.splitlines():
        line = line.strip()
        if "not found" in line:
            miss.append(line.split(" ")[0])
        elif "=>" in line:
            p = line.split("=>")[1].strip().split(" ")[0]
            if p == "not found":
                miss.append(line.split(" ")[0])
    return sorted(set(miss))


def present_in_system(fn):
    return any(os.path.exists(os.path.join(d, fn)) for d in SYSLIB)


def deps_of(pkgs, name):
    d = pkgs.get(name, {}).get("Depends", "")
    out = []
    for part in d.split(","):
        part = part.strip()
        if not part:
            continue
        alts = [a.strip().split(" ")[0].split("(")[0].strip() for a in part.split("|")]
        out.append(alts)
    return out


def main():
    print("== indexes ==", flush=True)
    pkgs = parse_packages()
    contents = parse_contents()
    print(f"   packages={len(pkgs)} sonames={len(contents)}", flush=True)

    installed = set()

    for rnd in range(1, 8):
        missing = [m for m in ldd_missing(LIB if os.listdir(LIB) else None)]
        print(f"== round {rnd}: {len(missing)} missing: {missing}", flush=True)
        if not missing:
            break
        targets = []
        for sn in missing:
            cands = contents.get(sn) or contents.get(sn + ".1") or []
            cands = [c.split("/")[-1] for c in cands]
            pick = None
            for c in cands:
                if c in pkgs and c not in BLOCK:
                    pick = c
                    break
            if not pick:
                # try versioned variants (libfoo.so.1.2.3)
                for k, v in contents.items():
                    if k.startswith(sn) and any(x.split("/")[-1] in pkgs for x in v):
                        pick = [x.split("/")[-1] for x in v if x.split("/")[-1] in pkgs][0]
                        break
            if not pick:
                print(f"   !! no package found for {sn}", flush=True)
                continue
            targets.append((sn, pick))

        # dependency closure
        queue = [p for _, p in targets]
        need = set()
        while queue:
            n = queue.pop()
            if n in need or n in BLOCK:
                continue
            need.add(n)
            for alts in deps_of(pkgs, n):
                chosen = None
                for a in alts:
                    if a in BLOCK:
                        chosen = None
                        break
                    if a in pkgs:
                        chosen = a
                        break
                if chosen and chosen not in need:
                    queue.append(chosen)

        print(f"   packages to fetch: {sorted(need)}", flush=True)
        if need and need <= installed:
            print("   nothing new to install — stopping early", flush=True)
            break
        for n in sorted(need):
            info = pkgs[n]
            fn = info["Filename"]
            sha = info.get("SHA256", "")
            deb = os.path.join(DEBS, os.path.basename(fn))
            if os.path.exists(deb) and not verify_deb(deb, sha, n):
                dl(f"{BASE}/{fn}", deb)          # bad cache: fetch once more
            if not os.path.exists(deb):
                dl(f"{BASE}/{fn}", deb)
            if not os.path.exists(deb) or not verify_deb(deb, sha, n):
                print(f"   !! {n}: not installed (unverified download)", flush=True)
                continue
            dest = os.path.join(PKGS, n)
            if not os.path.isdir(dest) or not os.listdir(dest):
                os.makedirs(dest, exist_ok=True)
                r = subprocess.run(["dpkg-deb", "-x", deb, dest], capture_output=True, text=True)
                if r.returncode != 0:
                    print(f"   !! extract failed {n}: {r.stderr.strip()}", flush=True)
                    continue
            installed.add(n)
        # Flatten after every round: ldd only sees $LIB, so without this the
        # next round reported the same "missing" list and the loop ran all
        # seven times doing nothing (measured 2026-11-27).
        flatten()

    missing = ldd_missing(LIB)
    print(f"== FINAL missing ({len(missing)}): {missing}", flush=True)
    return 0 if not missing else 1


def flatten():
    """Copy extracted libraries into $LIB (no-op for parts already present)."""
    n = 0
    skip = 0
    for root, dirs, files in os.walk(PKGS):
        if os.path.basename(root) != "x86_64-linux-gnu":
            continue
        for f in files:
            if ".so" not in f:
                continue
            src = os.path.join(root, f)
            dst = os.path.join(LIB, f)
            if os.path.islink(src):
                target = os.readlink(src)
                if not os.path.exists(os.path.join(LIB, os.path.basename(target))) and not present_in_system(os.path.basename(target)):
                    bn = os.path.basename(target)
                    real = os.path.join(root, target)
                    if os.path.exists(real):
                        subprocess.run(["cp", "-a", real, os.path.join(LIB, bn)])
            if present_in_system(f):
                skip += 1
                continue
            if not os.path.exists(dst):
                subprocess.run(["cp", "-a", src, dst])
                n += 1
    print(f"== flattened {n} libs into {LIB} (skipped {skip} already in system)", flush=True)
    return n


if __name__ == "__main__":
    sys.exit(main())
