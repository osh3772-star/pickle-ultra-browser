#!/usr/bin/env node
// login-server.mjs — throwaway login fixture for tests/test-vault-login.sh.
//
//   node tests/login-server.mjs [--port 0] [--port-file PATH]
//                               [--user alice] [--pw SECRET] [--captcha 1234]
//
// Routes (all on 127.0.0.1; also reachable as localhost, which lets one test
// submit to a *different hostname* and check the post-redirect origin guard):
//
//   GET  /login          login form (text + password + submit)
//   POST /login          right credentials -> 303 /home, else 303 /login?error=1
//   GET  /home           signed-in page, no password field
//   GET  /login-parked   login form -> /home-parked on success
//   GET  /home-parked    signed-in dashboard that also carries an off-canvas
//                        and an opacity:0 login panel (stray password fields)
//   GET  /login-slow     login form; a correct POST waits ~7s before /home-slow
//   GET  /home-slow      signed-in page reached after a slow POST
//   GET  /captcha        login form that posts to /captcha/step1
//   POST /captcha/step1  right credentials -> page with #captcha and 보안문자
//   POST /captcha/step2  answer == --captcha -> 303 /home, else the captcha page
//   GET  /escape         login form that posts to http://localhost:PORT/landed
//   POST /landed         another host: a page with no password field
//   GET  /journal        JSON of what was posted (path/method/host, hasPw) — no values
//   GET  /reset          clears the journal
//
// Credentials are fixed strings for the fixture. Nothing here is a real
// account and the values are chosen by the test script.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT_FILE = opt('--port-file', '');
const USER = opt('--user', 'alice');
const PW = opt('--pw', 'pw-fixture-1');
const CAPTCHA = opt('--captcha', '1234');

const journal = [];

const page = (title, body, extraHead = '') => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head>
<body>${body}</body></html>`;

const loginForm = (action, err = '') => page('로그인', `
<h1>로그인</h1>
${err ? '<p>아이디 또는 비밀번호가 맞지 않습니다.</p>' : ''}
<p>아이디와 비밀번호를 입력하세요.</p>
<form method="post" action="${action}">
  <label>아이디 <input type="text" name="id" autocomplete="username"></label>
  <label>비밀번호 <input type="password" name="pw" autocomplete="current-password"></label>
  <button type="submit">로그인</button>
</form>`);

const captchaForm = (action) => page('추가 확인', `
<h1>추가 확인</h1>
<p>이미지에 보이는 보안문자를 입력하세요.</p>
<form method="post" action="${action}">
  <label>보안문자 <input type="text" id="captcha" name="captcha"></label>
  <button type="submit">확인</button>
</form>`, '<meta name="robots" content="noindex">');

const homePage = page('홈', `
<h1>로그인되었습니다</h1>
<p>이 페이지는 로그인한 사용자만 볼 수 있는 안내 화면입니다. 비밀번호 입력란은 없습니다.</p>
<ul><li>내 정보</li><li>주문 내역</li><li>로그아웃</li></ul>`);

// A signed-in dashboard of the kind that produced the false login_failed: the
// theme keeps a quick-login drawer parked off-canvas and a faded login layer,
// so input[type=password] exists with a real box but nobody can see it.
const parkedHomePage = page('홈', `
<header><h1>내 강의실</h1><a href="/logout">로그아웃</a></header>
<div class="quick-login" style="position:absolute;left:-9999px;top:0;width:320px">
  <form method="post" action="/login"><input type="text" name="id"><input type="password" name="pw"><button type="submit">로그인</button></form>
</div>
<div class="login-layer" style="opacity:0;position:absolute;top:0;left:0;width:300px">
  <form method="post" action="/login"><input type="password" name="pw"><button type="submit">로그인</button></form>
</div>
<ul><li>수강 중인 강좌 7개</li><li>예정된 할일</li></ul>`);

const slowHomePage = page('홈', `
<h1>로그인되었습니다</h1><p>느린 로그인 응답 후 도착한 화면입니다. 비밀번호 입력란은 없습니다.</p><a href="/logout">로그아웃</a>`);

const foreignPage = page('다른 호스트', `
<h1>다른 호스트의 화면</h1>
<p>이 페이지는 로그인 대상과 다른 호스트에서 제공되었습니다. 여기에는 비밀번호 입력란이 없습니다.</p>`);

function form(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function redirect(res, to) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store' });
  res.end();
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(b)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;
  const host = req.headers.host || '';

  if (path === '/journal') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ requests: journal }));
    return;
  }
  if (path === '/reset') {
    journal.length = 0;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('reset');
    return;
  }
  if (req.method === 'POST') {
    const f = await readBody(req);
    journal.push({ method: 'POST', path, host, hasId: f.has('id'), hasPw: f.has('pw'), hasCaptcha: f.has('captcha') });
    const okCreds = f.get('id') === USER && f.get('pw') === PW;
    if (path === '/login') return okCreds ? redirect(res, '/home') : redirect(res, '/login?error=1');
    if (path === '/login-parked') return okCreds ? redirect(res, '/home-parked') : redirect(res, '/login?error=1');
    if (path === '/login-slow') {
      // A slow authentication round-trip: the old fixed 4.5s wait judged the
      // still-visible login form and called a successful login a failure.
      if (okCreds) { await new Promise((r) => setTimeout(r, 7000)); return redirect(res, '/home-slow'); }
      return redirect(res, '/login?error=1');
    }
    if (path === '/captcha/step1') return okCreds ? form(res, captchaForm('/captcha/step2')) : redirect(res, '/login?error=1');
    if (path === '/captcha/step2') {
      return f.get('captcha') === CAPTCHA ? redirect(res, '/home') : form(res, captchaForm('/captcha/step2'));
    }
    if (path === '/landed') return form(res, foreignPage);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (path === '/login') return form(res, loginForm('/login', url.searchParams.get('error') ? '1' : ''));
  if (path === '/home') return form(res, homePage);
  if (path === '/login-parked') return form(res, loginForm('/login-parked'));
  if (path === '/home-parked') return form(res, parkedHomePage);
  if (path === '/login-slow') return form(res, loginForm('/login-slow'));
  if (path === '/home-slow') return form(res, slowHomePage);
  if (path === '/captcha') return form(res, loginForm('/captcha/step1'));
  if (path === '/escape') return form(res, loginForm(`http://localhost:${server.address().port}/landed`));
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  const p = server.address().port;
  if (PORT_FILE) writeFileSync(PORT_FILE, String(p));
  console.log('pu-login-server listening on 127.0.0.1:' + p);
});
const bye = () => {
  try { server.closeAllConnections?.(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
