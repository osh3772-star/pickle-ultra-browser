# Contributing

Small harness, small process. Before opening a pull request:

1. `bash bin/doctor.sh` passes on your machine, and `bash bin/selftest.sh` prints
   `PASS=3 FAIL=0 SKIP=0`.
2. `bash -n` on every `.sh` you touched, `node --check` on every `.mjs`, and
   `python3 -m py_compile` on every `.py` (only `agent-vault/vault.py` and the
   two Chromium helpers are Python now; `extensions/vault-intake/` is Node).
3. No secret, real credential, cookie, account id or personal path in the diff. Grep for
   `/home/`, `/Users/`, `@`, and long random strings before you push.
4. Keep the contract: every command ends with one `%%CHAIN%%` line and `next=` stays one of
   `none`, `builtin-browser`, `builtin-browser-vault`. Adding a lane or an L2 is a design
   change, not a patch.
5. Keep the boundary: no password filling, no CAPTCHA solving, no WAF bypass. A test that
   needs a logged-in session does not belong here.

Bug reports: include the command, the exit code, the last `%%CHAIN%%` line, and
`git log -1 --format=%h`. Never include a password or a full cookie value.

Security issues: see [SECURITY.md](SECURITY.md) — private advisory, not a public issue.
