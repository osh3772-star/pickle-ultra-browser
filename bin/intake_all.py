#!/usr/bin/env python3
"""intake_all.py — move the rows the user filled in into the vault.

Two sources, same rules:

  sheet  the private Google Sheet from `vault-sheet-init` (agent reads it
         itself; needs a connected Google account)
  file   the local form from `vault-form` (the user fills it on their own
         phone and sends it back; no Google account needed)

Values are never printed, never logged, and never written to a temp file.
Once a row is stored, its username/password cells are cleared (sheet) or the
row is rewritten with the site only (file) and read back to confirm. When the
file source was used and every row succeeded, the form file and its copies
under attachments/ are shredded and deleted.

Source choice: --source auto (default) uses the sheet when the config holds a
sheet id and the sheet is readable, and otherwise the local form. A sheet that
cannot be read falls back to the form once — no retry loop.

Output (one line per row):
  ok site=<name> row=<n> cleared=yes|no
  skip empty
  note fallback=file reason=<read|config|gog>
  shredded file=<path> attachments=<n>
  fail code=<site|chars|store|clear|read|range|config> row=<n>

Exit codes: 0 all rows handled · 1 any row failed
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "bin"))
import pu_config  # noqa: E402

VAULT = os.environ.get("PICKLE_ULTRA_VAULT") or os.path.join(BASE, "agent-vault", "vault.py")
NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$")
RATE_MARKERS = ("rate_limited", "429", "quota", "RESOURCE_EXHAUSTED")
HEADER = ["사이트", "아이디", "비밀번호"]


def gog(args, gog_bin):
    """Run gog; one retry after 20s when the API answers with a rate limit."""
    for attempt in (1, 2):
        try:
            p = subprocess.run([gog_bin] + args, capture_output=True, text=True, timeout=110)
        except (OSError, subprocess.TimeoutExpired):
            return {"ok": False, "code": "cli"}
        try:
            obj = json.loads(p.stdout)
        except ValueError:
            obj = {"ok": False, "code": "parse"}
        blob = (p.stdout or "") + (p.stderr or "")
        if obj.get("ok") is True:
            return obj
        rate = obj.get("code") in (7, "rate_limited") or any(m in blob for m in RATE_MARKERS)
        if attempt == 1 and rate:
            time.sleep(20)
            continue
        return obj
    return {"ok": False, "code": "cli"}


def find_values(obj, depth=0):
    if depth > 6:
        return None
    if isinstance(obj, dict):
        for key in ("values", "data"):
            if key in obj:
                got = find_values(obj[key], depth + 1)
                if got is not None:
                    return got
        for val in obj.values():
            if isinstance(val, (dict, list)):
                got = find_values(val, depth + 1)
                if got is not None:
                    return got
    elif isinstance(obj, list):
        if all(isinstance(r, list) for r in obj):
            return obj
        for val in obj:
            if isinstance(val, (dict, list)):
                got = find_values(val, depth + 1)
                if got is not None:
                    return got
    return None


def read_sheet_rows(sheet_id, rng, gog_bin):
    """(rows, code). rows = [[A,B,C], ...] starting at A2."""
    obj = gog(["--readonly", "sheets", "get", sheet_id, rng], gog_bin)
    if obj.get("ok") is not True:
        code = str(obj.get("code") or "read")
        return None, ("range" if "range" in code or "invalid" in code else "read")
    values = find_values(obj)
    rows = []
    if isinstance(values, list):
        for row in values:
            if not isinstance(row, list):
                continue
            cells = []
            for i in range(3):
                cell = row[i] if i < len(row) else ""
                cells.append("" if cell is None else str(cell))
            rows.append(cells)
    return rows, None


# ---------------------------------------------------------------- file form
def sniff_delimiter(path):
    return "," if path.lower().endswith(".csv") else "\t"


def read_form(path):
    """-> (rows, kind); rows = [[site, user, pw], ...] without the header."""
    import vault_form  # local: keeps this module usable on its own
    return vault_form.read_rows(path), vault_form.format_of(path)


def write_form(path, rows, kind):
    """Rewrite the form: previous bytes are zeroed first, so a cleared value
    does not survive in the file's old blocks."""
    import vault_form
    vault_form.write_rows(path, rows, kind)


def shred_delete(path):
    try:
        size = os.path.getsize(path)
        with open(path, "r+b") as f:
            f.write(b"\x00" * size)
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass
    try:
        os.unlink(path)
        return True
    except OSError:
        return False


def attachment_copies(path, attachments_dir):
    """Same-named copies under attachments/<date>/ (depth limited)."""
    copies = []
    if not attachments_dir or not os.path.isdir(attachments_dir):
        return copies
    base = os.path.basename(path)
    root_depth = os.path.abspath(attachments_dir).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(attachments_dir):
        if os.path.abspath(dirpath).count(os.sep) - root_depth >= 2:
            dirnames[:] = []
        for fn in filenames:
            if fn == base:
                copies.append(os.path.join(dirpath, fn))
    return copies


# ---------------------------------------------------------------- rows
def normalize_site(raw):
    s = (raw or "").strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = re.split(r"[/?#]", s, 1)[0]
    if s.startswith("www."):
        s = s[4:]
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-._")
    if len(s) > 64:
        return ""
    return s if NAME_RE.match(s) else ""


def store_value(name, user, password):
    payload = bytearray((user + "\t" + password).encode("utf-8"))
    try:
        p = subprocess.run(
            [sys.executable, VAULT, "store", name,
             "--purpose", "pickle-ultra login: " + name, "--force"],
            input=bytes(payload), capture_output=True,
        )
        return p.returncode == 0
    except OSError:
        return False
    finally:
        for i in range(len(payload)):
            payload[i] = 0


def clear_sheet_row(sheet_id, row_no, gog_bin, tab):
    rng = "%s!B{}:C{}".format(row_no, row_no) % tab
    obj = gog(["sheets", "clear", sheet_id, rng], gog_bin)
    if obj.get("ok") is not True:
        return False
    rows, code = read_sheet_rows(sheet_id, rng, gog_bin)
    if code is not None:
        return False
    if not rows:
        return True  # an empty range yields no values row: that is cleared
    return all(not c.strip() for c in rows[0])


def handle_sheet(sheet_id, rng, gog_bin, tab):
    rows, code = read_sheet_rows(sheet_id, rng, gog_bin)
    if code is not None:
        return None, code
    acted = 0
    rc = 0
    for idx, (site_raw, user_raw, pw_raw) in enumerate(rows):
        row_no = idx + 2
        user, password = user_raw.strip(), pw_raw.strip()
        if not user and not password:
            continue
        acted += 1
        if not site_raw.strip() or not user or not password:
            print("fail code=incomplete row={}".format(row_no))
            rc = 1
            continue
        name = normalize_site(site_raw)
        if not name:
            print("fail code=site row={}".format(row_no))
            rc = 1
            continue
        if any(ch in user or ch in password for ch in "\t\r\n"):
            print("fail code=chars row={}".format(row_no))
            rc = 1
            continue
        if not store_value(name, user, password):
            print("fail code=store row={}".format(row_no))
            rc = 1
            continue
        cleared = "yes" if clear_sheet_row(sheet_id, row_no, gog_bin, tab) else "no"
        print("ok site={} row={} cleared={}".format(name, row_no, cleared))
        if cleared != "yes":
            rc = 1
    if acted == 0:
        print("skip empty")
    return rc, None


def handle_file(path, attachments_dir):
    if not os.path.exists(path):
        print("skip empty")
        return 0, False
    rows, kind = read_form(path)
    rc = 0
    acted = 0
    for idx, (site_raw, user_raw, pw_raw) in enumerate(rows):
        row_no = idx + 2
        user, password = user_raw.strip(), pw_raw.strip()
        if not user and not password:
            continue
        acted += 1
        if not site_raw.strip() or not user or not password:
            print("fail code=incomplete row={}".format(row_no))
            rc = 1
            continue
        name = normalize_site(site_raw)
        if not name:
            print("fail code=site row={}".format(row_no))
            rc = 1
            continue
        if any(ch in user or ch in password for ch in "\t\r\n"):
            print("fail code=chars row={}".format(row_no))
            rc = 1
            continue
        if not store_value(name, user, password):
            print("fail code=store row={}".format(row_no))
            rc = 1
            continue
        rows[idx] = [site_raw, "", ""]
        try:
            write_form(path, rows, kind)
        except OSError:
            print("fail code=clear row={}".format(row_no))
            rc = 1
            continue
        back, _kind = read_form(path)
        cleared = "yes"
        probe = back[idx] if idx < len(back) else ["", "", ""]
        if probe[1].strip() or probe[2].strip() or probe[0].strip() != site_raw.strip():
            cleared = "no"
            rc = 1
        print("ok site={} row={} cleared={}".format(name, row_no, cleared))

    if acted == 0:
        print("skip empty")
        return 0, False

    if rc == 0:
        copies = attachment_copies(path, attachments_dir)
        base = os.path.basename(path)
        homes = []
        for fmt in ("tsv", "csv", "xlsx"):
            cand = pu_config.inbox_path(fmt)
            if (os.path.basename(cand) == base and os.path.exists(cand)
                    and os.path.abspath(cand) != os.path.abspath(path)):
                homes.append(cand)
        removed = shred_delete(path)
        n = 0
        for c in copies:
            if os.path.abspath(c) == os.path.abspath(path):
                continue
            if shred_delete(c):
                n += 1
        h = 0
        for c in homes:
            if shred_delete(c):
                h += 1
        print("shredded file={} removed={} attachments={} home={}"
              .format(path, "yes" if removed else "no", n, h))
    else:
        print("keep file={} reason=pending".format(path))
    return rc, rc == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=("auto", "sheet", "file"), default="auto")
    ap.add_argument("--file", default="")
    ap.add_argument("--sheet-id", default="")
    ap.add_argument("--range", default="")
    ap.add_argument("--gog", default=os.environ.get("PU_GOG") or "gog")
    ap.add_argument("--attachments-dir", default=os.environ.get("PICKLE_ULTRA_ATTACH_DIR") or "")
    args = ap.parse_args()

    cfg = pu_config.load()
    sheet_id = args.sheet_id or cfg.get("sheet_id") or ""
    source = args.source
    if source == "auto":
        source = "sheet" if sheet_id else "file"

    if source == "sheet":
        if not sheet_id:
            if args.source == "auto":
                print("note fallback=file reason=config")
                source = "file"
            else:
                print("fail code=config row=0")
                return 1
        else:
            tab = cfg.get("sheet_tab") or "in"
            rng = args.range or cfg.get("sheet_range") or (tab + "!A2:C200")
            rc, code = handle_sheet(sheet_id, rng, args.gog, tab)
            if code is None:
                return rc
            if args.source != "auto":
                print("fail code=" + code)
                return 1
            print("note fallback=file reason=" + code)
            source = "file"

    if source == "file":
        path = args.file
        if not path:
            for cand in (pu_config.inbox_path("tsv"), pu_config.inbox_path("csv")):
                if os.path.exists(cand):
                    path = cand
                    break
            path = path or pu_config.inbox_path("tsv")
        rc, _ = handle_file(path, args.attachments_dir)
        return rc

    return 0


if __name__ == "__main__":
    sys.exit(main())
