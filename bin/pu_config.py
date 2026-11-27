#!/usr/bin/env python3
"""pu_config — per-install configuration for Pickle Ultra Browser.

One JSON file per user/install. Nothing secret goes here: it holds the
intake sheet id and display names only. Passwords live only in the vault.

Path: ${PU_CONFIG_FILE} or ${XDG_CONFIG_HOME:-~/.config}/pickle-ultra/config.json
(file mode 0600, directory 0700)

CLI:
  pu_config.py get <key>
  pu_config.py set <key>=<value> [<key>=<value> ...]
  pu_config.py show                     # keys and values (never secrets)
"""
import json
import os
import sys

CONFIG_DIR = os.environ.get("PU_CONFIG_DIR") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "pickle-ultra",
)
CONFIG_FILE = os.environ.get("PU_CONFIG_FILE") or os.path.join(CONFIG_DIR, "config.json")

DEFAULTS = {
    "sheet_tab": "in",
    "sheet_range": "in!A2:C200",
}


def inbox_path(fmt="tsv"):
    """Path of the local intake form used when Google is not connected.

    $PICKLE_ULTRA_INBOX (or $PU_INBOX) wins; otherwise
    $PICKLE_ULTRA_HOME/inbox.<ext>, falling back to the tree root.
    """
    explicit = os.environ.get("PICKLE_ULTRA_INBOX") or os.environ.get("PU_INBOX") or ""
    if explicit:
        if fmt == "csv" and not explicit.lower().endswith(".csv"):
            return os.path.splitext(explicit)[0] + ".csv"
        if fmt == "tsv" and explicit.lower().endswith(".csv"):
            return os.path.splitext(explicit)[0] + ".tsv"
        return explicit
    home = os.environ.get("PICKLE_ULTRA_HOME") or ""
    if not home:
        home = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(home, "inbox.tsv" if fmt == "tsv" else "inbox.csv")


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update(data)
    except (OSError, ValueError):
        pass
    return cfg


def save(cfg):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    try:
        os.chmod(CONFIG_DIR, 0o700)
    except OSError:
        pass
    tmp = CONFIG_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (json.dumps(cfg, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass


def main(argv):
    if not argv:
        print(__doc__.strip().splitlines()[-3], file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "get":
        if len(argv) < 2:
            print("usage: pu_config.py get <key>", file=sys.stderr)
            return 2
        val = load().get(argv[1], "")
        print("" if val is None else val)
        return 0
    if cmd == "set":
        cfg = load()
        for pair in argv[1:]:
            if "=" not in pair:
                print("error: expected key=value", file=sys.stderr)
                return 2
            k, v = pair.split("=", 1)
            cfg[k.strip()] = v
        save(cfg)
        print("ok config=" + CONFIG_FILE)
        return 0
    if cmd == "show":
        cfg = load()
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
        print("file: " + CONFIG_FILE, file=sys.stderr)
        return 0
    print("error: unknown command " + cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
