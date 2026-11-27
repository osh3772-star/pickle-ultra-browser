#!/usr/bin/env python3
"""vault_form — write the intake form as a local file the user can fill in.

Used when the agent's Google account is not connected: the sheet cannot be
created or read, so the same three columns travel as a file instead.

  1. reads the saved logins as METADATA only (site, username, whether a
     password exists, the sign-in method). No password or TOTP value is read
     or printed; the vault CLI does not print them either.
  2. writes a table with header 사이트 / 아이디 / 비밀번호, one row per site,
     and the username already filled into the second column.
  3. leaves the third column empty: that is the only cell the user fills in,
     on their own phone, and they send the file back through chat.

The file is written with mode 0600. Re-running keeps rows that are already in
the file (a value the user typed is never overwritten) and only appends sites
that are missing.

Usage:
  vault_form.py [--from-json FILE] [--format tsv|csv|xlsx] [--out PATH]
                [--vault-cli CMD] [--agent-name NAME] [--json]

  --from-json   read logins from a JSON file instead of the vault CLI
  --format      tsv (default), csv (utf-8 with BOM, opens in any phone app),
                or xlsx (needs python 'openpyxl'; fails cleanly without it)
  --out         path (default: $PICKLE_ULTRA_INBOX or $PICKLE_ULTRA_HOME/inbox.tsv)

Output (values never printed):
  ok form=<path> format=<tsv|csv|xlsx> rows=<n> added=<n> prefilled=<n> mode=<octal>
  attach=<path>                    -> send this file to the user in chat
  note social=<site>=<method>,...  -> sites that need no password here
  skip empty source=no-sites
  fail code=<vault|write|from-json> reason=<...>
"""
import argparse
import csv
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))   # extensions/vault-intake -> tree root
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "bin"))
import pu_config  # noqa: E402
from vault_sheet import find_list_with_key, normalize_site, plan_rows  # noqa: E402

HEADER = ["사이트", "아이디", "비밀번호"]


def load_logins_from_json(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return find_list_with_key(data, "site") or []


def load_logins_from_vault(cli):
    try:
        p = subprocess.run([cli, "logins"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        data = json.loads(p.stdout)
    except ValueError:
        return None
    return find_list_with_key(data, "site") or []


def format_of(path):
    low = (path or "").lower()
    for fmt in ("xlsx", "csv", "tsv"):
        if low.endswith("." + fmt):
            return fmt
    return "tsv"


def read_rows(path):
    """-> rows [[site, user, pw], ...] without the header; [] when absent."""
    if not os.path.exists(path):
        return []
    fmt = format_of(path)
    if fmt == "xlsx":
        from openpyxl import load_workbook
        wb = load_workbook(path, data_only=True)
        ws = wb.active
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                continue
            cells = ["" if (j >= len(row) or row[j] is None) else str(row[j]) for j in range(3)]
            if not cells[0].strip():
                continue
            rows.append([cells[0].strip(), cells[1].strip(), cells[2].strip()])
        return rows
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for i, row in enumerate(csv.reader(f, delimiter="," if fmt == "csv" else "\t")):
            if i == 0:
                continue
            cells = [(row[j] if j < len(row) else "") for j in range(3)]
            if not cells[0].strip():
                continue
            rows.append([cells[0].strip(), cells[1].strip(), cells[2].strip()])
    return rows


def _zero_old(path):
    if not os.path.exists(path):
        return
    size = os.path.getsize(path)
    try:
        with open(path, "r+b") as f:
            f.write(b"\x00" * size)
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass


def write_rows(path, rows, fmt):
    """Atomic write, mode 0600; the previous bytes are zeroed first because the
    file may hold a value the user typed."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    _zero_old(path)
    tmp = path + ".tmp"
    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        wb = Workbook()
        ws = wb.active
        ws.title = "in"
        ws.append(HEADER)
        for c in ws[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="1F3B57")
            c.alignment = Alignment(horizontal="center", vertical="center")
        for site, user, pw in rows:
            ws.append([site, user, pw])
        ws.column_dimensions["A"].width = 34
        ws.column_dimensions["B"].width = 34
        ws.column_dimensions["C"].width = 32
        ws.freeze_panes = "A2"
        wb.save(tmp)
    else:
        delim = "," if fmt == "csv" else "\t"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8-sig" if delim == "," else "utf-8",
                       newline="") as f:
            w = csv.writer(f, delimiter=delim, lineterminator="\n")
            w.writerow(HEADER)
            for site, user, pw in rows:
                w.writerow([site, user, pw])
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def main(argv):
    ap = argparse.ArgumentParser(description="intake form file builder for Pickle Ultra Browser")
    ap.add_argument("--from-json", default="")
    ap.add_argument("--format", choices=("tsv", "csv", "xlsx"), default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--vault-cli", default="")
    ap.add_argument("--agent-name", default="")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    cfg = pu_config.load()
    agent = args.agent_name or cfg.get("agent_name") or "Pickle Ultra"

    if args.from_json:
        try:
            logins = load_logins_from_json(args.from_json)
        except (OSError, ValueError):
            print("fail code=from-json reason=unreadable")
            return 1
    else:
        cli = args.vault_cli or os.environ.get("PU_VAULT_CLI") or "vault"
        logins = load_logins_from_vault(cli)
        if logins is None:
            print("fail code=vault reason=login-list-unavailable")
            return 1

    rows_plan, notes = plan_rows(logins)
    if not rows_plan:
        print("skip empty source=no-sites")
        return 0

    fmt = args.format or format_of(args.out or pu_config.inbox_path("tsv"))
    if fmt == "xlsx":
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            print("fail code=write reason=xlsx-unavailable")
            return 1
    out = args.out or pu_config.inbox_path(fmt)
    if not out.lower().endswith("." + fmt):
        out = os.path.splitext(out)[0] + "." + fmt if os.path.splitext(out)[1] else out + "." + fmt

    existing = read_rows(out)
    merged = []
    seen = set()
    for site, user, pw in existing:
        merged.append([site, user, pw])
        seen.add(site.lower())
    added = 0
    for site, prefill in rows_plan:
        if site.lower() in seen:
            continue
        merged.append([site, prefill, ""])
        seen.add(site.lower())
        added += 1
    merged.sort(key=lambda r: r[0])

    try:
        write_rows(out, merged, fmt)
    except OSError:
        print("fail code=write reason=path")
        return 1
    except ImportError:
        print("fail code=write reason=xlsx-unavailable")
        return 1

    mode = oct(os.stat(out).st_mode & 0o777)[2:]
    prefilled = sum(1 for site, user, pw in merged if user)
    if args.json:
        print(json.dumps({"ok": True, "form": out, "agent": agent, "format": fmt,
                          "rows": len(merged), "added": added, "prefilled": prefilled,
                          "mode": mode, "social": notes}, ensure_ascii=False))
        return 0
    print("ok form=%s format=%s rows=%d added=%d prefilled=%d mode=%s"
          % (out, fmt, len(merged), added, prefilled, mode))
    print("attach=" + out)
    if notes:
        print("note social=" + ",".join(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
