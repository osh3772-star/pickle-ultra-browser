#!/usr/bin/env python3
"""threads.py — how many processes/threads a running daemon tree holds.

    python3 tests/threads.py [--state DIR] [--json]

Walks /proc, keeps every process whose ancestor chain reaches the daemon pid,
and reports the count of Chrome processes and the total thread count. The
thread ceiling of the environment this runs in (ulimit -u = 256 on the
audit host) is what makes a per-call leak fatal after a handful of reads, so
the regression test watches these numbers instead of guessing from latency.
"""
import json
import os
import sys


def read_stat(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    # comm may contain spaces/parentheses: cut at the last ')'
    rest = data[data.rfind(")") + 2:].split()
    return {"pid": pid, "ppid": int(rest[1]), "threads": int(rest[17])}


def all_procs():
    out = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        st = read_stat(int(name))
        if st:
            out[st["pid"]] = st
    return out


def tree(root_pid):
    procs = all_procs()
    keep = []
    for pid, st in procs.items():
        p, hops = pid, 0
        while p and p != 1 and hops < 64:
            if p == root_pid:
                keep.append(st)
                break
            nxt = procs.get(p)
            p = nxt["ppid"] if nxt else 0
            hops += 1
    keep.sort(key=lambda s: s["pid"])
    return keep


def cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return ""


def main():
    args = sys.argv[1:]
    state = None
    if "--state" in args:
        state = args[args.index("--state") + 1]
    if not state:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        state = os.path.join(here, ".state")
    try:
        with open(os.path.join(state, "cdp-daemon.pid")) as f:
            daemon = int(f.read().strip())
    except (OSError, ValueError):
        print(json.dumps({"daemon": None, "alive": False}))
        return 1
    if not os.path.isdir("/proc/%d" % daemon):
        print(json.dumps({"daemon": daemon, "alive": False}))
        return 1
    procs = tree(daemon)
    chrome = [p for p in procs if "chrome" in cmdline(p["pid"])]
    renderer = [p for p in chrome if "--type=renderer" in cmdline(p["pid"])]
    out = {
        "daemon": daemon,
        "alive": True,
        "procs": len(procs),
        "chrome_procs": len(chrome),
        "renderers": len(renderer),
        "threads": sum(p["threads"] for p in procs),
        "detail": [{"pid": p["pid"], "threads": p["threads"],
                    "cmd": cmdline(p["pid"])[:90]} for p in procs],
    }
    if "--json" in args:
        print(json.dumps(out))
    else:
        print("daemon=%d procs=%d chrome=%d renderers=%d threads=%d"
              % (daemon, out["procs"], out["chrome_procs"], out["renderers"], out["threads"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
