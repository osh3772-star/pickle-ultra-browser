# NOTICE-TO-USER — say this right after installing

**에이전트: 설치를 마쳤으면 이 문서를 읽고, 아래 내용을 자기 말투로 바꿔 사용자에게 지금 바로 설명한다.**
**Agent: when the install is done, read this file and explain it to your user immediately, in
your own voice. Every item in the checklist must survive the rewording.**

This is the one moment the user learns what was put on their behalf, so do not compress it
into "설치 완료됐어요". Say it in one message, in their language, without jargon, and point
at the sheet link you created.

Related documents: [INSTALL.md](INSTALL.md) (the procedure you just ran) ·
[SECURITY.md](SECURITY.md) (the boundary you are describing) · [README.md](README.md).

---

## 말할 내용 (한국어)

> **1) 무엇이 설치됐는지**
> `<에이전트 이름>`의 샌드박스에 **피클 울트라 브라우저**를 설치했어요. 페이지를 읽고, 목록을
> 모으고, 클릭·입력 같은 가벼운 조작을 하는 브라우저 하네스입니다. 화면 없이(headless) 크로미움을
> 직접 몰고, 페이지마다 판정 한 줄로 "정상 / 차단 / 로그인 필요"를 구분합니다.
>
> **2) 비밀번호 금고(볼트)가 어떻게 동작하는지**
> - 자격증명은 `agent-vault`에 **암호화해서만** 저장합니다. 암호문 파일은 `agent-vault/entries/`
>   (권한 0600), 복호화 열쇠는 `agent-vault/keys/vault.key`(0600)에 따로 있습니다.
> - 값은 **표준입출력이나 직접 주신 파일로만** 들어갑니다. 명령줄 인자로는 절대 받지 않고,
>   파일로 주시면 저장과 동시에 그 파일을 덮어써서 지웁니다.
> - 꺼내 쓸 때는 메모리에서만 복호화해서, 다른 프로그램에 환경변수나 표준입력으로 넘깁니다.
> - **어떤 명령도 값을 출력하지 않습니다.** 목록 명령은 이름·용도·저장 날짜만 보여줍니다.
>   그래서 저도 그 값을 읽어서 보여드릴 수 없고, 보여줄 필요도 없습니다.
> - 지우는 법은 `vault.py delete <이름>`(파일을 덮어쓰고 삭제), 바꾸는 법은
>   `vault.py store <이름> --purpose '...' --force`입니다.
>
> **3) 로그인 정보를 받는 방법 — 아래 둘 중 실제로 쓴 것 하나만 말한다**
> *판단 기준: 구글 연동이 있어 시트를 만들었으면 (A), 연동이 없어 파일로 보냈으면 (B). 둘 다 말하지 않는다.*
>
> **(A) 시트로 받는 경우**
> 로그인 정보를 넣을 **비공개 시트**를 하나 만들었습니다: <시트 링크>
> - A열은 사이트, **B열은 아이디가 이미 들어가 있습니다.**
> - **C열 비밀번호 칸만** 채워 주세요. C열은 연한 노란색으로 표시해 뒀습니다.
> - 채워 주시면 제가 볼트로 옮기고 그 칸(B·C)을 바로 지웁니다. 사이트 이름(A열)은 남겨 둡니다.
> - **비밀번호는 채팅에 붙여넣지 마세요.** 채팅 기록은 지워지지 않고 암호화도 되지 않습니다.
>   시트에만 넣으시면 됩니다. 이미 채팅에 붙여넣으셨다면 그 비밀번호는 바꿔 주세요.
> - 카카오·네이버 같은 간편로그인 사이트는 시트 오른쪽 위에 따로 적어 뒀습니다. 그런 사이트는
>   비밀번호가 필요 없습니다.
>
> **(B) 연동이 없어 파일로 받는 경우**
> 구글 연동이 없어서 시트 대신 **파일로 보내 드립니다**: <파일 이름>
> - 아이디는 제가 미리 채워 뒀습니다. **비밀번호 칸만** 채워 주세요.
> - 핸드폰에서 그 파일을 열어 채우신 뒤, **채팅에 파일을 다시 첨부해서 보내 주세요.**
> - 보내주시면 볼트에 넣고, **그 파일과 값은 바로 파쇄해서 지웁니다.** 사이트 이름과 아이디만 남습니다.
> - **채팅 본문에 비밀번호를 직접 쓰지는 마세요.** 파일로만 주고받습니다.
>   이미 본문에 쓰셨다면 그 비밀번호는 바꿔 주세요.
> - 파일이 안 열리면 말씀해 주세요. 다른 형식(CSV, 필요하면 엑셀)으로 한 번만 다시 보내 드립니다.
>
> **4) 이 하네스가 하는 일과 하지 않는 일**
> - 합니다: 공개 페이지 읽기, 목록 수집, 클릭·입력·스크롤, 스크린샷, 판정 한 줄 보고.
> - 안 합니다: **로그인·결제·비밀번호 입력·사용자 인계·PDF 저장**. 그런 일은 제 본래 브라우저와
>   비밀값 채우기 도구가 맡습니다. 이 하네스는 비밀번호 칸을 아예 채우지 않고
>   "로그인 필요"라고 알려주고 멈춥니다.
> - 출구 IP가 데이터센터라서 Cloudflare의 "사람인지 확인" 벽은 통과하지 못합니다. 그건 고장이
>   아니라 한계이고, 그럴 때는 제 본래 브라우저로 넘어갑니다.
>
> **5) 지금 바로 해보실 수 있는 것**
> - (A) 시트의 **비밀번호 칸 하나만** 채워 보시고 "다 채웠어"라고 말해 주세요. 제가 옮겨서
>   `ok site=… cleared=yes`로 알려드립니다.
> - (B) 보내 드린 파일의 **비밀번호 칸 하나만** 채워 파일을 다시 첨부해 주세요. 옮긴 뒤 파일은
>   바로 파쇄하고 `ok site=… cleared=yes`로 알려드립니다.
> - 또는 "이 페이지 읽어줘 <링크>"라고 하시면 바로 읽어서 판정과 함께 보여드립니다.
>
> **6) 기억해 두실 것**
> - 비밀번호는 **채팅 본문이 아니라** 시트(또는 제가 보낸 파일)로. 옮긴 뒤 그 칸이나 파일은 지웁니다.
> - 볼트 목록은 언제든 `python3 agent-vault/vault.py list`로 이름만 확인할 수 있습니다.
> - 지우고 싶으시면 사이트 이름을 말해 주세요. `delete`로 암호문과 열쇠를 지웁니다.

---

## English version (same items, keep every line)

> **What is installed:** Pickle Ultra Browser in my sandbox — a headless Chromium harness that
> reads pages, collects lists, and does light clicking/typing. It reports one verdict line per
> page: fine, blocked, or login required.
>
> **How the vault works:** credentials are stored **encrypted only** — ciphertext in
> `agent-vault/entries/` (0600), the key separately in `agent-vault/keys/vault.key` (0600).
> Values enter only through stdin or a file you hand me (that file is shredded on store), are
> decrypted only in memory, and go to another program through its environment or stdin.
> **No command prints a value** — the list command shows names, purposes and dates only, so I
> cannot show you a stored password, and I do not need to. Rotate with
> `vault.py store <name> --purpose '…' --force`, remove with `vault.py delete <name>`.
>
> **The intake form — one path, whichever this install built**
> *(Google connected: A. No connection: B. Say only the one you used.)*
>
> **(A) Sheet:** a private spreadsheet was created for you: <sheet link>. Column A is the site,
> **column B already holds the username**, and **only column C — the pale yellow one — needs your
> password**. Fill it and I move it into the vault and clear B:C, keeping the site name.
>
> **(B) File:** Google is not connected, so I sent you the **file** below instead of a sheet:
> <file name>. The usernames are already filled in; fill **only the password column**, then attach
> the file back in chat. I move the values into the vault and shred that file (and its copies)
> right away, leaving the site names and usernames only. Please do not type the password into the
> chat itself; if you already did, change it. If the file will not open, tell me and I will resend
> it once as CSV.
>
> **What it does / does not do:** reads, collects, light interactions. It does **not** sign in,
> pay, fill passwords, hand over to a human, or print PDFs — my main browser does those, and
> this harness reports "login required" and stops. A datacenter IP cannot pass Cloudflare
> human checks; that is a known limit, not a fault.
>
> **First actions:** fill one password cell and say so (I will report `ok site=… cleared=yes`),
> or say "read this page <link>".
>
> **Remember:** passwords go in the sheet — or in the file I sent — never in the chat text.

---

## 체크리스트 (빠지면 안 되는 항목)

에이전트가 문장을 바꿔도 아래는 **하나도 빠뜨리지 않는다**:

- [ ] 무엇이 설치됐는지 한 줄
- [ ] 자격증명은 암호화 저장이고 **값이 출력·로그·대화에 남지 않는다**는 경계
- [ ] 값을 넣는 통로는 **시트/파일/파이프만**이고 명령줄·채팅 본문이 아니라는 점
- [ ] **어느 경로인지 한 줄** — (A) 시트 링크, 또는 (B) 파일 이름과 "채워서 다시 첨부해 주세요"
- [ ] **아이디는 미리 채워져 있고, 사용자는 비밀번호 칸만** 채우면 된다는 점
- [ ] 채운 뒤 **값은 지워지고 사이트·아이디만 남는다**는 점 (B는 파일 자체를 파쇄)
- [ ] (B의 경우) 파일이 안 열리면 **한 번만** 다른 형식으로 다시 보낸다는 점
- [ ] (A가 실패해 B로 내려간 경우) **왜 내려갔는지 한 줄** — "구글 연동이 없어서/구글이 막아서 파일로 대신합니다"
- [ ] 삭제·교체 방법(`delete`, `store --force`)
- [ ] 이 하네스가 **하는 일 / 하지 않는 일**(로그인·결제·인계·PDF는 상위 브라우저 몫)
- [ ] 데이터센터 IP의 Cloudflare 한계는 **고장이 아니라 한계**라는 점
- [ ] 사용자가 지금 할 수 있는 첫 행동 1~2개
- [ ] **비밀번호를 채팅에 붙여넣지 말 것** (이미 붙여넣었다면 변경 권고)
- [ ] 시트 링크

## 사실 확인용 표 (질문받았을 때 답할 근거)

| 항목 | 실제 값 |
|---|---|
| 암호문 | `$HOME/pickle-ultra/agent-vault/entries/<이름>.enc` (0600) |
| 열쇠 | `$HOME/pickle-ultra/agent-vault/keys/vault.key` (0600) |
| 메타 | `$HOME/pickle-ultra/agent-vault/meta.json` — 이름·용도·저장시각만 |
| 초기화 | `python3 agent-vault/vault.py init` (기존 열쇠는 건드리지 않음) |
| 저장 | `vault.py store <이름> --purpose '<용도>'` (값은 stdin), `--from-file <경로>`면 원본 파쇄, `--force`로 교체 |
| 사용 | `vault.py use <이름> -- <명령>` — 기본 `AGENT_VAULT_VALUE` 환경변수, `--via stdin` 가능, 값은 출력 안 됨 |
| 목록 | `vault.py list` — 이름·용도·저장시각 |
| 삭제 | `vault.py delete <이름>` — 파일 덮어쓰기 후 삭제 |
| 시트 | 제목 `"<에이전트 이름> 인입 (자동 파쇄)"`, 탭 `in`, 헤더 `사이트/아이디/비밀번호` |
| 시트 반영 | `bash extensions/vault-intake/intake.sh --source sheet` — 채워진 행만, B:C 비움, 429면 20초 후 1회 재시도 |
| 파일 | `bash extensions/vault-intake/vault-form.sh` → `$PICKLE_ULTRA_HOME/inbox.tsv` (0600), 헤더 + 사이트/아이디/빈 비밀번호 |
| 파일 반영 | `bash extensions/vault-intake/intake.sh --source file --file <반환 파일>` — 저장한 줄은 값 비우고, 전부 성공하면 파일·attachments 사본 파쇄·삭제 |
| 폴백 | 시트 실패(미연동·권한·생성 실패·429 지속) → 파일 왕복 1회. 파일도 안 열리면 TSV→CSV→xlsx 1회, 그래도 안 되면 사이트·아이디 목록만 안내 |
| 시트 설정 | `~/.config/pickle-ultra/config.json` (0600) — 시트 ID·에이전트 이름만, 비밀값 없음 |
