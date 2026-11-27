# extensions/vault-intake — automatic credential intake (optional plugin)

Turns "the user has a password for this site" into "the vault holds it" without the password
ever passing through the conversation. The harness core (`bin/`, `agent-vault/`) does not need
this plugin: without it the vault is simply filled by hand.

## What it builds, without being asked twice

```
vault logins (metadata only)                    the user, on their own phone
        │                                                   │
        ▼                                                   ▼
  private Google Sheet  ── A 사이트 / B 아이디(미리 채움) / C 비밀번호 ──┐
  (no Google account)   ── the same table as a file they send back ─────┤
                                                                       ▼
                intake.sh: store in agent-vault, clear the cells / shred the file
```

Nothing in it is specific to one install: the site list comes from `vault logins`, the sheet id,
tab, range and agent name from `~/.config/pickle-ultra/config.json` (0600, `PU_CONFIG_DIR`
overrides the folder), and the vault path from `PICKLE_ULTRA_VAULT` (default
`agent-vault/vault.py`).

## Commands

| command | what it does | exit codes |
|---|---|---|
| `vault-sheet-init.sh` | unattended: read logins → create the private sheet → pre-fill usernames → widths / frozen header / borders / highlight the password column → verify by read-back → print the link and the sentence to send | 0 ok · 1 fail (one `fail code=…` line) |
| `vault-form.sh` | no-Google path: write the same table to `$PICKLE_ULTRA_HOME/inbox.tsv` (0600; `--format csv`, `--format xlsx` with `openpyxl`) and print `attach=<path>` to send | 0 ok/skip · 1 fail |
| `vault-sheet-status.sh` | counts only: `status source=… listed= waiting= unfilled= checked_at=` — run it at the start of a conversation, before a login | 0 ok/skip · 1 sheet unreadable |
| `intake.sh` | move filled rows in: `--source auto\|sheet\|file`, `--file`, `--attachments-dir` | 0 all rows stored · 1 any row failed |
| `selftest-intake.sh` | builds two throwaway profiles' sheets, re-runs for idempotency, appends a login, fills two cells, round-trips intake, trashes everything | 0 pass · 1 fail · 2 no Google access |

Idempotent by design: a second `vault-sheet-init.sh` reuses the sheet (`created=no added=0`),
never overwrites a column B already there, and appends only sites that are new.

## Requirements

- Sheet path: a connected Google account with Sheets access through `gog`
  (`PU_GOG` can point at another binary), plus `vault` on `PATH` or `PU_VAULT_CLI`
  pointing at something that answers `vault logins` with `{site, username, password, method}`.
- File path: Node.js ≥ 22 (already required by the harness core) — the user needs an app that
  opens `.tsv`, `.csv` or `.xlsx`. The optional XLSX form needs python3 with `openpyxl`;
  without it the command prints `fail code=write reason=xlsx-unavailable` and TSV/CSV still work.
- `PICKLE_ULTRA_HOME` (default: the repository root) is where `inbox.*` lives, mode 0600,
  git-ignored.

## Fallback, in one table

| if | then |
|---|---|
| `gog` missing / not linked / Sheets denied / creation failed / 429 past one retry / user declines the sheet | use `vault-form.sh` (file round trip) — tell the user in one line why |
| the returned file will not open | re-send once as CSV, then once as XLSX if `openpyxl` imports |
| even that fails | give the site + username list only, mark social-login sites, stop. No retry loop. |
| a sheet is configured but unreadable during `intake.sh --source auto` | `note fallback=file` and read the form instead |

## Security boundary

- Values only ever move through stdin/pipe into `agent-vault`; no command prints one.
- A row counts as filled only when its password cell is non-empty (the username is pre-filled
  by the plugin, so an empty password is "not yet", never an error).
- After intake the password is cleared and read back: sheet cell C (keeping pre-filled
  username in B), or the file row's password column (bytes zeroed first). The form file
  plus its same-named copies under `attachments/` are then zeroed and deleted. A row that
  failed to store is cleared the same way and reported as `fail code=… row=<n> cleared=yes`,
  so no password waits on disk; ask the user to fill it again.
  `cleared=no` alone means a value may still be there: shred it first, then report.
- The plugin never reads a password from the vault, and never writes one into a page.

## Files

```
vault-sheet-init.sh     thin wrapper → vault-sheet.mjs init
vault-sheet-status.sh   counts-only "should I run intake now?" → vault-sheet.mjs status
vault-sheet.mjs         sheet builder + status (formatting, verify, idempotency)
vault-form.sh           thin wrapper → vault-form.mjs
vault-form.mjs          local form writer (tsv/csv, xlsx with python3+openpyxl) + reader
intake.sh               thin wrapper → intake-all.mjs
intake-all.mjs          sheet/file intake, clearing, shredding, deletion
selftest-intake.sh      wrapper → selftest-intake.mjs (two throwaway profiles)
lib.mjs                 shared helpers: gog + 20 s retry, JSON walkers, normalizeSite,
                        config file, TSV/CSV, shred, argument reader
```

Everything here is plain Node ESM with no npm dependencies. Only `agent-vault/vault.py`
stays Python (Fernet), and it is called as a CLI with the value on stdin.

## Login & CAPTCHA Screenshot Harness (`bin/vault-login.mjs`)

- `node bin/vault-login.mjs <url> <vault-site>` reads credentials inside the daemon
  without printing secrets, fills and submits the form, and returns JSON.
- If a CAPTCHA (e.g., Naver receipt verification) appears after submit, it keeps the
  task space alive, saves a screenshot (`browser/captcha-<site>.png` by default), and
  returns `{"ok":false,"status":"captcha","space":"...","screenshot":"..."}` so the
  agent can send the image to the user right away.
- Once the user replies with the answer, submit it on the same live page via
  `node bin/vault-login.mjs --captcha-answer <text> --space <name>`.
- **Sandboxed runner bridge (`--wait-answer-file <path> --state-file <path>`)**: On
  ephemeral runners that reap background processes between `shell` calls, run
  `vault-login.mjs` inside a background subagent `shell` with `--wait-answer-file` and
  `--state-file`. When a CAPTCHA appears, it writes the screenshot and state JSON, polls
  the answer file every 500ms within the same live page, submits the user's reply, and
  persists cookies to the profile before exiting.
