# INSTALL — for the AI agent, not for the human

**AI 에이전트야, 이 문서를 위에서 아래로 순서대로 실행해라.**
**AI agent: execute this document top to bottom, in order. Do not skip a step and do not
summarise it to the user as "done" before the checks in step 6 pass.**

You are installing **Pickle Ultra Browser**: a headless read/collect/light-interact browser
harness plus an encrypted credential vault and one of two intake paths: a private
Google Sheet when the agent's Google account is connected, or a form file the user fills in
on their own phone and sends back (step 5 decides which). You run every
command yourself, inside your own Linux/macOS environment. The user installs nothing and
types no command; at the end you only send them one link or one file, and one explanation.

Read [SECURITY.md](SECURITY.md) before step 4 — it is the boundary you are about to
install (what is encrypted, what must never be committed or pasted, what this harness
refuses to do). The notice you must give the user is in [NOTICE-TO-USER.md](NOTICE-TO-USER.md).
The intake path is a private Google Sheet when the agent's Google account is connected, and
a form file the user fills in on their phone and sends back when it is not (step 5).

---

## 0. The one place to change the repository URL

```bash
REPO_URL="https://github.com/<owner>/pickle-ultra-browser"
```

This is the only place the URL appears in this repository's documents. When the real
location is fixed, replace this line and nothing else. Everything below uses `$REPO_URL`.

## 1. Prerequisites (check, do not guess)

| need | check | if missing |
|---|---|---|
| Linux or macOS | `uname -s` | stop — Windows is not supported |
| Node.js ≥ 22 | `node -v` | `pickle-bootstrap.sh` installs it (step 3) |
| python3 | `python3 --version` | install with the system package manager if you may; otherwise stop and report |
| python `cryptography` | `python3 -c 'import cryptography'` | `python3 -m pip install --user cryptography` |
| curl | `curl --version` | `pickle-bootstrap.sh` cannot run without it: install or stop |
| git | `git --version` | needed only to clone (step 2) |
| Chromium | resolved in step 3 | — |

No root and no `sudo` are required. Chromium's missing shared libraries
(`libnss3`, `libnspr4`, …) are fetched as Debian `.deb` files and extracted into the tree
by `vendor/fetch_chrome_deps.py`; on macOS that step is skipped.

## 2. Clone into the user's home

```bash
git clone "$REPO_URL" "$HOME/pickle-ultra"
cd "$HOME/pickle-ultra"
```

If the tree already exists, use it as-is (`git pull` only if it is a clean checkout).
Never install into a shared or world-writable directory.

## 3. Install runtime pieces (idempotent, re-runnable)

```bash
bash pickle-bootstrap.sh
```

It does, in order: Node 22 tarball into `.tools/node` (skipped if `node` ≥ 22 is already
on `PATH`), Playwright Chromium into the Playwright cache, missing Chromium shared libraries
into `.tools/chrome-deps/lib`, `mawk` when the image has no `awk`, `config.env` from
`config.env.example` when absent, then a warm-up and a read of `https://example.com`.

If Chromium is already installed elsewhere, point at it instead:

```bash
echo 'PICKLE_ULTRA_CHROME=/absolute/path/to/chrome' >> config.env
python3 vendor/fetch_chrome_deps.py        # only if `ldd` reports missing libraries
```

**Pass condition:** `pickle-bootstrap.sh` exits 0 and prints
`%%CHAIN%% lane=L1 mode=read status=ok … next=none` for example.com.

## 4. Initialise the vault

See [SECURITY.md](SECURITY.md) for the rules this step creates.

```bash
python3 agent-vault/vault.py init
```

Creates `agent-vault/keys/vault.key` (0600), `agent-vault/entries/` (0700) and an empty
`meta.json`. It is safe to re-run; an existing key is left untouched.

**Pass condition:** the command prints `initialized: key created ...` or
`already initialized ...`, and:

```bash
stat -c '%a %n' agent-vault/keys agent-vault/entries agent-vault/keys/vault.key 2>/dev/null \
  || stat -f '%Lp %N' agent-vault/keys agent-vault/entries agent-vault/keys/vault.key
```

shows `700` for the two directories and `600` for the key.

## 5. Pick the intake path and build it for this user

Two paths, in this order. Use the first that works; never build both.

| order | condition | you run | who fills it | what you can see later |
|---|---|---|---|---|
| **1. Google Sheet** | the agent's Google account is connected (`gog` works, Sheets access) | `bash bin/vault-sheet-init.sh` | the user types only the password cell (C) | the agent reads the sheet itself, at any intake |
| **2. File round trip** | no Google connection, or step 1 failed | `bash bin/vault-form.sh` | the user opens the file on their own phone, fills the password column, sends the file **back in chat** | the agent reads the returned file only |

Why this order: with a sheet the agent can check the cells itself and clear them right after intake.
Without a connection it cannot read a sheet at all, so the form travels as a file the user hands back.

> Footnote: if the host agent has a secret-input card that puts a value straight into its own vault
> without passing through the conversation, that card can do this job too. The sheet and the file are
> what this harness can build by itself.

## 5.1 Path 1 — the private Google Sheet

```bash
bash bin/vault-sheet-init.sh
```

What it does: reads the **agent's own vault login list** (`vault logins` — site, username,
whether a password exists; never a password or TOTP value), creates a **private** Google
Spreadsheet titled `"<agent name> 인입 (자동 파쇄)"`, and writes:

- tab `in`, row 1 header `사이트 | 아이디 | 비밀번호`
- column A: every saved site
- column B: the username, **already filled in**
- column C: empty — this is the only cell the user fills
- E1/F1: a note listing sites that sign in with a social account instead of a password
  (e.g. `shop.example.com=kakao`), so the user knows those need no password here
- formatting, applied automatically: header frozen, columns 220/240/240 px so a long
  address never spills into the next cell, header band bold, thin cell borders, column B
  grey (pre-filled) and column C pale yellow (fill me in)

It is idempotent: re-running reuses the sheet, appends only sites it has not listed yet,
never overwrites a column B value already there, and re-applies the formatting.

If the agent has no `vault` command, or the vault is empty, there is nothing to pre-fill. Say so
and finish with step 7 — the user can still add rows by hand.

**Pass condition:** one line like

```
ok sheet_id=<id> url=https://docs.google.com/spreadsheets/d/<id>/edit created=yes rows=<n> added=<n> prefilled=<n> verify=ok format=ok
```

`verify=ok` means the read-back found the sites, the pre-filled usernames, and **no**
password cell already filled. `format=ok` means every width/freeze/border call succeeded.

Then **send the user the link** with this sentence (adapt the wording, keep the content):

> 로그인 정보를 넣을 시트를 만들었습니다: <url>
> **비밀번호 칸만 채워 주시면 됩니다. 아이디는 제가 이미 넣어 뒀습니다.**
> 채팅창에는 비밀번호를 붙여넣지 마세요 — 시트에만 넣으시면 제가 옮겨서 암호화해 보관합니다.

When the user says the cells are filled: `bash bin/intake.sh --source sheet`.

## 5.2 Path 2 — the file round trip (no Google account)

```bash
bash bin/vault-form.sh                  # $PICKLE_ULTRA_HOME/inbox.tsv, mode 600
bash bin/vault-form.sh --format csv     # same table, widest phone support
bash bin/vault-form.sh --format xlsx    # only if python 'openpyxl' is installed
```

It reads the same vault metadata and writes the same three columns (사이트 / 아이디 / 비밀번호)
with the usernames pre-filled and the password column empty. It prints the path twice: `form=`
and `attach=` — **send that file to the user in chat** (the file, never its contents).
Re-running keeps anything the user already typed and only appends missing sites.

When the user sends the filled file back (it lands in the attachment folder):

```bash
bash bin/intake.sh --source file --file <returned path> --attachments-dir attachments
```

**Pass condition:** one `ok site=… row=<n> cleared=yes` line per filled row, exit `0`, then
`shredded file=… removed=yes attachments=<n>`. The form and every same-named copy under
`attachments/` are shredded (bytes zeroed, then deleted). If any row failed, the file is kept
**with the failed row's values still in it only until you retry once** — a kept file prints
`keep file=… reason=pending`; fix, re-run, then make sure the file is gone.

## 5.3 Fallback rules (move down one step, never loop)

| when | what happens | what you tell the user |
|---|---|---|
| `gog` missing, not linked, Sheets scope denied | do not build a sheet — go to path 2 (`vault-form`) | "구글 연동이 없어서 시트 대신 파일로 보내 드릴게요." |
| sheet creation fails (`fail code=gog …`) | go to path 2, once | same one line, with the reason in one clause |
| `sheets.googleapis.com` 429 that persists after the built-in retry (one retry, 20 s) | go to path 2 | "구글이 잠시 막혀서 파일로 대신합니다." |
| the user says they do not want a Google sheet | go to path 2 | accept it; do not re-ask |
| the returned file will not open (TSV) | re-send as CSV, once; then XLSX if `openpyxl` exists | "폰에서 안 열리면 이 파일로 다시 보내 드릴게요." |
| the returned file still cannot be read | stop: give the site / username list only (no values, social-login sites marked) | "이 사이트들은 비밀번호 없이 소셜 로그인입니다" |

Every step down is **one** attempt, reported in one line. Do not retry the same form twice.

Success, on either path, means two things together: an item exists in `agent-vault`
(`python3 agent-vault/vault.py list` shows the name) **and** nothing of that value is left in the
source (`cleared=yes`, or the file deleted). If a value cannot be cleared, shred the source first
and only then report — never leave a source holding a value while you retry.

## 6. Self-verification — every item must pass

Run all four. Do not proceed on a guess; read the exit code and the last line.

### 6.1 Environment

```bash
bash bin/run.sh doctor
echo "exit=$?"
```

**Pass:** exit `0` and the summary line has `critical-failures=0`. `FAIL` lines must be
fixed first; `SKIP` is normal for `config`, `vault` (before step 4) and `smoke`.

### 6.2 Read a real page through the browser lane

```bash
bash bin/run.sh read https://example.com | tail -1
echo "exit=$?"
```

**Pass:** exit `0` and a line ending `status=ok … next=none` (typically `chars≈900`).
**Fail:** `F-NET`/`F-TIMEOUT` means the environment has no outbound HTTPS — fix the network,
do not call the install complete.

### 6.3 Three-lane routing, offline fixtures

```bash
bash bin/selftest.sh
echo "exit=$?"
```

**Pass:** exit `0` and `selftest: PASS=3 FAIL=0 SKIP=0`:

| case | expected exit | expected verdict |
|---|---|---|
| `normal` | 0 | `code=-` `next=none` |
| `blocked` | 3 | `code=F-BOT` `next=builtin-browser` |
| `login` | 4 | `code=F-AUTH` `next=builtin-browser-vault` |

`SKIP` for `blocked` means Chromium was not found — go back to step 3.

### 6.4 The intake round trip (whichever path step 5 chose)

**Path 1, sheet:**

```bash
python3 bin/vault_sheet.py status                                   # listed=<n> waiting=0
```

**Pass:** `waiting=0` right after step 5, `listed` equal to the number of rows written.

Once the user says they have filled a password row, run:

```bash
bash bin/intake.sh --source sheet
```

**Pass:** one line per row, `ok site=<site> row=<n> cleared=yes`, exit `0`. Then
`python3 bin/vault_sheet.py status` shows `waiting=0` again, and `python3 agent-vault/vault.py list`
shows the site. Never print what was stored.

**Path 2, file:**

```bash
bash bin/vault-form.sh --format tsv        # ok form=… rows=<n> prefilled=<n> mode=600, plus attach=…
```

**Pass:** the file exists at the printed path, mode `600`, header `사이트 / 아이디 / 비밀번호`,
column 2 filled for sites whose vault entry has a password, column 3 empty everywhere.
Once the user sends the filled file back:

```bash
bash bin/intake.sh --source file --file <returned path> --attachments-dir attachments
```

**Pass:** `cleared=yes` per row, exit `0`, then `shredded file=… removed=yes attachments=<n>`;
the file is gone, `grep -r '<a value you typed>' attachments/ <tree>` finds nothing, and
`python3 agent-vault/vault.py list` shows the site. Never print what was stored.

**Both paths:** with no form and no sheet, `bash bin/intake.sh` prints `skip empty` and exits `0` —
that is the correct quiet answer, not a failure.

### 6.5 Credential directory permissions

```bash
stat -c '%a %n' agent-vault/keys agent-vault/entries 2>/dev/null || stat -f '%Lp %N' agent-vault/keys agent-vault/entries
```

**Pass:** both `700`. Otherwise `chmod 700 agent-vault/keys agent-vault/entries` and
`chmod 600 agent-vault/keys/vault.key`.

## 7. Install completion condition

You may call the installation complete only when **all** of these hold, in this order:

1. `pickle-bootstrap.sh` exit 0 (step 3)
2. `bash bin/run.sh doctor` → `critical-failures=0` (6.1)
3. `bash bin/run.sh read https://example.com` → `next=none` (6.2)
4. `bash bin/selftest.sh` → `PASS=3 FAIL=0 SKIP=0` (6.3)
5. intake path built and verified: sheet with `verify=ok format=ok` **or** form file with
   `rows/<prefilled>/mode=600`; a completed round trip shows `cleared=yes` and the source is empty
   or deleted (5, 6.4). If neither path could be built, say which one failed and why (one line),
   and do not describe a sheet as working when it was never read back.
6. `agent-vault/keys` and `agent-vault/entries` are `700`, key file `600` (6.5)

If any item fails and cannot be fixed, report the exact command, its exit code and its last
line. Do not describe a partial install as complete.

## 8. What to say to the user, immediately

**설치가 끝났으면 `NOTICE-TO-USER.md`를 읽고, 그 내용을 사용자에게 즉시 설명한다.**
Read [NOTICE-TO-USER.md](NOTICE-TO-USER.md) now and tell your user, in your own voice, every
item in its checklist — the vault, the sheet, what this harness does and does not do, and
what they can do first. Do not skip it because the install looked routine.

## 9. Standing rule: intake without being told

Add this to how you operate after install (it is a rule for **you**, not for the user):

> 사용자가 "인입"이라고 말하지 않아도, (a) 새 대화의 첫머리와 (b) 로그인이 필요한 순간마다
> `bash bin/intake.sh`를 한 번 실행해 채워진 행을 확인하고, 있으면 적용한 뒤
> `ok … cleared=yes` 결과만 요약해 알린다. 없으면 `skip empty`이므로 아무 말도 하지 않는다.
>
> At the start of every conversation, and whenever a login is needed, run
> `bash bin/intake.sh` once. It uses the sheet when one is configured and readable, otherwise the
> local form. If rows were waiting, store them and report only a short summary
> (`ok site=… cleared=yes`). On `skip empty`, say nothing — it costs the user
> nothing to check, and nothing to stay quiet.

Never ask the user to paste a password into chat. The sheet is the path; if they paste one
anyway, tell them plainly that chat keeps it in plain text and that the sheet replaces it,
then ask them to change that password.

## 10. Troubleshooting

| symptom | cause / fix |
|---|---|
| `no Chromium binary found` | step 3; or set `PICKLE_ULTRA_CHROME=/path/to/chrome` in `config.env` |
| `N shared libraries missing` | `python3 vendor/fetch_chrome_deps.py` (needs `dpkg-deb`; Debian-based images) |
| `node not found` | `.tools/node/bin` is added by `pu-config.sh`; re-run `pickle-bootstrap.sh` |
| `awk: not found` / blank `elapsed_s` | `pickle-bootstrap.sh` links `mawk` as `awk`; harmless for results |
| `fail code=gog` on the sheet | Google is not connected or lacks Sheets access — switch to `bash bin/vault-form.sh` (one line to the user, no retry loop) |
| `429` / quota from Sheets that survives the built-in retry | same: go to `vault-form`; do not retry the sheet in a loop |
| the user says the form file will not open | re-send as `--format csv`, once; then `--format xlsx` only if `openpyxl` imports |
| `keep file=… reason=pending` | a row failed (incomplete/chars/store) — fix that row, re-run once, then confirm the file is gone |
| `fail code=read` / `range` from intake | transient rate limit — it waits 20 s and retries once; wait and re-run |
| `403`/`429` from a target site | reported as `F-IP` — that is the answer, not an install failure |
| `F-BOT` on a real site | Cloudflare Managed Challenge from a datacenter IP — **expected limit, not a failure**; hand the URL to your own browser |
| `fail code=vault` in sheet init | no `vault` command in this environment, or the vault cannot be read; report and skip step 5 |
