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

- It does not fill password fields: `run.sh type` on `input[type=password]` returns
  `code=F-AUTH next=builtin-browser-vault` and changes nothing.
- It does not sign in, pay, solve CAPTCHAs, or bypass bot walls. A `F-BOT`/`F-IP` verdict is
  the honest answer for a datacenter egress IP.
- It does not touch the user's own browser profile. Its profile is `<tree>/.state/profile`.

## The intake sheet and the form file

Both carry one deliberate exposure: a password exists outside the vault until the agent
moves it — in a Google Sheet, or in the form file the user filled in on their phone.

- Create a sheet with `extensions/vault-intake/vault-sheet-init.sh`, which leaves the default **private** sharing as
  is. Never turn it into a public or link-shared document. Without a connected Google account
  there is no sheet: `extensions/vault-intake/vault-form.sh` writes the same three columns to
  `$PICKLE_ULTRA_HOME/inbox.tsv` (mode 0600) instead.
- `extensions/vault-intake/intake.sh` clears column B:C of each sheet row it stored, or rewrites the file row with
  the site only, and reads it back to check. When the file source was used and every row
  succeeded, the file and its same-named copies under `attachments/` are zeroed and deleted.
  If it prints `cleared=no` or `keep file=… reason=pending`, the value is still there: shred the
  source first, tell the user, and treat the password as exposed in a document you control.
- The sheet never receives a value from this harness — only the user types into column C. The
  same goes for the file: only the user fills the password column, and the filled file comes
  back as a chat attachment, never as text in the conversation.

## Reporting

Open a private GitHub security advisory for the repository, or contact the maintainer
directly. Please do not file a public issue for a credential-handling defect. Include the
version (`git log -1 --format=%h`), the command, and what you observed — never a real
password, key, or session cookie.

## Supported versions

The latest commit on the default branch. This is a small harness; fixes land there.

## 운영상 주의 (한국어)

- `agent-vault/keys`·`entries`와 `config.env`, `.state/profile`, `inbox.tsv`은 **보관 금지** 대상입니다.
  드라이브 업로드·슬랙 보고·채팅 붙여넣기에서 제외하세요.
- 사용자에게는 **채팅으로 비밀번호를 받지 않습니다.** 시트(또는 보내 드린 파일)가 유일한 통로이고,
  옮긴 뒤 셀을 지우거나 파일을 파쇄하는 것까지가 한 동작입니다.
- 시트 공유 설정은 비공개 기본값 그대로 둡니다. 링크 공유로 바꾸지 않습니다.
