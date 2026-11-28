#!/usr/bin/env node
// vault-login.mjs — Read credentials from agent-vault inside the daemon process,
// fill/submit login forms via raw CDP without ever printing secrets, and if a
// CAPTCHA appears, keep the page alive and save a screenshot for user review.
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, lstatSync, chmodSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = dirname(HERE);
const VAULT_PY = process.env.PICKLE_ULTRA_VAULT || join(ROOT, 'agent-vault', 'vault.py');
const DAEMON = join(HERE, 'cdp-daemon.mjs');
const STATE_DIR =
  process.env.PICKLE_ULTRA_STATE_DIR ||
  process.env.MUSE_ULTRA_STATE_DIR ||
  join(ROOT, '.state') ||
  join(homedir(), '.local', 'share', 'pickle-ultra');
const SOCK = join(STATE_DIR, 'cdp-daemon.sock');

// ---------------------------------------------------------------- origin gate
// PUB-302/PUB-201: credentials are only ever typed into the host named by the
// vault entry (`site`), over https. Plain http is accepted for 127.0.0.1 /
// localhost only, so local fixtures work without weakening the rule. The same
// check runs inside the page script before the first fill, after every submit
// and before a `chp=` re-entry, because a redirect can move the page elsewhere.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normSite(s) {
  return String(s || '').toLowerCase().trim().replace(/^\.+/, '').replace(/\.+$/, '');
}

// Returns null when this URL may receive the entry's credentials, else a
// short machine-readable reason.
function checkOrigin(raw, site) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'bad_url'; }
  if (u.username || u.password) return 'credentials_in_url';
  const h = String(u.hostname || '').toLowerCase();
  const local = LOCAL_HOSTS.has(h);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'insecure_scheme';
  const s = normSite(site);
  if (!s) return 'missing_site';
  if (h !== s && !h.endsWith('.' + s)) return 'host_mismatch';
  return null;
}

// URL as it may appear in output or a state file: query and fragment dropped.
// They can carry tokens (?token=…, #access_token=…); decisions always use the
// raw URL.
function sanitizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch { return ''; }
}

const args = process.argv.slice(2);
let url = null, site = null;
let idSel = null, pwSel = null, submitSel = null, captchaSel = null;
let shotPath = null, spaceName = null, captchaAnswer = null;
let waitAnswerFile = null, stateFile = null, waitTimeout = 240;

const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--id-sel') idSel = args[++i];
  else if (a === '--pw-sel') pwSel = args[++i];
  else if (a === '--submit-sel') submitSel = args[++i];
  else if (a === '--captcha-sel') captchaSel = args[++i];
  else if (a === '--shot') shotPath = args[++i];
  else if (a === '--space') spaceName = args[++i];
  else if (a === '--captcha-answer') captchaAnswer = args[++i];
  else if (a === '--wait-answer-file') waitAnswerFile = args[++i];
  else if (a === '--state-file') stateFile = args[++i];
  else if (a === '--wait-timeout') waitTimeout = Math.max(10, Number(args[++i]) || 240);
  else pos.push(a);
}

if (!captchaAnswer) {
  url = pos[0];
  site = pos[1];
  if (!url || !site) {
    console.error('usage: vault-login.mjs <url> <vault-site> [--shot <path>] [--space <name>] [--id-sel <css>] [--pw-sel <css>] [--submit-sel <css>]');
    console.error('   or: vault-login.mjs --captcha-answer <text> --space <name> [--shot <path>] [--captcha-sel <css>] [--submit-sel <css>]');
    process.exit(2);
  }
  const originIssue = checkOrigin(url, site);
  if (originIssue) {
    console.log(JSON.stringify({ ok: false, status: 'origin_mismatch', reason: originIssue,
      site: normSite(site), url: sanitizeUrl(url) }));
    process.exit(2);
  }
  if (!spaceName) spaceName = 'vault-login-' + site.replace(/[^a-z0-9._-]/gi, '-');
  if (!shotPath) shotPath = join('browser', `captcha-${site.replace(/[^a-z0-9._-]/gi, '-')}.png`);
} else {
  if (!spaceName) {
    console.error('error: --space <name> is required with --captcha-answer');
    process.exit(2);
  }
  if (!shotPath) shotPath = join('browser', `captcha-${spaceName}.png`);
}

const absShot = resolve(shotPath);
const absWaitAnswer = waitAnswerFile ? resolve(waitAnswerFile) : null;
const absStateFile = stateFile ? resolve(stateFile) : null;

// PUB-304: a symlink planted at one of these paths would make this process
// read (answer file) or overwrite (state file, screenshot) a file outside the
// intended directory. Refuse before anything is written.
function unsafePath(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isFile()) return 'not_a_file';
  } catch (e) {
    if (e && e.code !== 'ENOENT') return 'unreadable';
  }
  return null;
}
for (const [option, p] of [['--wait-answer-file', absWaitAnswer], ['--state-file', absStateFile], ['--shot', absShot]]) {
  if (!p) continue;
  const bad = unsafePath(p);
  if (bad) {
    console.log(JSON.stringify({ ok: false, status: 'unsafe_path', option, reason: bad, path: p }));
    process.exit(2);
  }
}
mkdirSync(dirname(absShot), { recursive: true, mode: 0o700 });
if (absStateFile) mkdirSync(dirname(absStateFile), { recursive: true, mode: 0o700 });
if (absWaitAnswer) mkdirSync(dirname(absWaitAnswer), { recursive: true, mode: 0o700 });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function tryConnect() {
  return new Promise((res, rej) => {
    const s = connect(SOCK);
    s.once('connect', () => res(s));
    s.once('error', rej);
  });
}

// PUB-205: one starter per state directory. Two clients that both found no
// socket used to spawn two daemons on the same socket path and profile; one
// lost the bind and callers attached to whichever won, sometimes a daemon on
// its way out. mkdirSync is atomic, so the directory is the lock: the winner
// starts the daemon, everyone else waits for the socket, a lock older than 15s
// is stale, and the lock is always removed in finally.
const START_LOCK = join(STATE_DIR, 'daemon.start.lock');
async function ensureDaemon() {
  try { const s = await tryConnect(); s.destroy(); return; } catch {}
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 20000;
  let haveLock = false;
  while (Date.now() < deadline) {
    try { mkdirSync(START_LOCK, { mode: 0o700 }); haveLock = true; break; } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(START_LOCK);
        if (Date.now() - st.mtimeMs > 15000) { rmSync(START_LOCK, { recursive: true, force: true }); continue; }
      } catch {}
      await sleep(250);
      try { const s = await tryConnect(); s.destroy(); return; } catch {}
    }
  }
  if (!haveLock) throw new Error('vault-login: daemon start lock busy (another client is starting it)');
  try {
    try { const s = await tryConnect(); s.destroy(); return; } catch {}
    const logFd = openSync(join(STATE_DIR, 'cdp-daemon.log'), 'a');
    const child = spawn(process.execPath, [DAEMON], {
      detached: true, stdio: ['ignore', logFd, logFd], env: process.env,
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const s = await tryConnect(); s.destroy(); return; } catch {}
    }
    throw new Error('vault-login: cannot connect to cdp-daemon.sock');
  } finally {
    try { rmSync(START_LOCK, { recursive: true, force: true }); } catch {}
  }
}

await ensureDaemon();

const DETECT_FN = `
const detectState = () => {
  const vis = (el) => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const hasPasswordField = [...document.querySelectorAll('input[type="password"]')].some(vis);
  const captchaInput = [...document.querySelectorAll('input#captcha, input[name*="captcha" i], input[id*="captcha" i]')].find(vis);
  const textHead = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
  const hasCaptchaText = /additional security verification|captcha|보안문자|자동입력방지|영수증.*(금액|위치|개수|물음)|receipt was created digitally/i.test(textHead);
  const isCaptcha = !!captchaInput || (!hasPasswordField && hasCaptchaText);
  const isVerify = !hasPasswordField && !isCaptcha && /해외 로그인 차단|본인확인이 필요|인증번호를? 입력|verification code|overseas login/i.test(textHead);
  return { url: location.href, title: document.title, hasPasswordField, isCaptcha, isVerify, textHead };
};
`;

// Injected helpers for the daemon-side script (it cannot see this module's
// scope). keep in sync with checkOrigin/sanitizeUrl above.
const SAFE_FN = `
const sanitizeUrl = (raw) => {
  try {
    const u = new URL(String(raw));
    u.search = ''; u.hash = '';
    return u.toString();
  } catch { return ''; }
};
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const originProblem = (raw, site) => {
  let u;
  try { u = new URL(String(raw)); } catch { return 'bad_url'; }
  if (u.username || u.password) return 'credentials_in_url';
  const h = String(u.hostname || '').toLowerCase();
  const local = LOCAL_HOSTS.has(h);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'insecure_scheme';
  const s = String(site || '').toLowerCase().replace(/^\\.+/, '').replace(/\\.+$/, '');
  if (!s) return 'missing_site';
  if (h !== s && !h.endsWith('.' + s)) return 'host_mismatch';
  return null;
};
const afterProblem = (raw, site) => {
  const r = String(raw || '');
  if (/^chrome-error:\\/\\//.test(r)) return 'chrome_error';
  if (/^about:/.test(r)) return 'blank_page';
  return originProblem(r, site);
};
const pubAfter = (a) => (a && typeof a === 'object') ? Object.assign({}, a, { url: sanitizeUrl(a.url) }) : a;
`;

const code = captchaAnswer
  ? `
const fs = await import('node:fs');
const CFG = ${JSON.stringify({ spaceName, captchaAnswer, captchaSel, submitSel, absShot, shotPath })};
${DETECT_FN}
${SAFE_FN}
const saveShot = (b64) => {
  fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'), { mode: 0o600 });
  try { fs.chmodSync(CFG.absShot, 0o600); } catch {}
};
const space = await claimTaskSpace(CFG.spaceName);
const pages = [...space.pages.values()];
const p = pages[0];
if (!p) {
  console.log(JSON.stringify({ ok: false, status: 'session_expired', space: CFG.spaceName }));
  return;
}
const filled = await p.evaluate((sel) => {
  const vis = (el) => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const el = sel
    ? document.querySelector(sel)
    : ([...document.querySelectorAll('input#captcha, input[name*="captcha" i], input[id*="captcha" i], input[type="text"]')].find(vis) || null);
  if (!el) return false;
  el.value = '';
  el.focus();
  return true;
}, CFG.captchaSel);
if (!filled) {
  const b64 = await p.screenshot();
  saveShot(b64);
  console.log(JSON.stringify({ ok: false, status: 'captcha_input_not_found', space: CFG.spaceName, screenshot: CFG.shotPath }));
  return;
}
await p.cdp('Input.insertText', { text: CFG.captchaAnswer });
await new Promise(r => setTimeout(r, 300));
const clicked = await p.evaluate((sel) => {
  const vis = (el) => {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const btn = sel
    ? document.querySelector(sel)
    : (document.getElementById('log.login') || [...document.querySelectorAll('button[type="submit"], input[type="submit"], button.btn_login, button')].find(b => vis(b) && /confirm|확인|로그인|submit|sign in/i.test((b.innerText || b.value || ''))));
  if (btn) { btn.click(); return true; }
  return false;
}, CFG.submitSel);
if (!clicked) await p.press('Enter').catch(() => {});
await new Promise(r => setTimeout(r, 4500));

const after = await p.evaluate(detectState);
if (after.isCaptcha || after.hasPasswordField) {
  const b64 = await p.screenshot();
  saveShot(b64);
  console.log(JSON.stringify({ ok: false, status: after.isCaptcha ? 'captcha' : 'login_failed', space: CFG.spaceName, screenshot: CFG.shotPath, after: pubAfter(after) }));
  return;
}
await space.finish({ keep: [] }).catch(() => {});
console.log(JSON.stringify({ ok: true, status: 'logged_in', after: pubAfter(after) }));
`
  : `
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
const CFG = ${JSON.stringify({ url, site, vaultPy: VAULT_PY, idSel, pwSel, submitSel, captchaSel, absShot, shotPath, spaceName, absWaitAnswer, absStateFile, waitTimeout })};
${DETECT_FN}
${SAFE_FN}
const saveShot = (b64) => {
  fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'), { mode: 0o600 });
  try { fs.chmodSync(CFG.absShot, 0o600); } catch {}
};
const handleInsecureForm = async (p) => {
  for (let i = 0; i < 2; i++) {
    const clicked = await p.evaluate(() => {
      if (document.title !== 'Form is not secure' && !/The information you.re about to submit is not secure/i.test(document.body?.innerText || '')) return false;
      const btn = document.querySelector('#proceed-button') ||
        [...document.querySelectorAll('button, a')].find(el => /send anyway/i.test(el.innerText || el.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 3500));
  }
};
// PUB-304/PUB-305: 0600, atomic replace, and no query/fragment in URLs.
const writeState = (obj) => {
  if (!CFG.absStateFile) return;
  const safe = Object.assign({}, obj, { updatedAt: Date.now() });
  if (safe.beforeUrl) safe.beforeUrl = sanitizeUrl(safe.beforeUrl);
  if (safe.after) safe.after = pubAfter(safe.after);
  const tmp = CFG.absStateFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(safe), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, CFG.absStateFile);
  try { fs.chmodSync(CFG.absStateFile, 0o600); } catch {}
};
const submitCaptchaOnPage = async (p, ans) => {
  const filled = await p.evaluate((sel) => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const el = sel
      ? document.querySelector(sel)
      : ([...document.querySelectorAll('input#captcha, input[name*="captcha" i], input[id*="captcha" i], input[type="tel"], input[type="email"], input[type="number"], input[type="text"]')].find(vis) || null);
    if (!el) return false;
    el.value = '';
    el.focus();
    return true;
  }, CFG.captchaSel);
  if (!filled) return false;
  await p.cdp('Input.insertText', { text: ans });
  await new Promise(r => setTimeout(r, 300));
  const clicked = await p.evaluate((sel) => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const btn = sel
      ? document.querySelector(sel)
      : (document.getElementById('log.login') || [...document.querySelectorAll('button[type="submit"], input[type="submit"], button.btn_login, button, a[role="button"], a[class*="btn"]')].find(b => vis(b) && /confirm|확인|로그인|submit|sign in|인증/i.test((b.innerText || b.value || ''))));
    if (btn) { btn.click(); return true; }
    return false;
  }, CFG.submitSel);
  if (!clicked) await p.press('Enter').catch(() => {});
  await new Promise(r => setTimeout(r, 4500));
  return true;
};
const space = await taskSpace(CFG.spaceName);
const p = await space.newPage('main');
let keepForCaptcha = false;
try {
  try {
    await p.cdp('Network.enable', {});
    await p.cdp('Network.setExtraHTTPHeaders', {
      headers: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5' },
    });
    await p.cdp('Emulation.setLocaleOverride', { locale: process.env.PICKLE_ULTRA_LANG || 'ko-KR' }).catch(() => {});
  } catch {}
  await p.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // The URL may have redirected away from the site before the form rendered:
  // check where the page actually is before the vault is opened at all.
  const landed = await p.evaluate(() => location.href).catch(() => '');
  const landIssue = afterProblem(landed, CFG.site);
  if (landIssue) {
    console.log(JSON.stringify({ ok: false,
      status: landIssue === 'chrome_error' ? 'login_failed' : 'origin_mismatch',
      reason: landIssue, site: CFG.site, url: sanitizeUrl(landed) }));
    return;
  }

  const raw = execFileSync('python3', [
    CFG.vaultPy, 'use', '--via', 'stdin', CFG.site, '--',
    process.execPath, '-e', 'process.stdin.pipe(process.stdout)'
  ], { encoding: 'utf8' });
  let username = '', password = '';
  const trimmed = raw.replace(/\\r?\\n$/, '');
  if (trimmed.startsWith('{')) {
    let cred = JSON.parse(trimmed);
    username = String(cred.username || '');
    password = String(cred.password || '');
    cred = null;
  } else {
    const tabIdx = trimmed.indexOf('\\t');
    if (tabIdx >= 0) {
      username = trimmed.slice(0, tabIdx);
      password = trimmed.slice(tabIdx + 1);
    }
  }
  if (!username || !password) {
    console.log(JSON.stringify({ ok: false, status: 'missing_credentials', site: CFG.site }));
    return;
  }

  const fillAndSubmit = async () => {
    const focusId = await p.evaluate((c) => {
      const vis = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const pick = (list) => list.find(vis) || null;
      const pwEl = c.pwSel ? document.querySelector(c.pwSel) : pick([...document.querySelectorAll('input[type="password"]')]);
      const idEl = c.idSel ? document.querySelector(c.idSel) : pick([
        ...document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')
      ].filter(el => el !== pwEl && !/search|query/i.test((el.name || '') + ' ' + (el.id || ''))));
      if (!pwEl) return { ok: false, beforeUrl: location.href };
      if (idEl) { idEl.value = ''; idEl.focus(); }
      return { ok: true, hasId: !!idEl, beforeUrl: location.href };
    }, CFG);
    if (!focusId || !focusId.ok) return { ok: false, focusId };
    if (focusId.hasId) {
      await p.cdp('Input.insertText', { text: username });
      await new Promise(r => setTimeout(r, 150));
    }
    await p.evaluate((c) => {
      const vis = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const pwEl = c.pwSel ? document.querySelector(c.pwSel) : [...document.querySelectorAll('input[type="password"]')].find(vis);
      if (pwEl) { pwEl.value = ''; pwEl.focus(); }
    }, CFG);
    await p.cdp('Input.insertText', { text: password });
    await new Promise(r => setTimeout(r, 250));
    const res = await p.evaluate((c) => {
      const vis = (el) => {
        if (!el) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const pick = (list) => list.find(vis) || null;
      const pwEl = c.pwSel ? document.querySelector(c.pwSel) : pick([...document.querySelectorAll('input[type="password"]')]);
      const subEl = c.submitSel ? document.querySelector(c.submitSel) : (
        document.getElementById('log.login') ||
        pick([...document.querySelectorAll('button[type="submit"], input[type="submit"], #loginBtn_row, button.btn_login, button[class*="login"], a[class*="login"]')])
      );
      if (subEl) subEl.click();
      else if (pwEl && pwEl.form) {
        if (typeof pwEl.form.requestSubmit === 'function') pwEl.form.requestSubmit();
        else pwEl.form.submit();
      }
      return { ok: true, beforeUrl: location.href, clickedSubmit: !!subEl };
    }, CFG);
    if (!res.clickedSubmit) await p.press('Enter').catch(() => {});
    await new Promise(r => setTimeout(r, 4500));
    await handleInsecureForm(p);
    return res;
  };

  const fillResult = await fillAndSubmit();
  if (!fillResult || !fillResult.ok) {
    password = '';
    console.log(JSON.stringify({ ok: false, status: 'login_fields_not_found', fillResult }));
    return;
  }

  let after = await p.evaluate(detectState);
  // A submit can land on another host (SSO hop, hostile redirect). Nothing
  // more is typed until the page is back on the entry's site.
  const postIssue = afterProblem(after.url, CFG.site);
  if (postIssue && postIssue !== 'chrome_error' && postIssue !== 'blank_page') {
    password = '';
    writeState({ ok: false, status: 'origin_mismatch', reason: postIssue, after });
    console.log(JSON.stringify({ ok: false, status: 'origin_mismatch', reason: postIssue,
      site: CFG.site, beforeUrl: sanitizeUrl(fillResult.beforeUrl), after: pubAfter(after) }));
    return;
  }
  if (after.isCaptcha && CFG.absWaitAnswer) {
    let attempt = 1;
    const deadline = Date.now() + CFG.waitTimeout * 1000;
    while (after.isCaptcha && Date.now() < deadline) {
      const b64 = await p.screenshot();
      saveShot(b64);
      writeState({ ok: false, status: 'captcha', attempt, screenshot: CFG.shotPath, after });
      let ans = null;
      while (Date.now() < deadline) {
        if (fs.existsSync(CFG.absWaitAnswer)) {
          const txt = fs.readFileSync(CFG.absWaitAnswer, 'utf8').trim();
          try { fs.unlinkSync(CFG.absWaitAnswer); } catch {}
          if (txt) { ans = txt; break; }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!ans) {
        password = '';
        writeState({ ok: false, status: 'captcha_timeout', screenshot: CFG.shotPath, after });
        console.log(JSON.stringify({ ok: false, status: 'captcha_timeout', screenshot: CFG.shotPath, after: pubAfter(after) }));
        return;
      }
      await submitCaptchaOnPage(p, ans);
      await handleInsecureForm(p);
      after = await p.evaluate(detectState);
      const esc1 = afterProblem(after.url, CFG.site);
      if (esc1 && esc1 !== 'chrome_error' && esc1 !== 'blank_page') {
        password = '';
        writeState({ ok: false, status: 'origin_mismatch', reason: esc1, after });
        console.log(JSON.stringify({ ok: false, status: 'origin_mismatch', reason: esc1,
          site: CFG.site, after: pubAfter(after) }));
        return;
      }
      attempt += 1;
    }
    // Re-entering credentials after a chp= re-auth is only allowed on the
    // entry's own host.
    if (after.hasPasswordField && /[?&]chp=/.test(after.url) && !originProblem(after.url, CFG.site)) {
      await fillAndSubmit();
      after = await p.evaluate(detectState);
    }
    while (after.isVerify && Date.now() < deadline) {
      const b64 = await p.screenshot();
      saveShot(b64);
      writeState({ ok: false, status: 'verify', attempt, screenshot: CFG.shotPath, after });
      let ans = null;
      while (Date.now() < deadline) {
        if (fs.existsSync(CFG.absWaitAnswer)) {
          const txt = fs.readFileSync(CFG.absWaitAnswer, 'utf8').trim();
          try { fs.unlinkSync(CFG.absWaitAnswer); } catch {}
          if (txt) { ans = txt; break; }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!ans) {
        password = '';
        writeState({ ok: false, status: 'verify_timeout', screenshot: CFG.shotPath, after });
        console.log(JSON.stringify({ ok: false, status: 'verify_timeout', screenshot: CFG.shotPath, after: pubAfter(after) }));
        return;
      }
      await submitCaptchaOnPage(p, ans);
      await handleInsecureForm(p);
      after = await p.evaluate(detectState);
      const esc2 = afterProblem(after.url, CFG.site);
      if (esc2 && esc2 !== 'chrome_error' && esc2 !== 'blank_page') {
        password = '';
        writeState({ ok: false, status: 'origin_mismatch', reason: esc2, after });
        console.log(JSON.stringify({ ok: false, status: 'origin_mismatch', reason: esc2,
          site: CFG.site, after: pubAfter(after) }));
        return;
      }
      attempt += 1;
    }
    password = '';
    // Success needs a positive signal: still on the entry's site, no password
    // field, no challenge, no error code. A blank or browser-error page is a
    // failed login, never a success.
    const ok = !afterProblem(after.url, CFG.site) && !after.hasPasswordField && !after.isCaptcha && !after.isVerify && !/errorcode=/.test(after.url);
    writeState({ ok, status: ok ? 'logged_in' : 'login_failed', after });
    console.log(JSON.stringify({ ok, status: ok ? 'logged_in' : 'login_failed', beforeUrl: sanitizeUrl(fillResult.beforeUrl), after: pubAfter(after) }));
    return;
  }
  password = '';
  if (after.isCaptcha) {
    keepForCaptcha = true;
    const b64 = await p.screenshot();
    saveShot(b64);
    writeState({ ok: false, status: 'captcha', space: CFG.spaceName, screenshot: CFG.shotPath, after });
    console.log(JSON.stringify({ ok: false, status: 'captcha', space: CFG.spaceName, screenshot: CFG.shotPath, beforeUrl: sanitizeUrl(fillResult.beforeUrl), after: pubAfter(after) }));
    return;
  }
  const ok = !afterProblem(after.url, CFG.site) && !after.hasPasswordField && !/errorcode=/.test(after.url);
  writeState({ ok, status: ok ? 'logged_in' : 'login_failed', after });
  console.log(JSON.stringify({ ok, status: ok ? 'logged_in' : 'login_failed', beforeUrl: sanitizeUrl(fillResult.beforeUrl), after: pubAfter(after) }));
} finally {
  if (!keepForCaptcha) await space.finish({ keep: [] }).catch(() => {});
}
`;

const sock = await tryConnect();
const exitCode = await new Promise((resolvePromise, reject) => {
  let buf = '';
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'out') process.stdout.write(m.text);
      else if (m.type === 'err') process.stderr.write(m.text);
      else if (m.type === 'done') { sock.end(); resolvePromise(m.code); }
    }
  });
  sock.on('error', reject);
  sock.write(JSON.stringify({ type: 'run', script: code }) + '\n');
});
process.exit(exitCode || 0);
