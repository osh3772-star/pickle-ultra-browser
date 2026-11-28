#!/usr/bin/env python3
"""detect-page.py — page verdict engine for Pickle Ultra Browser.

One decision function for every lane, so the CLI and the browser layer cannot
disagree about what a page is:

  L0 (curl, no browser)   --mode l0 --html FILE [--http 200] [--text-chars N]
  L1 (raw CDP, real DOM)  --mode l1 --dom FILE          (JSON facts from the page)
  text only (compat)      --mode text --text-file FILE

stdout: one JSON object, always, e.g.
  {"code":"-","reason":"ok","score":0,"signals":{...}}
  {"code":"F-IP","reason":"status_403","score":5,"signals":{...}}
Exit code: 0 for any verdict (the verdict is data); 2 for a usage/read error.

Why a structural engine instead of grep (2026-11-27):
  the old detect-code.sh fired F-IP on any page whose *text* contained
  "access denied", which turned documentation such as "A guide to fixing
  Access denied errors" into a blocked page, and missed every password field
  whose attribute was not written exactly `type="password"`.
  This engine scores independent signals (HTTP status, <title>, challenge
  markers, block-page markers, keyword density, page shape, and real DOM
  attributes) and refuses to call a page blocked on a single keyword. A long
  document never becomes F-IP/F-BOT because of words inside it — only a
  title, a status code, or page-level markers can do that.

Kinds of evidence, by trust:
  1. HTTP status        authoritative for 403/429/451 (block/limit).
  2. <title>            exact block/challenge titles ("Just a moment...",
                        "Access denied | host").
  3. page markers       cf-error-details/error 1020/ray id, challenge widgets.
  4. page shape         a bare, short page with no links/forms.
  5. words in the body  only ever a *confirming* signal on a short page,
                        never enough alone.
"""

import argparse
import json
import re
import sys
from html.parser import HTMLParser

ENGINE_VERSION = "2.0"


# --------------------------------------------------------------------------
# Text extraction (same skip/block rules as html2text.py, kept local so the
# verdict cannot drift from the text the caller receives).
# --------------------------------------------------------------------------
class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "template"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6",
             "tr", "section", "article", "header", "footer", "nav", "main"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip > 0:
            self.skip -= 1

    def handle_data(self, data):
        if self.skip == 0:
            self.parts.append(data)


def html_to_text(html):
    p = _Text()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())


# --------------------------------------------------------------------------
# HTML facts: title, shape, and every password field with its real attributes.
#
# The parser reads attributes as the parser sees them, so `type="password"`,
# `type = 'password'`, `TYPE=PASSWORD`, `type=password` and
# `<input type=Password>` are the same input. A regex over raw HTML was the
# old bug (DEFECT-003).
# --------------------------------------------------------------------------
PASSWORD_INPUT_NAMES = {"pass", "passwd", "pwd", "password", "user_pass",
                        "userpass", "login_password", "j_password"}


class _Facts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = 0
        self.links = 0
        self.forms = 0
        self.passwords = []
        self.template_depth = 0
        self._form_depth = 0
        self._form_has_password = []
        # Open-element stack with the reason each ancestor hides its subtree.
        # L0 has no CSS engine, but a login form inside <div hidden> or
        # style="display:none" (a modal on an otherwise public page) is still
        # recognisable from the markup, and must not be read as a login wall.
        self._stack = []
        self.blocks = 0      # paragraph-ish elements: page structure, not just length

    # -- helpers
    @staticmethod
    def _hidden_by_attr(attrs):
        for k, v in attrs:
            if k in ("hidden", "aria-hidden") and (v is None or v.lower() != "false"):
                return "attr:" + k
            if k == "style" and v:
                s = v.replace(" ", "").lower()
                if "display:none" in s:
                    return "style:display:none"
                if "visibility:hidden" in s:
                    return "style:visibility:hidden"
                if re.search(r"opacity:0(\.0*)?(;|$)", s):
                    return "style:opacity:0"
        return ""

    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr"}

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title += 1
        if tag == "template":
            self.template_depth += 1
        if tag not in self.VOID:
            self._stack.append((tag, self._hidden_by_attr(attrs)))
        if tag == "a":
            for k, v in attrs:
                if k == "href" and v:
                    self.links += 1
                    break
        if tag in ("p", "h2", "h3", "h4", "li", "article", "section", "td"):
            self.blocks += 1
        if tag == "form":
            self.forms += 1
            self._form_depth += 1
            self._form_has_password.append(False)
        if tag == "input":
            self._input(attrs)
        # <input> is void; forms nest in malformed HTML, so we never rely on
        # the end tag alone. A password input inside *any* open form counts.

    def _input(self, attrs):
        a = {}
        for k, v in attrs:
            a.setdefault(k, "" if v is None else v)
        typ = (a.get("type") or "").strip().lower()
        name = (a.get("name") or a.get("id") or "").strip()
        ac = (a.get("autocomplete") or "").strip().lower()
        is_pw = typ == "password" or ac in ("current-password", "new-password")
        if not is_pw and typ in ("", "text") and name.lower() in PASSWORD_INPUT_NAMES:
            is_pw = True
        if not is_pw:
            return
        hidden = self._hidden_by_attr(attrs)
        for _tag, why in self._stack:
            if why:
                hidden = hidden or ("ancestor:" + why)
                break
        if typ == "hidden":
            hidden = hidden or "type:hidden"
        if self.template_depth:
            hidden = hidden or "template"
        in_form = self._form_depth > 0
        if in_form and self._form_has_password:
            self._form_has_password[-1] = True
        self.passwords.append({
            "visible": not hidden,
            "hidden_by": hidden,
            "in_form": in_form,
            "type": typ,
            "autocomplete": ac,
            "name": name[:40],
            "disabled": "disabled" in a,
        })

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title -= 1
        if tag == "template" and self.template_depth:
            self.template_depth -= 1
        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i][0] == tag:
                del self._stack[i:]
                break
        if tag == "form":
            if self._form_depth:
                self._form_depth -= 1
                if self._form_has_password:
                    self._form_has_password.pop()

    def handle_data(self, data):
        if self._in_title:
            self.title += data


# --------------------------------------------------------------------------
# Signal vocabularies. Titles are matched from the start and may carry a site
# suffix ("Access denied | example.com"); body phrases are never matched for
# their own sake on a long page.
# --------------------------------------------------------------------------
BLOCK_TITLE = re.compile(
    r"^\s*(access denied|attention required|forbidden|request blocked|"
    r"too many requests|error 10\d\d|error 15\d\d|blocked|"
    r"접근이 거부|접속이 차단|접속이 제한|서비스 이용이 제한|비정상적인 접근|"
    r"アクセスが拒否|アクセスが制限|アクセスがブロック|リクエストがブロック)",
    re.I)

CHALLENGE_TITLE = re.compile(
    r"^\s*(just a moment|security check|security verification|checking your browser|"
    r"한 번만 더 확인|잠시만 기다|보안 확인|사람인지 확인|"
    r"少々お待ちください|しばらくお待ちください|セキュリティチェック|ブラウザを確認)",
    re.I)

BLOCK_PHRASES = [
    "attention required", "sorry, you have been blocked", "you have been blocked",
    "access denied", "request blocked", "error 1020", "error 1015", "error 1022",
    "the owner of this website has banned",
    "접속이 일시적으로 제한", "접속이 제한되었습니다", "비정상적인 접근이 감지",
    "접근이 차단되었습니다", "요청이 차단되었습니다",
    "アクセスが制限されています", "アクセスが拒否されました", "リクエストがブロックされました",
]

CHALLENGE_PHRASES = [
    "verify you are human", "verifying you are human", "are you a robot",
    "unusual traffic from your computer", "just a moment",
    "performing security verification", "checking if the site connection is secure",
    "checking your browser", "enable javascript and cookies to continue",
    "checking your browser before accessing", "ddos protection by",
    "보안 확인 수행 중", "사람인지 확인하는 중", "브라우저를 확인하는 중",
    "잠시만 기다려 주세요", "로봇이 아닙니다",
    "しばらくお待ちください", "ブラウザを確認しています", "セキュリティ確認中",
    "ロボットではないことを確認",
]

CHALLENGE_MARKERS = [
    "challenge-platform", "cf_chl_opt", "cf-chl-", "cf-browser-verification",
    "cf-turnstile", "challenges.cloudflare.com", "_cf_chl_",
    "hcaptcha.com", "h-captcha", "g-recaptcha", "recaptcha/api.js",
    "px-captcha", "perimeterx", "datadome", "captcha-delivery",
    "_incapsula_resource", "sgcaptcha",
]

BLOCK_MARKERS = [
    "cf-error-details", "cf-error-code", "error code: 1020", "error code: 1015",
    "cloudflare ray id", "cf-wrapper",
]

LOGIN_PHRASES = [
    "로그인 후 이용", "로그인후 이용", "로그인이 필요", "로그인해 주세요", "로그인해주세요",
    "로그인 후 확인", "비밀번호를 입력", "아이디와 비밀번호", "로그인 후 사용",
    "sign in to continue", "log in to continue", "please log in", "please sign in",
    "you must be logged in", "you must be signed in", "enter your password",
    "카카오 로그인", "네이버 로그인", "간편 로그인",
    "ログインが必要", "ログインしてください", "パスワードを入力",
]

_RAY_ID = re.compile(r"\bray\s+id\b|\bcf-ray\b", re.I)

# Page shape thresholds. A document at or above DOCUMENT_CHARS is treated as
# content: words inside it can never mark it blocked.
DOCUMENT_CHARS = 2000
DOCUMENT_FLOOR = 500   # structure can make a shorter page a document
WALL_MAX_CHARS = 1500        # a login wall is a small page
WALL_PHRASE_MAX_CHARS = 800  # a phrase-only wall ("로그인이 필요합니다") is tiny
BARE_LINKS = 5


def _count_phrases(text_low, phrases):
    hits = [p for p in phrases if p in text_low]
    return hits


def _density(text_low, hits):
    if not text_low:
        return 0.0
    return sum(len(h) for h in hits) / float(len(text_low))


def _title_is(pattern, title):
    return bool(title) and bool(pattern.match(title))


def decide(f):
    """facts -> verdict dict. Pure function: both lanes call this."""
    text = f.get("text") or ""
    text_low = text.lower()
    title = (f.get("title") or "").strip()
    http = f.get("http")
    chars = int(f.get("text_chars") or len(text) or 0)
    links = int(f.get("links") or 0)
    forms = int(f.get("forms") or 0)
    markers = [m.lower() for m in (f.get("html_markers") or [])]
    passwords = f.get("passwords") or []
    visible_pw = [p for p in passwords if p.get("visible")]
    blocks = int(f.get("blocks") or 0)
    # A document is not just "long": a 800-character Korean guide with three
    # headings and a nav is documentation, while a 700-character block page is
    # one paragraph and no links. Structure separates them better than length.
    is_document = chars >= DOCUMENT_CHARS or (chars >= DOCUMENT_FLOOR and (links >= 3 or blocks >= 3))
    short = chars < WALL_MAX_CHARS

    sig = {
        "lane": f.get("lane") or "",
        "http": http,
        "chars": chars,
        "links": links,
        "forms": forms,
        "title": title[:120],
        "document": is_document,
        "visible_passwords": len(visible_pw),
        "password_fields": len(passwords),
        "challenge_markers": [m for m in markers if m in CHALLENGE_MARKERS],
        "block_markers": [m for m in markers if m in BLOCK_MARKERS],
    }

    # ---------------- login wall first: it is the more specific verdict ------
    auth_score, auth_reason = _auth_score(text_low, chars, links, visible_pw, passwords)
    if auth_score >= 3:
        sig["auth_score"] = auth_score
        # A rate limit or an explicit hard block still wins over a wall: the
        # page is not asking for credentials, it is refusing service.
        if http == 429:
            return _verdict("F-IP", "status_429", 6, sig)
        return _verdict("F-AUTH", auth_reason, auth_score, sig)
    sig["auth_score"] = auth_score

    # ---------------- human-check challenges ---------------------------------
    ch_score = 0
    ch_why = []
    title_ch = _title_is(CHALLENGE_TITLE, title)
    ch_markers = [m for m in markers if m in CHALLENGE_MARKERS]
    hits = [] if is_document else _count_phrases(text_low, CHALLENGE_PHRASES)
    if is_document:
        if title_ch:
            ch_score += 1
            ch_why.append("challenge_title_on_document")
    else:
        if title_ch:
            ch_score += 3
            ch_why.append("challenge_title")
        if ch_markers:
            ch_score += 3
            ch_why.append("challenge_marker:" + ch_markers[0])
        if hits:
            if len(hits) >= 2:
                ch_score += 3
                ch_why.append("challenge_phrases_x%d" % len(hits))
            elif short or _density(text_low, hits) >= 0.02:
                ch_score += 2
                ch_why.append("challenge_phrase")
            if title_ch:
                ch_score += 1
        if short and chars < 400 and links <= 1:
            ch_score += 1
            ch_why.append("bare_short_page")
    if not (title_ch or ch_markers):
        if ch_score >= 3:
            ch_score = 2
            ch_why.append("capped_phrases_only")
    if ch_score >= 3:
        sig["challenge_score"] = ch_score
        sig["challenge_why"] = ch_why
        return _verdict("F-BOT", "+".join(ch_why) or "challenge", ch_score, sig)
    sig["challenge_score"] = ch_score

    # ---------------- blocks -------------------------------------------------
    # A long document is never condemned by words inside it. Only a status
    # code can do that, because real documentation *discusses* block pages
    # ("copy the Ray ID", "error 1020 means a WAF rule refused the request").
    block_score = 0
    block_why = []
    md_hits = [m for m in markers if m in BLOCK_MARKERS]
    title_block = _title_is(BLOCK_TITLE, title)
    # Cloudflare serves its JS challenge with 403 ("Just a moment..."), so a
    # 403 alone must not be read as an IP ban when the page is clearly a
    # human-check page (measured on namu.wiki, 2026-11-27).
    challenge_page = (ch_score >= 3) and not title_block and not md_hits
    if http in (403, 429, 451) and not (http == 403 and challenge_page):
        block_score += 4
        block_why.append("status_%d" % http)
    if is_document:
        # a document's title can echo a block page; that alone proves nothing
        if title_block:
            block_score += 1
            block_why.append("block_title_on_document")
        if http == 503 and (md_hits or _count_phrases(text_low, BLOCK_PHRASES)):
            block_score += 3
            block_why.append("status_503_block_page")
    else:
        if title_block:
            block_score += 3
            block_why.append("block_title")
        if md_hits:
            block_score += 3
            block_why.append("block_marker:" + md_hits[0])
        elif _RAY_ID.search(title) or (short and _RAY_ID.search(text or "")):
            block_score += 2
            block_why.append("ray_id")
        hits = _count_phrases(text_low, BLOCK_PHRASES)
        if hits:
            dens = _density(text_low, hits)
            if len(hits) >= 2 and (short or dens >= 0.01):
                block_score += 3
                block_why.append("block_phrases_x%d" % len(hits))
            elif short and dens >= 0.02:
                block_score += 2
                block_why.append("block_phrase_dense")
            elif title_block:
                block_score += 1
                block_why.append("block_phrase_confirms_title")
        if short and links <= 2 and forms == 0 and chars < 400:
            block_score += 1
            block_why.append("bare_short_page")
    # A single keyword never confirms a block: words and page shape alone are
    # capped below the threshold, and only a status, a block title or a
    # block marker can carry a page over it.
    if not (http in (403, 429, 451) or (http == 503 and not is_document) or title_block or md_hits):
        if block_score >= 3:
            block_score = 2
            block_why.append("capped_phrases_only")
    if block_score >= 3 and not (http == 403 and challenge_page):
        sig["block_score"] = block_score
        sig["block_why"] = block_why
        return _verdict("F-IP", "+".join(block_why) or "block", block_score, sig)
    sig["block_score"] = block_score

    # ---------------- readable ----------------------------------------------
    if chars <= 0:
        return _verdict("F-EMPTY", "no_body_text", 0, sig)
    return _verdict("-", "ok", 0, sig)


def _auth_score(text_low, chars, links, visible_pw, all_pw):
    """0..5. 3 means a login wall."""
    login_hits = _count_phrases(text_low, LOGIN_PHRASES)
    if visible_pw:
        if chars < WALL_MAX_CHARS:
            return 5, "visible_password_field_short_page"
        if login_hits and chars < 3000:
            return 4, "visible_password_field+login_text"
        if links < BARE_LINKS and chars < 3000:
            return 3, "visible_password_field_bare_page"
        # A long public page that also carries a login box (portal header,
        # modal form) is still readable: the content is what was asked for.
        return 1, "visible_password_field_on_content_page"
    if login_hits and chars < WALL_PHRASE_MAX_CHARS and links < BARE_LINKS:
        # Only a page whose text is *mostly* the demand is a wall. A notice
        # board that says "글을 쓰려면 로그인이 필요합니다" in one sentence among
        # several paragraphs is a public page (measured fixture).
        if _density(text_low, login_hits) >= 0.03 or chars < 300:
            return 3, "login_text_only_short_page"
    return 0, ""


def _verdict(code, reason, score, signals):
    return {"engine": ENGINE_VERSION, "code": code, "reason": reason,
            "score": score, "signals": signals}


# --------------------------------------------------------------------------
# Fact builders
# --------------------------------------------------------------------------
def facts_from_html(html, http=None, text_chars=None):
    p = _Facts()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    text = html_to_text(html)
    low_html = html.lower()
    markers = sorted({m for m in (CHALLENGE_MARKERS + BLOCK_MARKERS) if m in low_html})
    return {
        "lane": "l0",
        "http": http,
        "title": p.title.strip(),
        "text": text,
        "text_chars": int(text_chars) if text_chars is not None else len(text),
        "links": p.links,
        "forms": p.forms,
        "blocks": p.blocks,
        "passwords": p.passwords,
        "html_markers": markers,
    }


def facts_from_text(text, http=None):
    return {
        "lane": "text",
        "http": http,
        "title": "",
        "text": text,
        "text_chars": len(text),
        "links": 0,
        "forms": 0,
        "blocks": 0,
        "passwords": [],
        "html_markers": [],
    }


def normalize_dom(d):
    """DOM facts from the browser (L1). Shape is fixed by run.sh's probe."""
    out = {
        "lane": "l1",
        "http": d.get("http"),
        "title": d.get("title") or "",
        "text": d.get("text") or "",
        "text_chars": int(d.get("textChars") or d.get("text_chars") or 0),
        "links": int(d.get("links") or 0),
        "forms": int(d.get("forms") or 0),
        "blocks": int(d.get("blocks") or 0),
        "passwords": d.get("passwords") or [],
        "html_markers": [str(m).lower() for m in (d.get("markers") or [])],
        "url": d.get("url") or "",
    }
    # A DOM fact list may carry computed style visibility; keep the contract
    # tolerant of both spellings.
    pw = []
    for p in out["passwords"]:
        pw.append({
            "visible": bool(p.get("visible", True)),
            "hidden_by": p.get("hidden_by") or p.get("hiddenBy") or "",
            "in_form": bool(p.get("inForm", p.get("in_form", False))),
            "type": (p.get("type") or "password")[:20],
            "autocomplete": (p.get("autocomplete") or "")[:40],
            "name": (p.get("name") or "")[:40],
            "disabled": bool(p.get("disabled")),
        })
    out["passwords"] = pw
    return out


# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Pickle Ultra page verdict engine")
    ap.add_argument("--mode", choices=["l0", "l1", "text"], required=True)
    ap.add_argument("--html")
    ap.add_argument("--dom")
    ap.add_argument("--text-file")
    ap.add_argument("--http", type=int)
    ap.add_argument("--text-chars", type=int)
    ap.add_argument("--format", choices=["json", "text"], default="json")
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args(argv)
    if a.version:
        print("detect-page %s" % ENGINE_VERSION)
        return 0

    try:
        if a.mode == "l0":
            if not a.html:
                print("detect-page: --mode l0 needs --html FILE", file=sys.stderr)
                return 2
            with open(a.html, "r", encoding="utf-8", errors="replace") as fh:
                facts = facts_from_html(fh.read(), a.http, a.text_chars)
        elif a.mode == "l1":
            if not a.dom:
                print("detect-page: --mode l1 needs --dom FILE", file=sys.stderr)
                return 2
            with open(a.dom, "r", encoding="utf-8", errors="replace") as fh:
                facts = normalize_dom(json.load(fh))
        else:
            src = a.text_file
            if not src:
                print("detect-page: --mode text needs --text-file FILE", file=sys.stderr)
                return 2
            with open(src, "r", encoding="utf-8", errors="replace") as fh:
                facts = facts_from_text(fh.read(), a.http)
    except OSError as e:
        print("detect-page: %s" % e, file=sys.stderr)
        return 2
    except Exception as e:
        # Malformed facts JSON or an unreadable structure: the engine did not
        # produce a verdict. Exit non-zero (callers map this to F-DETECT) and
        # keep the message to the exception type — its text may quote page data.
        print("detect-page: invalid input (%s)" % type(e).__name__, file=sys.stderr)
        return 3

    verdict = decide(facts)
    if a.format == "text":
        print(verdict["code"])
    else:
        print(json.dumps(verdict, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
