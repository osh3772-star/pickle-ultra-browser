#!/usr/bin/env python3
"""test-detect.py — unit tests for bin/detect-page.py.

Run: python3 tests/test-detect.py        (exit 0 = all passed)

Covers the three things the old grep detector got wrong (DEFECT-001/003):
  * a normal document that *talks about* blocks stays readable
  * every attribute spelling of a password field is seen, and a login form
    hidden inside a modal/template does not turn a public page into a wall
  * a single keyword never confirms a block
plus the L1 (real DOM) fact path, including a field created after load.
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TREE = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("detect_page", os.path.join(TREE, "bin", "detect-page.py"))
dp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dp)

LONG = ("<p>" + ("This paragraph is ordinary documentation text. " * 20) + "</p>")


def page(title="", body="", links=0, forms=0):
    nav = "".join('<a href="/p%d">p</a>' % i for i in range(links))
    return ("<!doctype html><html><head><meta charset='utf-8'><title>%s</title></head>"
            "<body><nav>%s</nav><main>%s</main></body></html>" % (title, nav, body))


def verdict(html, http=200):
    return dp.decide(dp.facts_from_html(html, http))


class BlockDetection(unittest.TestCase):
    def test_normal_page(self):
        v = verdict(page("Inventory", LONG * 2))
        self.assertEqual(v["code"], "-")

    def test_status_403(self):
        self.assertEqual(verdict(page("Forbidden", "<p>no</p>"), 403)["code"], "F-IP")

    def test_status_429(self):
        self.assertEqual(verdict(page("Slow down", "<p>no</p>"), 429)["code"], "F-IP")

    def test_status_451(self):
        self.assertEqual(verdict(page("Unavailable", "<p>no</p>"), 451)["code"], "F-IP")

    def test_doc_about_access_denied_is_readable(self):
        html = page("A guide to fixing Access denied errors",
                    "<h1>Access denied</h1>" + LONG + LONG +
                    "<p>Copy that Ray ID into the support form; error 1020 means a WAF rule refused it.</p>")
        v = verdict(html, 200)
        self.assertEqual(v["code"], "-", v["signals"])

    def test_short_doc_with_structure_is_readable(self):
        # 700-800 characters of Korean documentation with headings and a nav
        body = ("<h1>접속 차단 오류를 해결하는 방법</h1><h2>1. 계정 권한</h2>"
                "<p>관리자 콘솔에서 접속이 제한되었습니다 또는 비정상적인 접근이 감지되었습니다 "
                "화면이 나오면 권한을 먼저 확인합니다. 조회 권한만 있으면 결제 화면에서 차단됩니다.</p>"
                "<h2>2. 세션</h2><p>여덟 시간 이상 사용하지 않은 세션은 종료되고 안내가 표시됩니다.</p>"
                "<h2>3. 허용 목록</h2><p>사무실 대역 밖에서 보낸 요청은 차단되며 Ray ID가 남습니다.</p>")
        v = verdict(page("접속 차단 오류를 해결하는 방법", body, links=3), 200)
        self.assertEqual(v["code"], "-", v["signals"])

    def test_single_keyword_never_blocks(self):
        v = verdict(page("Release notes", "<p>Fixed: access denied no longer appears after logout.</p>"), 200)
        self.assertEqual(v["code"], "-", v["signals"])

    def test_single_keyword_on_bare_page_never_blocks(self):
        v = verdict(page("Notice", "<p>access denied</p>"), 200)
        self.assertEqual(v["code"], "-", v["signals"])

    def test_block_page_200_with_title_and_ray_id(self):
        html = page("Access denied | example.test used Cloudflare to restrict access",
                    "<h1>Access denied</h1><p>Error code: 1020</p><p>Ray ID: 8d1f2c3a4b5e6f70</p>")
        self.assertEqual(verdict(html, 200)["code"], "F-IP")

    def test_block_page_korean(self):
        html = page("접속이 제한되었습니다", "<h1>접속이 일시적으로 제한되었습니다</h1>"
                                           "<p>비정상적인 접근이 감지되어 접근이 차단되었습니다.</p>")
        self.assertEqual(verdict(html, 200)["code"], "F-IP")

    def test_challenge_page(self):
        html = page("Just a moment...", "<h1>Verifying you are human.</h1>"
                                        "<div id='challenge-platform'></div>")
        self.assertEqual(verdict(html, 200)["code"], "F-BOT")

    def test_challenge_japanese(self):
        html = page("しばらくお待ちください…", "<p>ブラウザを確認しています。セキュリティ確認中です。</p>"
                                              "<div id='challenge-platform'></div>")
        self.assertEqual(verdict(html, 200)["code"], "F-BOT")

    def test_challenge_served_as_403_is_a_challenge(self):
        # Cloudflare answers its JS challenge with 403 and "Just a moment..."
        html = page("Just a moment...", "<h1>Verifying you are human.</h1>"
                                        "<div id='challenge-platform'></div>")
        self.assertEqual(verdict(html, 403)["code"], "F-BOT")

    def test_block_page_403_stays_an_ip_block(self):
        html = page("Access denied | example.test", "<h1>Access denied</h1>"
                                                     "<p>Error code: 1020</p><p>Ray ID: 1a2b</p>")
        self.assertEqual(verdict(html, 403)["code"], "F-IP")

    def test_empty(self):
        self.assertEqual(verdict(page("Shell", ""), 200)["code"], "F-EMPTY")


class PasswordDetection(unittest.TestCase):
    def wall(self, inputs, title="Sign in", extra=""):
        body = "<h1>로그인이 필요합니다</h1><form>%s</form>" % inputs
        return verdict(page(title, body + extra), 200)

    def test_every_attribute_spelling(self):
        for tag in ('<input type="password">', "<input type = 'password'>",
                    '<input TYPE="PASSWORD">', '<input type=password>',
                    '<input type = "Password">', "<input type=PASSWORD>"):
            v = self.wall(tag)
            self.assertEqual(v["code"], "F-AUTH", tag + " -> " + json.dumps(v["signals"]))
            self.assertEqual(v["signals"]["visible_passwords"], 1, tag)

    def test_autocomplete_current_password(self):
        self.assertEqual(self.wall('<input name="pw" autocomplete="current-password">')["code"], "F-AUTH")

    def test_password_name_without_type(self):
        self.assertEqual(self.wall('<input name="password">')["code"], "F-AUTH")

    def test_hidden_input_is_not_a_wall(self):
        # a public page whose (hidden) sign-in form carries a password input
        body = LONG * 3 + '<div hidden><input type="password" name="pw"></div>'
        self.assertEqual(verdict(page("Community", body, links=6), 200)["code"], "-")

    def test_password_inside_hidden_modal_is_not_a_wall(self):
        body = LONG * 3 + '<div id="signin" hidden style="display:none"><input type="password"></div>'
        self.assertEqual(verdict(page("Community", body, links=6), 200)["code"], "-")

    def test_password_inside_template_is_not_a_wall(self):
        body = LONG * 3 + '<template><input type="password"></template>'
        self.assertEqual(verdict(page("Docs", body, links=6), 200)["code"], "-")

    def test_login_link_on_public_page(self):
        body = ("<h1>공지사항</h1>" + LONG +
                "<p>이 게시판은 로그인 없이 읽을 수 있습니다. 글을 쓰려면 로그인이 필요합니다.</p>")
        self.assertEqual(verdict(page("공지사항", body, links=4), 200)["code"], "-")

    def test_japanese_login_wall(self):
        v = self.wall('<input name="id"><input type="PASSWORD" name="pw">', title="ログイン")
        self.assertEqual(v["code"], "F-AUTH")

    def test_dom_mode_dynamic_field(self):
        facts = dp.normalize_dom({
            "title": "로그인", "textChars": 40, "links": 0, "forms": 1, "blocks": 2,
            "text": "로그인이 필요합니다. 아이디와 비밀번호를 입력해 주세요.",
            "passwords": [{"visible": True, "inForm": True, "type": "password",
                           "autocomplete": "current-password", "name": "pw"}],
            "markers": [],
        })
        self.assertEqual(dp.decide(facts)["code"], "F-AUTH")

    def test_dom_mode_hidden_field_ignored(self):
        facts = dp.normalize_dom({
            "title": "Community", "textChars": 2200, "links": 6, "forms": 1, "blocks": 8,
            "text": "public content " * 100,
            "passwords": [{"visible": False, "inForm": True, "type": "password"}],
            "markers": [],
        })
        self.assertEqual(dp.decide(facts)["code"], "-")

    def test_dom_mode_no_values_recorded(self):
        facts = dp.normalize_dom({"title": "x", "textChars": 0, "passwords": [
            {"visible": True, "inForm": True, "type": "password", "name": "pw",
             "value": "should-not-survive"}]})
        self.assertNotIn("value", json.dumps(facts))


class Cli(unittest.TestCase):
    def test_l0_cli_emits_json(self):
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
            f.write(page("Access denied | x", "<h1>Access denied</h1><p>Error code: 1020</p>"))
            path = f.name
        try:
            import subprocess
            r = subprocess.run([sys.executable, os.path.join(TREE, "bin", "detect-page.py"),
                                "--mode", "l0", "--html", path, "--http", "200"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(json.loads(r.stdout)["code"], "F-IP")
        finally:
            os.unlink(path)

    def test_missing_file_is_usage_error(self):
        import subprocess
        r = subprocess.run([sys.executable, os.path.join(TREE, "bin", "detect-page.py"),
                            "--mode", "l0", "--html", "/nonexistent/x.html"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
