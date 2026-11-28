# Security policy

Pickle Ultra Browser reads the open web on an agent's behalf and keeps credentials in an
encrypted store. This file states what is protected, what the limits are, and how to report
a problem.

Related: [README](README.md) · [INSTALL](INSTALL.md) · [NOTICE-TO-USER](NOTICE-TO-USER.md)

## Credential handling

- Values are encrypted with **Fernet** at rest: `agent-vault/entries/<name>.enc` (mode 0600),
  key in `agent-vault/keys/vault.key` (0600), directories `0700`.
- A value is accepted **only** through stdin or `--from-file`. There is deliberately no
  command-line option for a value: argv leaks into shell history and the process list.
  `store --from-file` overwrites the source file before removing it.
- `use` decrypts in memory and hands the value to a child process through its environment
  (`AGENT_VAULT_VALUE` by default) or stdin. The zeroed buffer is overwritten after use.
- **No command prints a value.** `list` prints names, purposes and timestamps only.
  Error messages are fixed strings, never exception text that could carry a value.
- The vault is git-ignored (`.gitignore`) along with `.state/`, `.tmp/`, `.tools/`, the
  browser profile, `config.env` and the local intake form (`inbox.tsv` / `inbox.csv`, mode
  0600). Never commit them, never upload the tree with them, never paste them into a chat
  or a ticket.

## What this harness will not do

- It does not fill password fields: `run.sh type` on a password field returns
  `code=F-AUTH next=builtin-browser-vault` and changes nothing. The guard is in the
  browser layer too (`p.type`, `p.typeText`, `p.press` all refuse when the target is a
  password field), so a `-f` script cannot bypass the CLI check, and the typed text never
  appears in an error or a log.
- It does not switch browsers by itself: `next=` is a signal for the calling agent. When the
  vault already holds a credential for the host, the login wall reports `next=ultra-vault`
  (exit 5) instead — the caller continues here with `vault.py use`.
- It does not sign in, pay, solve CAPTCHAs, or bypass bot walls. A `F-BOT`/`F-IP` verdict is
  the honest answer for a datacenter egress IP.
- It does not touch the user's own browser profile. Its profile is `<tree>/.state/profile`.

## The one explicit exception: `bin/vault-login.mjs`

`run.sh` never fills a password field, and a `-f` script cannot either (the guard sits
in the daemon, before the text reaches the page). `bin/vault-login.mjs` is the separate,
explicitly invoked path for a login the user asked for, and the boundary is drawn there:

- It is the **only** component that reads `agent-vault` and types a password, and it does so
  only in that one run. Nothing in `run.sh`, in page content, or in the daemon's own command
  surface can reach the vault; the page script receives the value only as keystrokes.
- Credentials are typed only into the host named by the vault entry: `https:` only, plain
  `http:` for `127.0.0.1`/`localhost` only, host equal to the entry or a subdomain of it.
  A different URL is refused with `status=origin_mismatch` **before** the vault is opened,
  again after every submit, and again before a `chp=` re-entry — a redirect cannot carry the
  form to another host and keep the values.
- Values are never printed: stdout/stderr and the state file carry status, URLs and page
  state only. URLs in output and state lose their query and fragment (they may hold tokens),
  the state file and screenshots are written `0600`, and a symlink at any of those paths is
  refused (`status=unsafe_path`).
- A login is reported as success only with a positive signal — still on the entry's host, no
  password field, no challenge, no error code. A blank or browser-error page is a failure.
- The daemon socket is still full local trust: anything that can connect can run JS in this
  profile. `vault-login` narrows *who may read the vault and type it where*, not what a
  local process on this account can do.

## The intake sheet and the form file

Both carry one deliberate exposure: a password exists outside the vault until the agent
moves it — in a Google Sheet, or in the form file the user filled in on their phone.

- Create a sheet with `extensions/vault-intake/vault-sheet-init.sh`, which leaves the default **private** sharing as
  is. Never turn it into a public or link-shared document. Without a connected Google account
  there is no sheet: `extensions/vault-intake/vault-form.sh` writes the same three columns to
  `$PICKLE_ULTRA_HOME/inbox.tsv` (mode 0600) instead.
- `extensions/vault-intake/intake.sh` clears column B:C of each sheet row it handles, or rewrites
  the file row with the site only, and reads it back to check. The form file and its same-named
  copies under `attachments/` are then zeroed and deleted; a row that failed to store is cleared
  the same way, so no value is left behind for a retry.
  If it prints `cleared=no`, the value is still there: shred the source first, tell the user, and
  treat the password as exposed in a document you control.
- The sheet never receives a value from this harness — only the user types into column C. The
  same goes for the file: only the user fills the password column, and the filled file comes
  back as a chat attachment, never as text in the conversation.

## The browser process and its files

- Chromium runs from the Playwright cache with the profile in `.state/profile` (0700).
  The Unix socket that drives it is `.state/cdp-daemon.sock`, mode **0600**: anything that
  can connect to it can run arbitrary JS in the browser as this user, so it must not be
  reachable by another local account. The state directory is 0700, the PID file 0600.
- **Sandbox**: `PU_CHROME_SANDBOX=auto` (default) enables Chromium's sandbox when this host
  can run it (user namespaces on Linux, a root-owned setuid `chrome_sandbox`, or macOS
  seatbelt). Where it cannot, the daemon launches with `--no-sandbox` and warns on stderr
  and in `cdp-daemon.log` — inside a page that means page scripts run with this user's
  rights, which is why it is stated rather than hidden. `require` refuses to launch;
  `off` accepts it silently. Do not use `require` in a container without namespaces and
  expect the browser to work.
- **Downloads from the installer**: the Node tarball is verified against nodejs.org's
  `SHASUMS256.txt`; Debian `.deb` files are verified against the SHA256 in the `Packages`
  index. Playwright publishes no checksum for the browser archive — pin the version
  (`PLAYWRIGHT_VERSION`) and, if you have recorded the hash once,
  set `PU_CHROMIUM_SHA256` to make it strict.

## Reporting

Open a private GitHub security advisory for the repository, or contact the maintainer
directly. Please do not file a public issue for a credential-handling defect. Include the
version (`git log -1 --format=%h`; a tree installed from a tarball has no `.git` — give the
release or download date instead), the command, and what you observed — never a real
password, key, or session cookie.

## Supported versions

The latest commit on the default branch. This is a small harness; fixes land there.

## 운영상 주의 (한국어)

- `agent-vault/keys`·`entries`와 `config.env`, `.state/profile`, `inbox.tsv`은 **보관 금지** 대상입니다.
  드라이브 업로드·슬랙 보고·채팅 붙여넣기에서 제외하세요.
- 사용자에게는 **채팅으로 비밀번호를 받지 않습니다.** 시트(또는 보내 드린 파일)가 유일한 통로이고,
  옮긴 뒤 셀을 지우거나 파일을 파쇄하는 것까지가 한 동작입니다.
- 시트 공유 설정은 비공개 기본값 그대로 둡니다. 링크 공유로 바꾸지 않습니다.
- `bin/vault-login.mjs`는 사용자가 명시적으로 부를 때만 금고를 읽고 로그인 폼에 입력합니다.
  일반 `run.sh` 경로와 페이지 스크립트는 여전히 비밀번호 필드를 채울 수 없고, 금고에도 닿지 못합니다.
  대상 호스트가 금고 항목과 다르면 `origin_mismatch`로 멈추고, 값은 출력·상태 파일에 남기지 않습니다.
