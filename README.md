# Pickle Ultra Browser · 피클 울트라 브라우저

A small headless browser harness for AI agents: a real Chromium driven over raw CDP,
one machine-readable verdict line per page, and a three-lane chain that decides
by itself whether a page is readable, blocked, or a login wall.

**Installing? Read [INSTALL.md](INSTALL.md) first — it is written for the agent, not for a human.**
After installing, the agent must read [NOTICE-TO-USER.md](NOTICE-TO-USER.md) and explain it
to its user right away.

- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md)

---

## What this is

- A **read / collect / light-interact** browser for a Linux or macOS sandbox where an
  agent has a shell: `read`, `open`, `click`, `type`, `scroll`, `shot`, `extract`, batch runs.
- **Raw CDP** over a Unix socket, no npm dependencies, no Playwright at runtime
  (Node ≥ 22 built-ins only). The daemon pushes events immediately instead of polling.
- **One line of truth per page.** Every command ends with a verdict line:

  ```
  %%CHAIN%% lane=L1 mode=read status=ok code=- elapsed_s=6.1 chars=912 next=none
  %%CHAIN%% lane=L1 status=fail code=F-BOT chars=128 elapsed_s=7.9 next=builtin-browser
  %%CHAIN%% lane=L0 status=skip code=F-AUTH chars=22 elapsed_s=0.3 next=builtin-browser-vault
  ```

  `next=` is the whole contract: `none` (use the result), `builtin-browser`
  (blocked or empty — hand the URL to the host agent's own browser),
  `builtin-browser-vault` (login or checkout, and the vault has **no** credential
  for that host — the host agent's browser plus its secret-filling tool), or
  `ultra-vault` (login wall, but `agent-vault` already holds a credential for that
  host — the calling agent continues **in this harness**: log in with
  `agent-vault/vault.py use` through an L1 `-f` script instead of switching
  browsers). Exit codes: `0` ok, `3` browser hand-over, `4` vault hand-over,
  `5` ultra-vault hand-over, `1` failed.

  `next=` is a *signal to the calling agent*, never an automatic switch: nothing
  in this tree can call the host agent's browser tools, and it does not try.
- **Three lanes** (`bin/chain.sh`): L0 is curl + stdlib HTML→text (about a second, no
  browser). L1 is the raw-CDP read. There is deliberately no L2: when L1 is blocked the
  harness reports it and stops.
- **One verdict engine** (`bin/detect-page.py`) for both lanes. It scores independent
  evidence — HTTP status, `<title>`, challenge/block markers, page structure, and (in L1)
  the real DOM — instead of grepping the body. A long document that *discusses* "Access
  denied" stays readable; a single keyword never confirms a block. A password field is
  found by parsing attributes (any quoting, any case) at L0 and by reading the DOM at L1,
  so a field created after load is caught too, and one hidden inside a modal or
  `<template>` does not turn a public page into a login wall.
- **Warm-tab reuse**: `read`/`open`/actions reuse one tab per purpose instead of opening a
  new one per call. That is what keeps a long-lived daemon inside a small container's
  thread budget (measured: 12 reads in a row stay flat instead of adding ~12 threads each).
- **Encrypted credential vault** (`agent-vault/`): values are stored Fernet-encrypted and never
  printed. **Automatic intake** — the user fills a private Google Sheet, or a form file sent
  back in chat — is an optional plugin under `extensions/vault-intake/`; see
  [its README](extensions/vault-intake/README.md). A harness without the plugin still works,
  the vault is just filled by hand.

## What this is not

- **Not a login, payment, or hand-over browser.** Passwords, TOTP codes, card numbers and
  anything that needs the human (2FA, security keyboards, CAPTCHA) belong to the host
  agent's own browser and its `browser_fill_secret`-style tool. This harness refuses to
  fill a password field at all (`type` on `input[type=password]` ends in
  `code=F-AUTH next=builtin-browser-vault`).
- **Not a WAF bypass.** The exit IP is a datacenter address, so a Cloudflare Managed
  Challenge usually cannot be passed. That is reported as `F-BOT`/`F-IP`, not worked around.
- **Not a downloader / PDF printer / element-screenshot tool.** The daemon sees download
  and popup events, but delivering files and printing are the host agent's job.
- **Not a replacement for a headful user browser.** It never touches the user's own Chrome
  profile; its profile lives in `<tree>/.state/profile`.

## Quick start

```bash
# environment check (exit 0 = ready)
bash bin/doctor.sh

# read one page
bin/run.sh read https://example.com

# structure + refs, then click by ref
bin/run.sh open https://example.com
bin/run.sh click https://example.com e3

# cheapest lane first, verdict line last
bin/chain.sh read https://example.com

# offline self-test of all three lanes (local fixtures, no internet)
bin/selftest.sh

# collect a list of URLs
bin/run.sh batch-urls urls.txt
```

### Prebuilt bundles (`dist/`)

`node bin/build-dist.mjs` (esbuild taken from `PU_ESBUILD_DIR`, never installed inside this tree) writes
`dist/vault-intake.mjs` — one file, `node dist/vault-intake.mjs sheet|form|intake|selftest …` — plus the
per-tool bundles (`vault-sheet`, `vault-form`, `intake-all`) and the `cdp-daemon`/`cdp-client` pair.
The intake bundles still use this tree's `agent-vault/vault.py`, `gog` and `.sh` wrappers; the daemon finds
`bin/chrome-wrapper.sh` one level up (or `$CHROME_PATH`) and keeps its profile under the state dir.

### Verdict codes

| code | meaning | `next=` |
|---|---|---|
| `-` | success | `none` |
| `F-BOT` | human-check page (Managed Challenge, Turnstile, "Just a moment") | `builtin-browser` |
| `F-IP` | IP/region block (403, 429, "Access denied", error 1020) | `builtin-browser` |
| `F-EMPTY` | body under 100 characters | `builtin-browser` |
| `F-AUTH` | login wall / password field / checkout entry point | `builtin-browser-vault`, or `ultra-vault` (exit 5) when the vault holds a credential for the host |
| `F-TIMEOUT`, `F-NET` | the page never answered | `none` (retry or hand over) |
| `F-SELECTOR` | the ref or CSS selector matched nothing | `none` |
| `F-DETECT` | the verdict engine failed (crash, empty or invalid JSON, unknown code) | `none` (report it; the page was not judged) |

## Credential vault

`agent-vault/vault.py` keeps values **Fernet-encrypted** at rest
(`agent-vault/entries/<name>.enc`, mode 0600; key `agent-vault/keys/vault.key`, 0600).
A value enters only through **stdin or a file the user placed**, never as a command-line
argument, and `store --from-file` shreds that file as part of the same command. `use`
decrypts in memory and hands the value to a child command through its environment
(`AGENT_VAULT_VALUE` by default) or stdin. **No command prints a value**; `list` shows names,
purposes and dates only. Rotation is `store <name> --purpose … --force`; removal is
`delete <name>` (shreds the file).

## Automatic credential intake (plugin)

Getting a password from the user into that vault without a chat message is a separate, optional
piece: [`extensions/vault-intake/`](extensions/vault-intake/README.md).

```
vault logins ──► sheet created, usernames pre-filled ──► user types only the password
      (no Google account: a form file, filled on the user's phone and sent back)
                                                              │
        vault <── values stored, cells/file cleared or shredded ◄┘
```

- **Requirements:** Google path — a connected Google account with Sheets access (`gog`), nothing
  else. File path — none; a phone that can open `.tsv`, `.csv` or `.xlsx`.
- **Fallback:** sheet first; if Google is unavailable, refused, rate-limited past one retry, or the
  user declines, the table travels as a file once (TSV → CSV → XLSX, one attempt each).
- **Boundary:** values move through stdin/pipe only, are never printed, and the source is cleared
  (sheet cells) or zeroed and deleted (file, attachment copies) right after intake.
- **One command proves it:** `bash extensions/vault-intake/selftest-intake.sh` builds throwaway
  sheets for two different fake profiles, round-trips them, and trashes everything.

The plugin reads three keys from `~/.config/pickle-ultra/config.json` (mode 0600,
overridable with `PU_CONFIG_DIR`):

| key | meaning | default |
|---|---|---|
| `sheet_id` | the sheet the plugin created (plus `sheet_url`) | empty → the file path is used |
| `sheet_tab`, `sheet_range` | where rows are read and cleared | `in`, `in!A2:C200` |
| `agent_name` | appears in the sheet title `<agent> 인입 (자동 파쇄)` | `Pickle Ultra` |

## Layout

```
bin/          run.sh chain.sh fetch.sh detect-page.py detect-code.sh doctor.sh selftest.sh
              cdp-daemon.mjs cdp-client.mjs snaptrim.py html2text.py routecache.py
              vault-match.py batch.sh chrome-wrapper.sh pu-config.sh pu-config.mjs idle-stop.sh
tests/        HTTP fixture server, fixture pages and the suites (run-tests.sh runs them all)
agent-vault/  vault.py (encrypted store; keys/ and entries/ are gitignored)
extensions/   vault-intake/  optional: automatic intake (Sheet or file), + selftest-intake.sh
vendor/       fetch_chrome_deps.py (Chromium shared libraries, no root)
config.env.example
pickle-bootstrap.sh   node + chromium + libs + awk, then a smoke test
```

Every environment variable uses the `PICKLE_ULTRA_*` prefix (`PICKLE_ULTRA_CHROME`,
`PICKLE_ULTRA_STATE_DIR`, `PICKLE_ULTRA_PROFILE`, …); the shorter runtime knobs (`PU_*`,
`PU_SETTLE_MS`, `PU_TOOLS`) are documented in the scripts' headers.
Install configuration (sheet id, agent name) lives in
`~/.config/pickle-ultra/config.json`, mode 0600. The local intake file lives at
`$PICKLE_ULTRA_HOME/inbox.tsv` (mode 0600, git-ignored).

## Limits

- Datacenter egress: Cloudflare Managed Challenge and many bot walls cannot be passed.
  Reported honestly as `F-BOT`/`F-IP`.
- **Chromium sandbox**: the flag follows the host. `PU_CHROME_SANDBOX=auto` (default) uses
  the sandbox when user namespaces (or a setuid `chrome_sandbox`, or macOS seatbelt) are
  available, and otherwise launches with `--no-sandbox` **and says so** on stderr and in
  `cdp-daemon.log`. `require` refuses to launch instead; `off` accepts the risk silently.
  In a container without user namespaces the sandbox genuinely cannot start, so the
  fallback is the only way to run at all — but it is never silent.
- `.state/route-cache.json` is a **diagnostic record only** (`bin/routecache.py`): it stores
  what L1 saw, per domain, for debugging. The chain never reads it to skip a lane — a
  challenge is per path/session/edge and skipping would block working pages.
- Settling is time-based (`PU_SETTLE_MS`, default 4000) — there is no condition wait.
- Viewport screenshots only; no element screenshots, no PDF, no hand-over to a human.
- Reads are anonymous. Anything behind a login belongs to the host agent's browser.

## 한국어 요약

**피클 울트라 브라우저**는 AI 에이전트가 자기 샌드박스 안에서 페이지를 **읽고·모으고·가볍게
조작**하는 헤드리스 브라우저 하네스입니다. chromium을 raw CDP로 직접 몰고, 명령마다 판정 한 줄
(`%%CHAIN%% … next=none|builtin-browser|builtin-browser-vault`)을 남겨 에이전트가 다음 수를
스스로 정합니다.

- **하는 일**: `read`/`open`/`click`/`type`/`scroll`/`shot`/`extract`/배치, 3레인(무브라우저 curl →
  raw CDP) 라우팅, 차단(F-BOT/F-IP)·빈 페이지(F-EMPTY)·로그인벽(F-AUTH) 구분.
- **하지 않는 일**: 로그인·결제·비밀번호 입력·사용자 인계·PDF. 그건 상위 에이전트의 브라우저와
  `browser_fill_secret` 몫이고, 이 하네스는 비밀번호 칸을 아예 채우지 않습니다.
- **자격증명**: `agent-vault`에 Fernet 암호문으로만 저장하고, 값은 표준입출력 파이프로만
  흐르며 출력·로그·대화에 남지 않습니다. 삭제는 `delete`, 교체는 `store --force`.
- **인입(선택 플러그인)**: `extensions/vault-intake/`가 비공개 구글 시트(또는 연동이 없으면 파일 왕복)로
  비밀번호만 받아 볼트에 넣고 원본을 지웁니다 — 자세한 것은 플러그인 README.
- **한계**: 데이터센터 IP라 Cloudflare Managed Challenge는 통과하지 못합니다(정상 동작입니다).

설치·검증 절차는 [INSTALL.md](INSTALL.md), 설치 직후 사용자에게 할 고지는
[NOTICE-TO-USER.md](NOTICE-TO-USER.md)에 있습니다.

## Dependencies

Nothing below is bundled in this repository: each piece is fetched or resolved at install time
and remains under its own license.

| component | how it arrives | license |
|---|---|---|
| Node.js 22 LTS | `pickle-bootstrap.sh` downloads the official tarball; skipped when `node` ≥ 22 exists | MIT |
| Chromium / Chrome for Testing | `npx playwright install chromium`, or an existing browser | BSD-3-Clause and others |
| Playwright CLI | used only for the Chromium download | Apache-2.0 |
| Python `cryptography` (Fernet) | must already be installed (`pip install cryptography`) | Apache-2.0 / BSD |
| Debian packages for Chromium's shared libraries | `vendor/fetch_chrome_deps.py` extracts `.deb` files at install time | each package's own license |
| `gog` CLI (Google Sheets/Drive) | provided by the host agent's environment; optional | its own license |

## License

MIT — see [LICENSE](LICENSE).
Not affiliated with Google, Cloudflare, or any site it reads.
