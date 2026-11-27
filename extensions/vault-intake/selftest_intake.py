#!/usr/bin/env python3
"""selftest_intake — one command that proves the intake harness works for a
fresh user, with nothing of this install hard-coded.

What it runs (throwaway config, throwaway vault, REAL temporary spreadsheets
that are moved to the trash at the end):

  profile A   10 sites, email-style usernames, 6 of them with a password
  profile B    8 sites, student-id usernames + social sign-in, 0 passwords

For each profile:
  1. `vault-sheet-init.sh` unattended  -> sheet created, usernames pre-filled,
     header/widths/freeze/borders applied, verify=ok format=ok
  2. the same command again            -> created=no added=0 (idempotent,
     an existing column B is not overwritten)
  3. one new login in the "vault"      -> added=1, only that row appended
  4. two password cells filled by the user -> `intake_all --source sheet` moves
     them to the throwaway vault, clears the cells, read-back confirms

Test values are fixed fake tokens, never printed. Cleanup: every sheet to the
trash, temp directories removed.

  python3 extensions/vault-intake/selftest_intake.py            (or bash extensions/vault-intake/selftest-intake.sh)
  python3 extensions/vault-intake/selftest_intake.py --keep     # keep the temp dir for inspection

Exit codes: 0 all checks passed · 1 a check failed · 2 skipped (no Google access)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(REPO, "bin")
sys.path.insert(0, HERE)
sys.path.insert(0, BIN)  # bin/pu-config.sh is sourced by the plugin scripts
import vault_form  # noqa: E402  (xlsx-free: only used for its reader)

GOG = os.environ.get("PU_GOG") or "gog"
TOKEN_A = "SelfTestAlpha-7k2q"
TOKEN_B = "SelfTestBeta-9m4v"

PROFILE_A = {
    "name": "A",
    "agent": "Test Agent A",
    "logins": [
        {"site": "mail.example.com", "username": "first.last@example.com", "password": True},
        {"site": "shop.example.com", "username": "first.last@example.com", "password": True},
        {"site": "news.example.com", "username": "first.last@example.com", "password": True},
        {"site": "bank.example.com", "username": "first.last@example.com", "password": True},
        {"site": "docs.example.com", "username": "first.last@example.com", "password": True},
        {"site": "video.example.com", "username": "first.last@example.com", "password": True},
        {"site": "photo.example.com", "username": "first.last@example.com", "password": False},
        {"site": "travel.example.com", "username": "first.last@example.com", "password": False},
        {"site": "music.example.com", "username": "first.last@example.com", "password": False},
        {"site": "forum.example.com", "username": "first.last@example.com", "password": False},
    ],
    "expect_prefilled": 10,
}

PROFILE_B = {
    "name": "B",
    "agent": "Test Agent B",
    "logins": [
        {"site": "portal.example.ac.kr", "username": "2023123456", "password": False},
        {"site": "lms.example.ac.kr", "username": "2023123456", "password": False},
        {"site": "library.example.ac.kr", "username": "2023123456", "password": False},
        {"site": "chat.example.net", "username": "", "password": False, "method": "kakao"},
        {"site": "store.example.net", "username": "", "password": False, "method": "kakao"},
        {"site": "map.example.net", "username": "", "password": False, "method": "naver"},
        {"site": "grade.example.ac.kr", "username": "", "password": False, "method": "kakao"},
        {"site": "club.example.ac.kr", "username": "", "password": False, "method": "naver"},
    ],
    "expect_prefilled": 3,
}

STUB_VAULT = """#!/usr/bin/env python3
import json, os, sys
prof = json.load(open(os.environ["SELFTEST_PROFILE"], encoding="utf-8"))
if sys.argv[1:2] == ["logins"]:
    print(json.dumps({"ok": True, "data": {"logins": prof["logins"]}}, ensure_ascii=False))
    sys.exit(0)
print(json.dumps({"ok": False, "code": "stub"}))
sys.exit(2)
"""


def gog(args, timeout=120):
    try:
        p = subprocess.run([GOG] + args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return {"ok": False, "code": "cli"}
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"ok": False, "code": "parse"}


def run(cmd, env):
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=REPO)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def parse_line(out):
    for line in out.splitlines():
        if line.startswith("ok "):
            fields = {}
            for part in line.split()[1:]:
                if "=" in part:
                    k, val = part.split("=", 1)
                    fields[k] = val
            return fields
    return {}


def sheet_rows(sheet_id):
    obj = gog(["--readonly", "sheets", "get", sheet_id, "in!A1:C200"])
    if obj.get("ok") is not True:
        return []
    values = None

    def find(o, depth=0):
        if depth > 6:
            return None
        if isinstance(o, dict):
            for k in ("values", "data"):
                if k in o:
                    got = find(o[k], depth + 1)
                    if got is not None:
                        return got
            for v in o.values():
                if isinstance(v, (dict, list)):
                    got = find(v, depth + 1)
                    if got is not None:
                        return got
        elif isinstance(o, list):
            if all(isinstance(r, list) for r in o):
                return o
            for v in o:
                got = find(v, depth + 1)
                if got is not None:
                    return got
        return None

    values = find(obj)
    return values or []


class Runner:
    def __init__(self):
        self.npass = 0
        self.nfail = 0
        self.skipped = False
        self.sheets = []

    def check(self, label, cond, detail=""):
        if cond:
            self.npass += 1
            print("PASS  %-34s %s" % (label, detail))
        else:
            self.nfail += 1
            print("FAIL  %-34s %s" % (label, detail))
        return cond


def profile_cycle(r: Runner, prof, root):
    tag = "profile" + prof["name"]
    work = os.path.join(root, tag)
    os.makedirs(work, exist_ok=True)
    conf = os.path.join(work, "config")
    prof_path = os.path.join(work, "profile.json")
    with open(prof_path, "w", encoding="utf-8") as f:
        json.dump(prof, f, ensure_ascii=False)

    stub = os.path.join(work, "vault-stub")
    with open(stub, "w", encoding="utf-8") as f:
        f.write(STUB_VAULT)
    os.chmod(stub, 0o700)

    env = dict(os.environ)
    env.update({
        "PU_CONFIG_DIR": conf,
        "PU_VAULT_CLI": stub,
        "SELFTEST_PROFILE": prof_path,
        "PU_GOG": GOG,
        "PICKLE_ULTRA_HOME": work,
    })

    # 1) unattended build
    rc, out = run(["bash", os.path.join(HERE, "vault-sheet-init.sh"),
                   "--gog", GOG, "--agent-name", prof["agent"]], env)
    fields = parse_line(out)
    if not fields.get("sheet_id"):
        code = ""
        for line in out.splitlines():
            if line.startswith("fail"):
                code = line
        print("SKIP  %-34s %s" % (tag + " create", code or "no sheet id"))
        r.skipped = True
        return
    sheet_id = fields["sheet_id"]
    r.sheets.append(sheet_id)
    rows_expected = len(prof["logins"])
    r.check(tag + " create+prefill",
            rc == 0 and fields.get("created") == "yes"
            and fields.get("rows") == str(rows_expected)
            and fields.get("prefilled") == str(prof["expect_prefilled"]),
            "rows=%s prefilled=%s (expected %d/%d) created=%s"
            % (fields.get("rows"), fields.get("prefilled"), rows_expected,
               prof["expect_prefilled"], fields.get("created")))
    r.check(tag + " verify+format",
            fields.get("verify") == "ok" and fields.get("format") == "ok",
            "verify=%s format=%s" % (fields.get("verify"), fields.get("format")))

    # 2) idempotent re-run
    rc, out = run(["bash", os.path.join(HERE, "vault-sheet-init.sh"),
                   "--gog", GOG, "--agent-name", prof["agent"]], env)
    fields2 = parse_line(out)
    r.check(tag + " idempotent",
            fields2.get("sheet_id") == sheet_id and fields2.get("created") == "no"
            and fields2.get("added") == "0" and fields2.get("verify") == "ok",
            "sheet reused=%s added=%s verify=%s"
            % (fields2.get("sheet_id") == sheet_id, fields2.get("added"), fields2.get("verify")))

    # 3) a new login appears -> only that row is appended
    prof_new = json.loads(json.dumps(prof))
    prof_new["logins"].append({"site": "new.example.org", "username": "new.user@example.org",
                               "password": True})
    with open(prof_path, "w", encoding="utf-8") as f:
        json.dump(prof_new, f, ensure_ascii=False)
    rc, out = run(["bash", os.path.join(HERE, "vault-sheet-init.sh"),
                   "--gog", GOG, "--agent-name", prof["agent"]], env)
    fields3 = parse_line(out)
    r.check(tag + " append only new",
            fields3.get("added") == "1" and fields3.get("rows") == str(rows_expected + 1),
            "added=%s rows=%s" % (fields3.get("added"), fields3.get("rows")))

    # 4) the user fills two password cells, then intake
    rows = sheet_rows(sheet_id)
    targets = [(i + 1, row[0]) for i, row in enumerate(rows[1:], start=1)
               if len(row) > 1 and row[1] and not (len(row) > 2 and row[2])][:2]
    if len(targets) < 2:
        r.check(tag + " fill+intake", False,
                "no pre-filled rows to fill (rows_read=%d prefilled=%d)"
                % (len(rows), sum(1 for row in rows[1:] if len(row) > 1 and row[1])))
        return
    for (row_no, _site), token in zip(targets, (TOKEN_A, TOKEN_B)):
        gog(["sheets", "update", sheet_id, "in!C%d" % row_no,
             "--values-json", json.dumps([[token]]), "--input", "RAW"])

    tmp_vault_dir = os.path.join(work, "vault")
    os.makedirs(tmp_vault_dir, exist_ok=True)
    shutil.copy(os.path.join(REPO, "agent-vault", "vault.py"),
                os.path.join(tmp_vault_dir, "vault.py"))
    vault_py = os.path.join(tmp_vault_dir, "vault.py")
    subprocess.run([sys.executable, vault_py, "init"], capture_output=True, text=True)

    env_intake = dict(env)
    env_intake["PICKLE_ULTRA_VAULT"] = vault_py
    rc, out = run([sys.executable, os.path.join(HERE, "intake_all.py"),
                   "--source", "sheet", "--sheet-id", sheet_id,
                   "--range", "in!A2:C200", "--gog", GOG], env_intake)
    ok_lines = [l for l in out.splitlines() if l.startswith("ok site=")]
    fails = [l for l in out.splitlines() if l.startswith("fail")]
    good = [l for l in ok_lines if "cleared=yes" in l]
    r.check(tag + " intake round trip",
            rc == 0 and len(ok_lines) == 2 and len(good) == 2,
            "rows=%d cleared=yes=%d exit=%d%s"
            % (len(ok_lines), len(good), rc, (" " + fails[0]) if fails else ""))

    after = sheet_rows(sheet_id)
    dirty = []
    for row_no, _site in targets:
        row = after[row_no - 1] if row_no - 1 < len(after) else []
        cells = [(c if isinstance(c, str) else str(c or "")) for c in row]
        if any(t in " ".join(cells) for t in (TOKEN_A, TOKEN_B)):
            dirty.append(row_no)
        if len(cells) > 2 and cells[2].strip():
            dirty.append(row_no)
    r.check(tag + " cells cleared on read-back", not dirty, "rows_still_holding=%d" % len(dirty))

    listing = subprocess.run([sys.executable, vault_py, "list"], capture_output=True, text=True)
    stored = [l.split("\t")[0] for l in listing.stdout.splitlines() if l.strip()]
    r.check(tag + " values in vault", len(stored) == 2, "items=%d" % len(stored))


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args(argv)

    r = Runner()
    root = tempfile.mkdtemp(prefix="pu-selftest-intake-")
    print("selftest-intake: Pickle Ultra Browser — %s" % REPO)
    print("selftest-intake: gog=%s work=%s" % (GOG, root))
    try:
        for prof in (PROFILE_A, PROFILE_B):
            profile_cycle(r, prof, root)
    finally:
        for sid in r.sheets:
            gog(["drive", "delete", sid, "--force"])
        if r.sheets:
            print("cleanup: sheets to trash=%d" % len(r.sheets))
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print("kept: %s" % root)

    print("----")
    if r.skipped and r.npass == 0:
        print("selftest-intake: SKIP reason=no-google (use extensions/vault-intake/vault-form.sh instead)")
        return 2
    print("selftest-intake: PASS=%d FAIL=%d" % (r.npass, r.nfail))
    return 0 if r.nfail == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
