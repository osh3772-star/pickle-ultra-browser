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
| sandbox support (optional) | `cat /proc/sys/kernel/unprivileged_userns_clone` (Linux) | without it the daemon launches `--no-sandbox` and warns; `PU_CHROME_SANDBOX=require` refuses instead |

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

It does, in order:

1. **Node, pinned** (`NODE_VER`, default `v22.23.5`) into `.tools/node`, for the platform it
   detects (`Linux x86_64/arm64`, `macOS x86_64/arm64`; anything else stops with exit 2 before
   changing anything). The tarball is cached, resumed after an interruption, and
   **verified against nodejs.org's `SHASUMS256.txt`**; a mismatch stops the run with exit 3
   and installs nothing.
2. **Playwright Chromium, pinned** (`PLAYWRIGHT_VERSION=1.65.1`, browser revision 1255) into
   the Playwright cache. Playwright publishes no checksum for the browser archive, so the
   pin plus a post-install "does it run" check is what this build can offer; set
   `PU_CHROMIUM_SHA256=<hex>` to make it strict (the run prints the hash it found).
3. Missing Chromium shared libraries into `.tools/chrome-deps/lib`, each `.deb` verified
   against the **SHA256 in the Debian `Packages` index** before extraction.
4. `mawk` when the image has no `awk`.
5. `config.env` from `config.env.example` **only when absent**, then a warm-up and a read of
   `https://example.com`.

Nothing the user owns is touched: an existing `config.env`, `.state/` (profile and cookies),
`.tmp/` and `agent-vault/` survive a re-run, so updating keeps the signed-in profile and the
filled vault. Re-running is safe at any point.

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
| **1. Google Sheet** | the agent's Google account is connected (`gog` works, Sheets access) | `bash extensions/vault-intake/vault-sheet-init.sh` | the user types only the password cell (C) | the agent reads the sheet itself, at any intake |
| **2. File round trip** | no Google connection, or step 1 failed | `bash extensions/vault-intake/vault-form.sh` | the user opens the file on their own phone, fills the password column, sends the file **back in chat** | the agent reads the returned file only |

Why this order: with a sheet the agent can check the cells itself and clear them right after intake.
Without a connection it cannot read a sheet at all, so the form travels as a file the user hands back.

> Footnote: if the host agent has a secret-input card that puts a value straight into its own vault
> without passing through the conversation, that card can do this job too. The sheet and the file are
> what this harness can build by itself.

## 5.1 Path 1 — the private Google Sheet

```bash
bash extensions/vault-intake/vault-sheet-init.sh
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

When the user says the cells are filled: `bash extensions/vault-intake/intake.sh --source sheet`.

## 5.2 Path 2 — the file round trip (no Google account)

```bash
bash extensions/vault-intake/vault-form.sh                  # $PICKLE_ULTRA_HOME/inbox.tsv, mode 600
bash extensions/vault-intake/vault-form.sh --format csv     # same table, widest phone support
bash extensions/vault-intake/vault-form.sh --format xlsx    # needs python3 + openpyxl (clear fail without it)
```

It reads the same vault metadata and writes the same three columns (사이트 / 아이디 / 비밀번호)
with the usernames pre-filled and the password column empty. It prints the path twice: `form=`
and `attach=` — **send that file to the user in chat** (the file, never its contents).
Re-running keeps anything the user already typed and only appends missing sites.

When the user sends the filled file back (it lands in the attachment folder):

```bash
bash extensions/vault-intake/intake.sh --source file --file <returned path> --attachments-dir attachments
```

**Pass condition:** one `ok site=… row=<n> cleared=yes` line per filled row, exit `0`, then
`shredded file=… removed=yes attachments=<n> home=<n>`. The form and every same-named copy
under `attachments/` are shredded (bytes zeroed, then deleted). A row that fails is reported as
`fail code=… row=<n> cleared=yes`: its value is shredded too, the file is still deleted, and you
ask the user to refill **only that row** — never leave a value on disk for a retry.

## 5.3 Fallback rules (move down one step, never loop)

| when | what happens | what you tell the user |
|---|---|---|
| `gog` missing, not linked, Sheets scope denied | do not build a sheet — go to path 2 (`vault-form`) | "구글 연동이 없어서 시트 대신 파일로 보내 드릴게요." |
| sheet creation fails (`fail code=gog …`) | go to path 2, once | same one line, with the reason in one clause |
| `sheets.googleapis.com` 429 that persists after the built-in retry (one retry, 20 s) | go to path 2 | "구글이 잠시 막혀서 파일로 대신합니다." |
| the user says they do not want a Google sheet | go to path 2 | accept it; do not re-ask |
| the returned file will not open (TSV) | re-send as CSV, once; then XLSX if python3 + `openpyxl` exist | "폰에서 안 열리면 이 파일로 다시 보내 드릴게요." |
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

**Pass:** exit `0` and `selftest: PASS=23 FAIL=0 SKIP=0` with Chromium installed
(`PASS=18 FAIL=0 SKIP=5` when it is not — the five cases that need the browser are skipped,
not passed). The selftest starts `tests/http-server.mjs` on
localhost — real status codes, a JS-rendered page, login walls, a redirect — because
`file://` URLs make curl answer `000` and cannot exercise a lane honestly.

| case | exit | verdict |
|---|---|---|
| `normal`, `normal-ko`, `redirect` | 0 | `-` / `next=none` |
| `doc-about-403(-ko/-ja)` — long documents that discuss blocks | 0 | `-` (this is the false-positive regression) |
| `public-login-link`, `public-login-box` — public pages with a sign-in link/hidden modal | 0 | `-` |
| `http-403`, `http-429`, `block-ko`, `block-ja` | 3 | `F-IP` / `next=builtin-browser` |
| `challenge`, `challenge-ja` | 3 | `F-BOT` |
| `http-500` (L0 / chain) | 1 / 3 | `F-NET`, then `F-EMPTY` after L1 |
| `login-wall`, `login-attrs`, `login-ja` (attribute spellings) | 4 | `F-AUTH` / `next=builtin-browser-vault` |
| `js-rendered` | 0 | `path=L0:F-EMPTY>L1:ok` |
| `dynamic-login` (password field created after load) | 4 | `F-AUTH` |
| `empty-shell` | 3 | `F-EMPTY` |
| `type-password` (CLI refuses, secret not echoed) | 1 | `F-AUTH` |

`SKIP` means no Chromium — go back to step 3. A skipped case is not a pass.

`bash tests/run-tests.sh` runs this plus the unit, vault, bootstrap, sandbox, thread-growth
and browser-feature suites.

### 6.3b What `next=` can say (read this before wiring an agent)

Every command ends with one line whose last field is `next=`. The calling agent decides;
nothing switches browsers automatically.

| `next=` | exit | meaning for the caller |
|---|---|---|
| `none` | 0 / 1 | use the result / stop (transport failure, selector miss) |
| `builtin-browser` | 3 | blocked or empty — read it in your own browser tool |
| `builtin-browser-vault` | 4 | login wall and **no** credential in the vault for this host — your browser + `browser_fill_secret` |
| `ultra-vault` | 5 | login wall **and** `agent-vault` holds a credential for this host (the line also carries `vault=<entry>`) — continue here: drive the login with an L1 `-f` script that gets the value from `python3 agent-vault/vault.py use <entry> -- …` |

The vault check reads metadata only (`vault.py list`: name, purpose, stored date) and matches
the host, the host without `www.`, and its registrable parent (`shop.example.co.kr` →
`example.co.kr`). A host in `AUTH_SKIP_HOSTS` is no longer skipped when a credential exists:
the lanes run first, because the profile may already hold a live session.

### 6.4 The intake round trip (whichever path step 5 chose)

**Path 1, sheet:**

```bash
bash extensions/vault-intake/vault-sheet-status.sh                                      # listed=<n> waiting=0
```

**Pass:** `waiting=0` right after step 5, `listed` equal to the number of rows written.

Once the user says they have filled a password row, run:

```bash
bash extensions/vault-intake/intake.sh --source sheet
```

**Pass:** one line per row, `ok site=<site> row=<n> cleared=yes`, exit `0`. Then
`bash extensions/vault-intake/vault-sheet-status.sh` shows `waiting=0` again, and `python3 agent-vault/vault.py list`
shows the site. Never print what was stored.

**Path 2, file:**

```bash
bash extensions/vault-intake/vault-form.sh --format tsv        # ok form=… rows=<n> prefilled=<n> mode=600, plus attach=…
```

**Pass:** the file exists at the printed path, mode `600`, header `사이트 / 아이디 / 비밀번호`,
column 2 filled for sites whose vault entry has a password, column 3 empty everywhere.
Once the user sends the filled file back:

```bash
bash extensions/vault-intake/intake.sh --source file --file <returned path> --attachments-dir attachments
```

**Pass:** `cleared=yes` per row, exit `0`, then `shredded file=… removed=yes attachments=<n>`;
the file is gone, `grep -r '<a value you typed>' attachments/ <tree>` finds nothing, and
`python3 agent-vault/vault.py list` shows the site. Never print what was stored.

**Both paths:** with no form and no sheet, `bash extensions/vault-intake/intake.sh` prints `skip empty` and exits `0` —
that is the correct quiet answer, not a failure.

### 6.5 Credential directory permissions

```bash
stat -c '%a %n' agent-vault/keys agent-vault/entries 2>/dev/null || stat -f '%Lp %N' agent-vault/keys agent-vault/entries
```

**Pass:** both `700`. Otherwise `chmod 700 agent-vault/keys agent-vault/entries` and
`chmod 600 agent-vault/keys/vault.key`.

### 6.6 The intake harness itself (one command)

```bash
bash extensions/vault-intake/selftest-intake.sh
echo "exit=$?"
```

**Pass:** exit `0` and `selftest-intake: PASS=14 FAIL=0`. It builds real throwaway sheets for two
fake profiles (10 email-style logins with 10 usernames pre-filled; 8 student-id + social logins
with 3), re-runs for idempotency (`created=no added=0`), appends one new login (`added=1`), fills
two password cells, runs the sheet intake, checks the cells are cleared and the values are in a
throwaway vault, then moves every sheet to the trash.

**Skip:** exit `2` / `SKIP reason=no-google` — this agent has no Sheets access, so the install
uses path 2; run `bash extensions/vault-intake/vault-form.sh` and `selftest` by hand with
`--from-json` instead. That is not an install failure.

**Do not** point this at the user's own sheet or vault: it creates its own config folder, its own
vault and its own sheets.

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
7. `selftest-intake.sh` → `PASS=14 FAIL=0`, or a reported `SKIP reason=no-google` (6.6)

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
> `bash extensions/vault-intake/vault-sheet-status.sh`로 채워진 행(`waiting=`)을 먼저 보고,
> 1 이상이면 `bash extensions/vault-intake/intake.sh`를 실행한다. 적용했으면
> `ok … cleared=yes`만 요약해 알리고, `waiting=0`·`skip empty`이면 아무 말도 하지 않는다.
>
> At the start of every conversation, and whenever a login is needed, run
> `bash extensions/vault-intake/vault-sheet-status.sh` first (counts only: `waiting=`, `unfilled=`,
> `checked_at=`). If `waiting` is 1 or more, run `bash extensions/vault-intake/intake.sh` once —
> it uses the sheet when one is configured and readable, otherwise the local form. Report only a
> short summary (`ok site=… cleared=yes`). On `waiting=0` / `skip empty`, say nothing — it costs
> the user nothing to check, and nothing to stay quiet.

Never ask the user to paste a password into chat. The sheet (or the file you sent) is the path;
if they paste one anyway, tell them plainly that chat keeps it in plain text and that the sheet
replaces it, then ask them to change that password.

The plugin's own reference — commands, requirements, fallback summary, files — is
[extensions/vault-intake/README.md](extensions/vault-intake/README.md).

## 10. Troubleshooting

| symptom | cause / fix |
|---|---|
| `no Chromium binary found` | step 3; or set `PICKLE_ULTRA_CHROME=/path/to/chrome` in `config.env` |
| `N shared libraries missing` | `python3 vendor/fetch_chrome_deps.py` (needs `dpkg-deb`; Debian-based images) |
| `node not found` | `.tools/node/bin` is added by `pu-config.sh`; re-run `pickle-bootstrap.sh` |
| `awk: not found` / blank `elapsed_s` | `pickle-bootstrap.sh` links `mawk` as `awk`; harmless for results |
| `fail code=gog` on the sheet | Google is not connected or lacks Sheets access — switch to `bash extensions/vault-intake/vault-form.sh` (one line to the user, no retry loop) |
| `429` / quota from Sheets that survives the built-in retry | same: go to `vault-form`; do not retry the sheet in a loop |
| the user says the form file will not open | re-send as `--format csv`, once; then `--format xlsx` only if python3 + `openpyxl` import |
| `fail code=… row=<n> cleared=yes` on a file | that row could not be stored (incomplete/chars/site/store); its value was shredded — ask the user to refill only that row |
| `fail code=read` / `range` from intake | transient rate limit — it waits 20 s and retries once; wait and re-run |
| `403`/`429` from a target site | reported as `F-IP` — that is the answer, not an install failure |
| `F-BOT` on a real site | Cloudflare Managed Challenge from a datacenter IP — **expected limit, not a failure**; hand the URL to your own browser |
| `fail code=vault` in sheet init | no `vault` command in this environment, or the vault cannot be read; report and skip step 5 |
| `selftest-intake: SKIP reason=no-google` | expected when the agent has no Sheets access — use `vault-form.sh`; not a failure |
