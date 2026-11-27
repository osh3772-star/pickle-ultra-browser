#!/usr/bin/env python3
"""vault_sheet — build the per-user intake sheet from the vault's login list.

What it does (one run per install, idempotent):

  1. reads the user's saved logins as METADATA only — site, username,
     whether a password exists, and the sign-in method. A password or TOTP
     value is never read, decrypted or printed; the vault CLI does not print
     those either.
  2. creates a PRIVATE spreadsheet titled "<agent> 인입 (자동 파쇄)" with tab
     "in", header 사이트 / 아이디 / 비밀번호, one row per site, and the
     username already typed into column B.
  3. leaves column C empty: that is the only cell the user ever fills in.
  4. rows whose login has no password of its own (social sign-in) keep B
     empty and are listed in a note cell beside the header, so the user can
     see which sites sign in with e.g. kakao instead of a password.

Idempotent: an existing sheet is reused, only missing sites are appended,
and a column B value that is already there is never overwritten.

Usage:
  vault_sheet.py init [--from-json FILE] [--agent-name NAME] [--new]
                      [--gog gog] [--dry-run] [--json]
  vault_sheet.py status [--json]

  --from-json   read logins from a JSON file instead of the vault CLI
                (list of {site, username, password, method}); used for
                testing and for agents without a vault command
  --new         create a fresh sheet even if the config already has one

Environment:
  PU_VAULT_CLI   command that prints login metadata (default: vault)
                 must accept `logins`; output is JSON
  PU_GOG         Google CLI used for Sheets (default: gog)

Output (one line, values never printed):
  ok sheet_id=<id> url=<url> created=yes|no rows=<n> added=<n> prefilled=<n> note=<n>
  skip ...      nothing to do
  fail code=<vault|gog|read|write|config|empty> ...
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))   # extensions/vault-intake -> tree root
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "bin"))
import pu_config  # noqa: E402

NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$")
RATE_MARKERS = ("rate_limited", "429", "quota", "RESOURCE_EXHAUSTED")


# ---------------------------------------------------------------- helpers
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


def find_list_with_key(obj, key, depth=0):
    """Find the first list of dicts whose items carry `key` (vault/gog envelopes differ)."""
    if depth > 6:
        return None
    if isinstance(obj, list):
        if obj and all(isinstance(i, dict) for i in obj) and any(key in i for i in obj):
            return obj
        for v in obj:
            got = find_list_with_key(v, key, depth + 1)
            if got is not None:
                return got
    elif isinstance(obj, dict):
        for v in obj.values():
            got = find_list_with_key(v, key, depth + 1)
            if got is not None:
                return got
    return None


def find_scalar(obj, *keys, depth=0):
    if depth > 6:
        return None
    if isinstance(obj, dict):
        for k in keys:
            if isinstance(obj.get(k), str) and obj[k]:
                return obj[k]
        for v in obj.values():
            got = find_scalar(v, *keys, depth=depth + 1)
            if got is not None:
                return got
    elif isinstance(obj, list):
        for v in obj:
            got = find_scalar(v, *keys, depth=depth + 1)
            if got is not None:
                return got
    return None


def gog(args, gog_bin, timeout=110):
    """Run gog; return (json_obj_or_None, error_code_or_None). Retries once on rate limit."""
    for attempt in (1, 2):
        try:
            p = subprocess.run([gog_bin] + args, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return None, "gog"
        try:
            obj = json.loads(p.stdout)
        except ValueError:
            obj = None
        blob = (p.stdout or "") + (p.stderr or "")
        rate = any(m in blob for m in RATE_MARKERS)
        if obj is not None and obj.get("ok") is True:
            return obj, None
        code = None if obj is None else obj.get("code")
        if attempt == 1 and (code in (7, "rate_limited") or rate):
            time.sleep(20)
            continue
        return obj, (str(code) if code not in (None, "ok") else "gog")
    return None, "gog"


def read_range(sheet_id, rng, gog_bin):
    obj, err = gog(["--readonly", "sheets", "get", sheet_id, rng], gog_bin)
    if err:
        return None, err
    # values is a list of lists, not dicts
    def find_values(o, depth=0):
        if depth > 6:
            return None
        if isinstance(o, dict):
            for k in ("values", "data"):
                if k in o:
                    got = find_values(o[k], depth + 1)
                    if got is not None:
                        return got
            for v in o.values():
                if isinstance(v, (dict, list)):
                    got = find_values(v, depth + 1)
                    if got is not None:
                        return got
        elif isinstance(o, list):
            if all(isinstance(r, list) for r in o):
                return o
            for v in o:
                got = find_values(v, depth + 1)
                if got is not None:
                    return got
        return None

    rows_raw = find_values(obj)
    rows = []
    if isinstance(rows_raw, list):
        for row in rows_raw:
            if not isinstance(row, list):
                continue
            cells = ["" if (i >= len(row) or row[i] is None) else str(row[i]) for i in range(6)]
            rows.append(cells)
    return rows, None


def update_range(sheet_id, rng, values, gog_bin, raw=True):
    args = ["sheets", "update", sheet_id, rng, "--values-json", json.dumps(values, ensure_ascii=False)]
    if raw:
        args += ["--input", "RAW"]
    obj, err = gog(args, gog_bin)
    if err:
        return err
    return None


def _rgb(hex_color):
    h = hex_color.lstrip("#")
    return {"red": int(h[0:2], 16) / 255.0, "green": int(h[2:4], 16) / 255.0,
            "blue": int(h[4:6], 16) / 255.0}


def cell_format(bg=None, bold=False, fg=None, size=11, halign="CENTER", valign="MIDDLE",
                wrap="CLIP", borders=False):
    f = {"verticalAlignment": valign, "horizontalAlignment": halign, "wrapStrategy": wrap,
         "textFormat": {"bold": bold, "fontSize": size}}
    if bg:
        f["backgroundColor"] = _rgb(bg)
    if fg:
        f["textFormat"]["foregroundColor"] = _rgb(fg)
    if borders:
        line = {"style": "SOLID", "color": _rgb("#C6CDD5")}
        f["borders"] = {side: dict(line) for side in ("top", "bottom", "left", "right")}
    return f


def apply_visuals(sheet_id, gog_bin, tab, last_row):
    """Column widths, frozen header, row heights, header styling, borders and the
    'fill me' column highlight. Idempotent; returns (all_ok, failed_labels)."""
    failed = []

    def rng(a):
        return "%s!%s" % (tab, a)

    def run(args, label):
        obj, err = gog(args, gog_bin)
        if err:
            failed.append(label)
            return False
        return True

    # 1) column widths — a long address in B must never bleed into C
    for col, width in (("A:A", 220), ("B:B", 240), ("C:C", 240)):
        run(["sheets", "resize-columns", sheet_id, rng(col), "--width", str(width)], "width:" + col)
    # 2) header frozen, comfortable row heights
    run(["sheets", "freeze", sheet_id, "--rows", "1", "--sheet", tab], "freeze")
    run(["sheets", "resize-rows", sheet_id, rng("1:1"), "--height", "38"], "row-height:1")
    run(["sheets", "resize-rows", sheet_id, rng("2:%d" % max(last_row, 2)), "--height", "34"],
        "row-height:data")
    # 3) header band: bold, dark, centred
    run(["sheets", "format", sheet_id, rng("A1:C1"), "--format-json",
         json.dumps(cell_format(bg="#1F3B57", bold=True, fg="#FFFFFF", borders=True))], "format:header")
    # 4) data area: thin borders, vertical centring, clipped text
    run(["sheets", "format", sheet_id, rng("A2:C%d" % max(last_row, 2)), "--format-json",
         json.dumps(cell_format(borders=True, halign="LEFT"))], "format:data")
    # 5) B reads as pre-filled grey; C is the one cell the user fills in
    run(["sheets", "format", sheet_id, rng("B2:B%d" % max(last_row, 2)), "--format-json",
         json.dumps(cell_format(bg="#F1F3F5", halign="LEFT", borders=True))], "format:B")
    run(["sheets", "format", sheet_id, rng("C2:C%d" % max(last_row, 2)), "--format-json",
         json.dumps(cell_format(bg="#FFF8DC", halign="LEFT", borders=True))], "format:C")
    return (len(failed) == 0, failed)


def tab_title(sheet_id, gog_bin, fallback="Sheet1"):
    obj, err = gog(["--readonly", "sheets", "metadata", sheet_id], gog_bin)
    if err:
        return fallback
    titles = []

    def walk(o, depth=0):
        if depth > 6:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("title", "sheetName") and isinstance(v, str):
                    titles.append(v)
                elif isinstance(v, (dict, list)):
                    walk(v, depth + 1)
        elif isinstance(o, list):
            for v in o:
                walk(v, depth + 1)

    walk(obj)
    return titles[0] if titles else fallback


# ---------------------------------------------------------------- sources
def load_logins_from_json(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    rows = find_list_with_key(data, "site")
    return rows or []


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


def plan_rows(logins):
    """-> (rows, notes, skipped). rows = [(site, username_prefill)], notes for the header cell."""
    rows, notes, seen = [], [], set()
    for item in logins:
        site = normalize_site(str(item.get("site") or ""))
        if not site or site in seen:
            continue
        seen.add(site)
        has_pw = item.get("password") is True
        username = str(item.get("username") or "").strip()
        method = str(item.get("method") or "").strip()
        prefill = username if (has_pw and username) else ""
        if method and not has_pw:
            prefill = ""
            notes.append("%s=%s" % (site, method))
        rows.append((site, prefill))
    rows.sort(key=lambda r: r[0])
    notes.sort()
    return rows, notes


# ---------------------------------------------------------------- commands
def cmd_init(args):
    cfg = pu_config.load()
    if args.agent_name:
        cfg["agent_name"] = args.agent_name
    agent = cfg.get("agent_name") or "Pickle Ultra"
    gog_bin = args.gog or os.environ.get("PU_GOG") or "gog"

    if args.from_json:
        try:
            logins = load_logins_from_json(args.from_json)
        except (OSError, ValueError):
            print("fail code=vault reason=from-json")
            return 1
    else:
        cli = os.environ.get("PU_VAULT_CLI") or "vault"
        logins = load_logins_from_vault(cli)
        if logins is None:
            print("fail code=vault reason=login-list-unavailable")
            return 1

    rows, notes = plan_rows(logins)
    if not rows:
        print("skip empty source=no-sites")
        return 0
    if args.dry_run:
        print("dry-run rows=%d prefilled=%d notes=%d sheet=%s"
              % (len(rows), sum(1 for _, u in rows if u), len(notes), cfg.get("sheet_id") or "new"))
        return 0

    sheet_id = "" if args.new else (cfg.get("sheet_id") or "")
    created = "no"
    existing = []
    anchor = 2
    if sheet_id:
        got, err = read_range(sheet_id, "%s!A1:F200" % cfg.get("sheet_tab", "in"), gog_bin)
        if err:
            sheet_id = ""
        else:
            existing = got
            anchor = max(2, len(existing) + 1)
            # never append over a row that already has a site
            for i, row in enumerate(existing[1:], start=2):
                if not (row[0].strip() if row else ""):
                    anchor = i
                    break
    if not sheet_id:
        title = "%s 인입 (자동 파쇄)" % agent
        obj, err = gog(["sheets", "create", title], gog_bin)
        if err:
            print("fail code=gog reason=create")
            return 1
        sheet_id = find_scalar(obj, "spreadsheetId", "id") or ""
        if not sheet_id:
            print("fail code=gog reason=create-no-id")
            return 1
        created = "yes"
        cfg.update({"sheet_id": sheet_id, "sheet_tab": "in", "sheet_range": "in!A2:C200",
                    "sheet_title": title, "agent_name": agent})
        pu_config.save(cfg)
        old = tab_title(sheet_id, gog_bin)
        if old and old != "in":
            gog(["sheets", "rename-tab", sheet_id, old, "in"], gog_bin)
        update_range(sheet_id, "in!A1:C1", [["사이트", "아이디", "비밀번호"]], gog_bin)
        anchor = 2

    known = set()
    for row in existing[1:]:
        site = normalize_site(row[0] if row else "")
        if site:
            known.add(site)

    to_add = [(s, u) for (s, u) in rows if s not in known]
    added = 0
    filled = 0
    row_no = anchor
    for site, prefill in to_add:
        if update_range(sheet_id, "in!A%d:C%d" % (row_no, row_no), [[site, prefill, ""]], gog_bin):
            print("fail code=write row=%d site=%s" % (row_no, site))
            return 1
        if prefill:
            filled += 1
        added += 1
        row_no += 1

    # fill a blank column B for sites already listed (never overwrite a value)
    for i, row in enumerate(existing[1:], start=2):
        site = normalize_site(row[0] if row else "")
        want = dict(rows).get(site, "")
        if site and want and not (row[1].strip() if len(row) > 1 else ""):
            if update_range(sheet_id, "in!B%d" % i, [[want]], gog_bin):
                print("fail code=write row=%d col=B" % i)
                return 1
            filled += 1

    if notes:
        note = "간편로그인(비밀번호 없음): " + ", ".join(notes)
        update_range(sheet_id, "in!E1", [["참고"]], gog_bin)
        update_range(sheet_id, "in!F1", [[note]], gog_bin)

    # visual layout: widths, frozen header, row heights, header band, borders,
    # grey pre-filled column, highlighted password column
    last_row = max(anchor + added - 1, len(existing) or 2, 2)
    fmt_ok, fmt_failed = True, []
    if not args.no_format:
        fmt_ok, fmt_failed = apply_visuals(sheet_id, gog_bin, cfg.get("sheet_tab", "in"), last_row)
    format_status = "ok" if fmt_ok else ("fail:" + ",".join(fmt_failed))

    # verify by reading back
    got, err = read_range(sheet_id, "in!A2:C200", gog_bin)
    verify = "ok"
    prefilled = 0
    listed = 0
    if err:
        verify = "unreadable"
    else:
        for row in got:
            if row and row[0].strip():
                listed += 1
                if len(row) > 1 and row[1].strip():
                    prefilled += 1
                if len(row) > 2 and row[2].strip():
                    verify = "mismatch"  # a password cell must stay empty at init

    url = "https://docs.google.com/spreadsheets/d/%s/edit" % sheet_id
    cfg.update({"sheet_id": sheet_id, "sheet_url": url, "sheet_tab": "in", "agent_name": agent,
                "sites": [r[0] for r in rows]})
    pu_config.save(cfg)

    if args.json:
        print(json.dumps({"ok": True, "sheet_id": sheet_id, "url": url, "created": created,
                          "rows": len(rows), "added": added, "prefilled": prefilled,
                          "listed": listed, "verify": verify, "format": format_status,
                          "format_failed": fmt_failed}, ensure_ascii=False))
    else:
        print("ok sheet_id=%s url=%s created=%s rows=%d added=%d prefilled=%d verify=%s format=%s"
              % (sheet_id, url or "-", created, len(rows), added, prefilled, verify, format_status))
    return 0


def cmd_status(args):
    """Counts only: sites listed, password cells filled, sites still unfilled, and
    when this check ran. Never a value, never a site's username."""
    cfg = pu_config.load()
    sheet_id = cfg.get("sheet_id") or ""
    source = "sheet" if sheet_id else "inbox"
    listed = waiting = 0
    path = ""
    if sheet_id:
        gog_bin = args.gog or os.environ.get("PU_GOG") or "gog"
        rows, err = read_range(sheet_id, "%s!A2:C200" % cfg.get("sheet_tab", "in"), gog_bin)
        if err:
            print("fail code=read")
            return 1
        listed = sum(1 for r in rows if r and r[0].strip())
        waiting = sum(1 for r in rows if r and r[0].strip() and len(r) > 2 and r[2].strip())
    else:
        import vault_form
        for cand in (pu_config.inbox_path("tsv"), pu_config.inbox_path("csv"),
                     pu_config.inbox_path("xlsx")):
            if os.path.exists(cand):
                path = cand
                break
        if not path:
            print("skip no-form")
            return 0
        rows = vault_form.read_rows(path)
        listed = len(rows)
        waiting = sum(1 for r in rows if r[2].strip())

    checked_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    cfg["last_status_at"] = checked_at
    pu_config.save(cfg)
    unfilled = max(listed - waiting, 0)
    if args.json:
        print(json.dumps({"source": source, "sheet_id": sheet_id, "path": path,
                          "url": cfg.get("sheet_url", ""), "listed": listed,
                          "waiting": waiting, "unfilled": unfilled,
                          "checked_at": checked_at}, ensure_ascii=False))
    else:
        print("status source=%s listed=%d waiting=%d unfilled=%d checked_at=%s%s"
              % (source, listed, waiting, unfilled, checked_at,
                 (" path=" + path) if path else (" sheet_id=" + sheet_id if sheet_id else "")))
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description="intake sheet builder for Pickle Ultra Browser")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("init", "status"):
        p = sub.add_parser(name)
        p.add_argument("--gog", default="")
        p.add_argument("--json", action="store_true")
        if name == "init":
            p.add_argument("--from-json", default="")
            p.add_argument("--agent-name", default="")
            p.add_argument("--new", action="store_true")
            p.add_argument("--dry-run", action="store_true")
            p.add_argument("--no-format", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "init":
        return cmd_init(args)
    return cmd_status(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
