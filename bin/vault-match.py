#!/usr/bin/env python3
"""vault-match.py — does the agent vault hold a credential for this host?

    python3 bin/vault-match.py www.naver.com
    -> prints "www.naver.com" (the entry that matches) and exits 0
    -> prints nothing and exits 1 when no entry matches

Used by bin/chain.sh to decide the hand-off target of a login wall:
with a stored credential the caller can continue in this harness
(next=ultra-vault); without one the built-in browser + vault tool must
take over (next=builtin-browser-vault).

Only metadata is read: `agent-vault/vault.py list` prints name, purpose and
stored date, never a value. Domain candidates are the host itself, the host
without a leading "www.", and its registrable parent (suffix-aware, so
shop.example.co.kr also tries example.co.kr but never co.kr).
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VAULT = os.path.join(os.path.dirname(HERE), "agent-vault", "vault.py")

# second-level public suffixes common in the two markets this harness is used in
TWO_LEVEL = {
    "co.kr", "or.kr", "go.kr", "ne.kr", "re.kr", "ac.kr", "pe.kr", "kr",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "com.cn", "net.cn", "org.cn", "com.tw", "com.hk", "com.sg", "co.nz", "co.in",
    "com.br", "com.mx", "com.tr", "co.za",
}

IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")

HOST_RE = re.compile(r"\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b", re.I)


def labels(host):
    return [p for p in host.lower().strip(".").split(".") if p]


def candidates(host):
    """host, host minus www, then each parent that keeps a public suffix."""
    host = host.lower().strip(".")
    if IPV4_RE.match(host):          # an address has no parent domain
        return [host]
    out = [host]
    if host.startswith("www."):
        out.append(host[4:])
    parts = labels(host)
    for i in range(1, len(parts) - 1):
        rest = ".".join(parts[i:])
        if len(labels(rest)) < 2:
            continue
        if len(labels(rest)) == 2 and rest in TWO_LEVEL:
            continue
        if rest not in out:
            out.append(rest)
    return out


def hosts_in(text):
    return {m.group(1).lower().strip(".") for m in HOST_RE.finditer(text or "")}


def entry_hosts(name, purpose):
    hosts = hosts_in(purpose)
    if "." in name:
        hosts |= hosts_in(name)
        # An entry may be named after an address rather than a domain
        # ("127.0.0.1", "192.168.0.10"); HOST_RE only accepts a letter TLD.
        bare = name.strip().lower()
        if IPV4_RE.match(bare):
            hosts.add(bare)
    return hosts


def entries():
    """(name, purpose) pairs, metadata only.

    Reads agent-vault/meta.json directly (the same file `vault.py list` prints
    from): the check runs on every chain call, so it pays one short process
    instead of spawning the vault CLI as well. Metadata only — no value is
    touched or decrypted.
    """
    base = os.environ.get("PU_VAULT_DIR") or os.path.join(os.path.dirname(HERE), "agent-vault")
    meta_path = os.path.join(base, "meta.json")
    try:
        with open(meta_path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return []
        return [(k, (v or {}).get("purpose", "") if isinstance(v, dict) else "")
                for k, v in data.items()]
    except (OSError, ValueError):
        # No meta.json means an empty (or not yet created) vault; a corrupt one
        # is treated the same way. Both answer "no credential", which is the
        # safe direction: the caller is sent to the vault-aware hand-over.
        return []


def main(argv):
    if len(argv) < 2:
        print("usage: vault-match.py <host>", file=sys.stderr)
        return 2
    want = candidates(argv[1])
    if not want:
        return 1
    for name, purpose in entries():
        hosts = entry_hosts(name, purpose)
        for c in want:
            if c in hosts:
                print(name)
                return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
