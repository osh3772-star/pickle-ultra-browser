#!/usr/bin/env node
// vault-login.mjs — Read credentials from agent-vault inside the daemon process,
// fill/submit login forms via raw CDP without ever printing secrets, and if a
// CAPTCHA appears, keep the page alive and save a screenshot for user review.
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
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
mkdirSync(dirname(absShot), { recursive: true });
const absWaitAnswer = waitAnswerFile ? resolve(waitAnswerFile) : null;
const absStateFile = stateFile ? resolve(stateFile) : null;
if (absStateFile) mkdirSync(dirname(absStateFile), { recursive: true });
if (absWaitAnswer) mkdirSync(dirname(absWaitAnswer), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function tryConnect() {
  return new Promise((res, rej) => {
    const s = connect(SOCK);
    s.once('connect', () => res(s));
    s.once('error', rej);
  });
}

async function ensureDaemon() {
  try { const s = await tryConnect(); s.destroy(); return; } catch {}
  mkdirSync(STATE_DIR, { recursive: true });
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
  return { url: location.href, title: document.title, hasPasswordField, isCaptcha, textHead };
};
`;

const code = captchaAnswer
  ? `
const fs = await import('node:fs');
const CFG = ${JSON.stringify({ spaceName, captchaAnswer, captchaSel, submitSel, absShot, shotPath })};
${DETECT_FN}
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
  fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'));
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
  fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'));
  console.log(JSON.stringify({ ok: false, status: after.isCaptcha ? 'captcha' : 'login_failed', space: CFG.spaceName, screenshot: CFG.shotPath, after }));
  return;
}
await space.finish({ keep: [] }).catch(() => {});
console.log(JSON.stringify({ ok: true, status: 'logged_in', after }));
`
  : `
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
const CFG = ${JSON.stringify({ url, site, vaultPy: VAULT_PY, idSel, pwSel, submitSel, captchaSel, absShot, shotPath, spaceName, absWaitAnswer, absStateFile, waitTimeout })};
${DETECT_FN}
const writeState = (obj) => {
  if (!CFG.absStateFile) return;
  fs.writeFileSync(CFG.absStateFile, JSON.stringify({ ...obj, updatedAt: Date.now() }));
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
      : ([...document.querySelectorAll('input#captcha, input[name*="captcha" i], input[id*="captcha" i], input[type="text"]')].find(vis) || null);
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
      : (document.getElementById('log.login') || [...document.querySelectorAll('button[type="submit"], input[type="submit"], button.btn_login, button')].find(b => vis(b) && /confirm|확인|로그인|submit|sign in/i.test((b.innerText || b.value || ''))));
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
  await p.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

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

  const fillResult = await p.evaluate((c, u, pw) => {
    const vis = (el) => {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const pick = (list) => list.find(vis) || null;
    let pwEl = c.pwSel ? document.querySelector(c.pwSel) : pick([...document.querySelectorAll('input[type="password"]')]);
    let idEl = c.idSel ? document.querySelector(c.idSel) : pick([
      ...document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')
    ].filter(el => el !== pwEl && !/search|query/i.test((el.name || '') + ' ' + (el.id || ''))));
    let subEl = c.submitSel ? document.querySelector(c.submitSel) : pick([
      ...document.querySelectorAll('button[type="submit"], input[type="submit"], #loginBtn_row, button.btn_login, button[class*="login"], a[class*="login"]')
    ]);
    if (!idEl || !pwEl) return { ok: false, beforeUrl: location.href };

    const setVal = (el, val) => {
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(idEl, u);
    setVal(pwEl, pw);
    const beforeUrl = location.href;
    if (subEl) subEl.click();
    else if (pwEl.form) {
      if (typeof pwEl.form.requestSubmit === 'function') pwEl.form.requestSubmit();
      else pwEl.form.submit();
    }
    return { ok: true, beforeUrl, clickedSubmit: !!subEl };
  }, CFG, username, password);
  password = '';

  if (!fillResult || !fillResult.ok) {
    console.log(JSON.stringify({ ok: false, status: 'login_fields_not_found', fillResult }));
    return;
  }
  if (!fillResult.clickedSubmit) await p.press('Enter').catch(() => {});
  await new Promise(r => setTimeout(r, 4500));

  let after = await p.evaluate(detectState);
  if (after.isCaptcha && CFG.absWaitAnswer) {
    let attempt = 1;
    const deadline = Date.now() + CFG.waitTimeout * 1000;
    while (after.isCaptcha && Date.now() < deadline) {
      const b64 = await p.screenshot();
      fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'));
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
        writeState({ ok: false, status: 'captcha_timeout', screenshot: CFG.shotPath, after });
        console.log(JSON.stringify({ ok: false, status: 'captcha_timeout', screenshot: CFG.shotPath, after }));
        return;
      }
      await submitCaptchaOnPage(p, ans);
      after = await p.evaluate(detectState);
      attempt += 1;
    }
    const ok = !after.hasPasswordField && !after.isCaptcha && !/errorcode=/.test(after.url);
    writeState({ ok, status: ok ? 'logged_in' : 'login_failed', after });
    console.log(JSON.stringify({ ok, status: ok ? 'logged_in' : 'login_failed', beforeUrl: fillResult.beforeUrl, after }));
    return;
  }
  if (after.isCaptcha) {
    keepForCaptcha = true;
    const b64 = await p.screenshot();
    fs.writeFileSync(CFG.absShot, Buffer.from(b64, 'base64'));
    writeState({ ok: false, status: 'captcha', space: CFG.spaceName, screenshot: CFG.shotPath, after });
    console.log(JSON.stringify({ ok: false, status: 'captcha', space: CFG.spaceName, screenshot: CFG.shotPath, beforeUrl: fillResult.beforeUrl, after }));
    return;
  }
  const ok = !after.hasPasswordField && !/errorcode=/.test(after.url);
  writeState({ ok, status: ok ? 'logged_in' : 'login_failed', after });
  console.log(JSON.stringify({ ok, status: ok ? 'logged_in' : 'login_failed', beforeUrl: fillResult.beforeUrl, after }));
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
