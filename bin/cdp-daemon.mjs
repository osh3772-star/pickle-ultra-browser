#!/usr/bin/env node
// cdp-daemon.mjs — Pickle Ultra Browser raw-CDP daemon (harness replacement, 2026-11-26).
//
// Why: an earlier harness generation (a stock launcher and its Linux fork) delivered the first Fetch.requestPaused
// event to scripts ~15s after navigation (measured 2026-11-26: 15,029ms on
// the fork, ~15,000ms on the stock launcher vs 79-88ms over raw CDP).
// This daemon speaks CDP directly over the browser WebSocket and pushes
// events to scripts immediately. Zero npm dependencies (Node >= 22 globals).
//
// It exposes the same script surface run.sh generates code against:
//   taskSpace(name) / claimTaskSpace(id) -> { id, name, newPage(), pages(), finish({keep}) }
//   page: cdp(), events(), evaluate(), goto(), snapshot(), screenshot(), close()
//   page (input, 2026-11-26): elements(), click(), focus(), type(), typeText(), press()
//   page (challenge, 2026-11-27): challenge()
//   page (snapshot diff, 2026-11-27): snapshot({diff:true}) — snapshot diff
//   page (event signals + downloads, 2026-11-27): drainEvents(),
//     waitForEvent(), downloads(), waitForDownload() 
//   page (snapshot scoping, 2026-11-27): snapshot({ref|selector,
//     interactiveOnly}) 
//   page (a11y states + session fetch + pdf/annotated screenshot,
//     2026-11-27): snapshot state tokens; fetchInPage(), apiFallback(),
//     pdf(), annotatedScreenshot() 
// Scripts run IN THIS PROCESS (AsyncFunction), so they see this daemon's
// environment — identical semantics to the old harness (agent-vault relies
// on the daemon-start environment, e.g. AGENT_VAULT_VALUE).
//
// Protocol (Unix socket, newline-delimited JSON):
//   -> {type:"run", script:"..."}  <- {type:"out"|"err", text} ... {type:"done", code}
//   -> {type:"status"}             <- {type:"status-result", ...} {type:"done", code:0}
//   -> {type:"stop"}               <- {type:"done", code:0} then daemon exits
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, rmSync, openSync, existsSync, readdirSync, statSync, chmodSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import util from 'node:util';

const STATE_DIR = process.env.PICKLE_ULTRA_STATE_DIR || join(homedir(), '.local', 'share', 'pickle-ultra-browser');
const SOCK = join(STATE_DIR, 'cdp-daemon.sock');
const PIDFILE = join(STATE_DIR, 'cdp-daemon.pid');
const HERE = new URL('.', import.meta.url).pathname;
// What to spawn as "Chrome": CHROME_PATH from the environment (config.env
// via run.sh/pu-config.sh) wins; default is this tree's chrome-wrapper.sh.
const WRAPPER = process.env.CHROME_PATH || join(HERE, 'chrome-wrapper.sh');
const PROFILE = process.env.PICKLE_ULTRA_PROFILE || join(HERE, 'profile');
const HEADLESS = process.env.PICKLE_ULTRA_HEADLESS !== '0';
const EPHEMERAL = process.env.PICKLE_ULTRA_EPHEMERAL === '1';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try { chmodSync(STATE_DIR, 0o700); } catch {}
writeFileSync(PIDFILE, String(process.pid), { mode: 0o600 });
try { chmodSync(PIDFILE, 0o600); } catch {}

// ---------------------------------------------------------------- sandbox
// Chromium's sandbox needs either user namespaces (Linux), a setuid
// chrome_sandbox, or macOS seatbelt. In a container that disables user
// namespaces it cannot start at all, so the old build hard-coded
// --no-sandbox for everyone. That hid the trade-off instead of stating it:
// every page this daemon visits then runs with the host user's full rights.
//
// Now the flag follows the environment, and the choice is always visible:
//   PU_CHROME_SANDBOX=auto     (default) use the sandbox when this host can
//                              run it; otherwise run without it and say so
//   PU_CHROME_SANDBOX=require  refuse to launch unless the sandbox works
//   PU_CHROME_SANDBOX=off      run without it deliberately (no warning loop)
// The risky mode is never silently the default.
function sandboxSupport() {
  const mode = String(process.env.PU_CHROME_SANDBOX || 'auto').toLowerCase();
  if (mode === 'off') return { mode, usable: false, why: 'PU_CHROME_SANDBOX=off' };
  if (process.platform === 'darwin') return { mode, usable: true, why: 'macOS seatbelt' };
  if (process.platform !== 'linux') return { mode, usable: false, why: 'no Chromium sandbox on ' + process.platform };
  const rd = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  const usernsClone = rd('/proc/sys/kernel/unprivileged_userns_clone');   // Debian/Ubuntu
  const maxNs = rd('/proc/sys/user/max_user_namespaces');                 // most kernels
  const apparmor = rd('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  if (usernsClone === '0') return { mode, usable: false, why: 'unprivileged_userns_clone=0' };
  if (maxNs === '0') return { mode, usable: false, why: 'max_user_namespaces=0' };
  if (apparmor === '2') return { mode, usable: false, why: 'apparmor_restrict_unprivileged_userns=2' };
  // A root-owned setuid helper also works (Chrome's own sandbox binary).
  const cands = [];
  for (const c of [process.env.PICKLE_ULTRA_CHROME, process.env.CHROME_BIN]) if (c) cands.push(c);
  try {
    const root = join(homedir(), '.cache', 'ms-playwright');
    for (const d of readdirSync(root)) if (d.startsWith('chromium-')) cands.push(join(root, d, 'chrome-linux64', 'chrome'));
  } catch {}
  for (const c of cands) {
    try {
      const st = statSync(join(join(c, '..'), 'chrome_sandbox'));
      if (st.uid === 0 && (st.mode & 0o4000)) return { mode, usable: true, why: 'setuid chrome_sandbox' };
    } catch {}
  }
  const uid = process.getuid ? process.getuid() : -1;
  if (uid === 0) return { mode, usable: false, why: 'running as root without a setuid sandbox' };
  if (usernsClone === '1' || Number(maxNs) > 0) {
    return { mode, usable: true, why: 'user namespaces available' };
  }
  if (usernsClone === '' && maxNs === '') {
    // No sysctl to read (unusual kernel): we cannot tell, so we let Chromium
    // decide. If it fails, the error names cdp-chrome.log.
    return { mode, usable: true, why: 'no namespace sysctl — assuming available' };
  }
  return { mode, usable: false, why: 'user namespaces unavailable' };
}

// ---------------------------------------------------------------- Chrome/CDP
let chromeProc = null;
let chromePort = 0;
let ws = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();          // id -> {res, rej}
const sessions = new Map();         // sessionId -> {targetId, events: [], loadWaiters: [], signals: []}

// --- Async event signals + downloads (2026-11-27) ---
// The harness pushes popup/download/tab-close signals to the agent
// instead of letting it discover them by polling. Browser-level Target
// events carry no sessionId; downloads arrive as Browser.* (browser
// level, because Browser.setDownloadBehavior runs with
// eventsEnabled:true) and/or Page.* (session level) — both feed the
// same registry, deduplicated by guid + state transition.
const DL_DIR = join(STATE_DIR, 'downloads'); // completed downloads land here
const browserSignals = [];          // {t, kind:'popup'|'tab_closed', targetId, url}
const popupTargets = new Set();     // targetIds a page opened (openerId set)
const downloads = new Map();        // guid -> download record
const downloadLog = [];             // ordered lifecycle entries for drainEvents()
let dlBehaviorSet = false;
function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}
function noteDownload(kind, rec) {
  pushCapped(downloadLog, { t: Date.now(), kind, ...rec }, 500);
}
function noteDownloadEvent(method, p, sessionId) {
  const guid = p.guid || '';
  if (!guid) return;
  if (method.endsWith('downloadWillBegin')) {
    if (downloads.has(guid)) return; // Browser.* and Page.* can both report it
    const rec = { guid, url: p.url || '', filename: p.suggestedFilename || '', state: 'inProgress', received: 0, total: -1, sessionId: sessionId || null, startedAt: Date.now() };
    downloads.set(guid, rec);
    noteDownload('download_started', { ...rec });
  } else if (method.endsWith('downloadProgress')) {
    const rec = downloads.get(guid) || { guid, url: '', filename: '', state: '', received: 0, total: -1, sessionId: sessionId || null, startedAt: Date.now() };
    const prevState = rec.state;
    rec.state = p.state || rec.state;
    if (p.receivedBytes !== undefined) rec.received = p.receivedBytes;
    if (p.totalBytes !== undefined) rec.total = p.totalBytes;
    downloads.set(guid, rec);
    if (rec.state === 'completed' && prevState !== 'completed') noteDownload('download_completed', { ...rec });
    else if (rec.state === 'canceled' && prevState !== 'canceled') noteDownload('download_canceled', { ...rec });
  }
}
function resolveDownloadPath(filename) {
  if (!filename) return null;
  const direct = join(DL_DIR, filename);
  if (existsSync(direct)) return direct;
  // Chrome uniquifies collisions as "name (1).ext" — take the newest match.
  try {
    const m = /^(.*?)(\.[^.]+)?$/.exec(filename);
    const base = m[1], ext = m[2] || '';
    const cands = readdirSync(DL_DIR)
      .filter(f => f.startsWith(base + ' (') && f.endsWith(')' + ext))
      .map(f => ({ f, mt: statSync(join(DL_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    return cands.length ? join(DL_DIR, cands[0].f) : null;
  } catch { return null; }
}

const DEBUG = process.env.PU_CDP_DEBUG === '1';
const dbg = (...a) => { if (DEBUG) try { writeFileSync(join(STATE_DIR, 'cdp-debug.log'), a.join(' ') + '\n', { flag: 'a' }); } catch {} };
function cdpSend(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    dbg(Date.now(), 'SEND', id, method, sessionId || '-');
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function onWsMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    dbg(Date.now(), 'RECV', m.id, m.error ? 'ERR ' + (m.error.message || '') : 'ok');
    if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
    else res(m.result);
    return;
  }
  dbg(Date.now(), 'EVT', m.method || '?', m.sessionId || '-');
  if (m.method && !m.sessionId) {
    // Browser-level events (no sessionId): popup targets, tab closes,
    // browser-level download lifecycle.
    if (m.method === 'Target.targetCreated') {
      const ti = (m.params && m.params.targetInfo) || {};
      // Only targets a PAGE opened (openerId set) count as popups —
      // targets we create ourselves via Target.createTarget are our
      // own pages, and Chrome's initial about:blank has no opener.
      if (ti.type === 'page' && ti.openerId) {
        popupTargets.add(ti.targetId);
        pushCapped(browserSignals, { t: Date.now(), kind: 'popup', targetId: ti.targetId, url: ti.url || '' }, 500);
      }
    } else if (m.method === 'Target.targetDestroyed') {
      const tid = m.params && m.params.targetId;
      const wasPopup = tid && popupTargets.delete(tid);
      const wasOurs = tid && [...sessions.values()].some(s => s.targetId === tid);
      if (tid && (wasPopup || wasOurs)) {
        pushCapped(browserSignals, { t: Date.now(), kind: 'tab_closed', targetId: tid, url: '' }, 500);
      }
    } else if (m.method === 'Browser.downloadWillBegin' || m.method === 'Browser.downloadProgress') {
      noteDownloadEvent(m.method, m.params || {}, null);
    }
  }
  if (m.method && m.sessionId && sessions.has(m.sessionId)) {
    const s = sessions.get(m.sessionId);
    // Armed Fetch policy: answer requestPaused IMMEDIATELY here in the event
    // handler. If scripts answer via events()+cdp() instead, the pump's next
    // Runtime.evaluate deadlocks against the paused document (evaluate is
    // queued until the navigation commits; the commit waits for the Fetch
    // answer) — measured 2026-11-26. The old harness masked this by
    // delivering events ~15s late, after evaluates had already returned.
    if (m.method === 'Fetch.requestPaused' && s.fetchPolicy) {
      const p = m.params || {};
      let decision;
      try {
        decision = s.fetchPolicy.policy({
          url: (p.request && p.request.url) || '',
          method: (p.request && p.request.method) || '',
          resourceType: p.resourceType || '',
          requestId: p.requestId,
        });
      } catch { decision = s.fetchPolicy.fallback; }
      if (decision === 'continue') {
        cdpSend('Fetch.continueRequest', { requestId: p.requestId }, m.sessionId).catch(() => {});
      } else {
        cdpSend('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, m.sessionId).catch(() => {});
      }
    }
    // Curated session signals for drainEvents(): JS dialogs (a dialog
    // blocks the page until handled, so scripts need to know) and the
    // session-level download lifecycle. Popup/tab-close signals come
    // from the browser-level Target branch above — Page.windowOpen is
    // deliberately NOT mirrored here, it would double-report every
    // popup (each window.open also creates a target).
    if (m.method === 'Page.javascriptDialogOpening' && s.signals) {
      s.signals.push({ t: Date.now(), kind: 'dialog', dialogType: (m.params && m.params.type) || '', message: (m.params && m.params.message) || '' });
    }
    if (m.method === 'Page.downloadWillBegin' || m.method === 'Page.downloadProgress') {
      noteDownloadEvent(m.method, m.params || {}, m.sessionId);
    }
    s.events.push({ method: m.method, params: m.params });
    if (s.events.length > 10000) s.events.splice(0, s.events.length - 10000);
    if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading') {
      const w = s.loadWaiters.splice(0);
      for (const fn of w) fn(m.method);
    }
  }
}

async function launchChrome() {
  // Fixed-ish port (never 0: Chrome reports navigator.webdriver=true on an
  // OS-assigned debugging port — same reasoning as the earlier launcher).
  // PICKLE_ULTRA_CDP_PORT pins the first candidate when set.
  const pinned = Number(process.env.PICKLE_ULTRA_CDP_PORT || 0);
  const candidates = [...new Set([pinned, 19222, 19223, 19224, 19225, 19226].filter(Boolean))];
  for (const p of candidates) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (r.ok) throw new Error('busy');
    } catch (e) { if (e.message !== 'busy') { chromePort = p; break; } }
  }
  if (!chromePort) chromePort = candidates[0];
  const sb = sandboxSupport();
  const args = [
    `--remote-debugging-port=${chromePort}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    ...(sb.usable ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
    '--mute-audio',
    '--disable-blink-features=AutomationControlled',
    `--lang=${process.env.PICKLE_ULTRA_LANG || 'ko-KR'}`,
    '--accept-lang=ko-KR,ko;q=0.9,en;q=0.5',
    ...(HEADLESS ? ['--headless=new', '--hide-scrollbars', '--window-size=1280,800'] : []),
    'about:blank',
  ];
  if (!sb.usable) {
    if (sb.mode === 'require') {
      throw new Error('chromium sandbox required (PU_CHROME_SANDBOX=require) but unavailable here: ' +
        sb.why + ' — set PU_CHROME_SANDBOX=auto to accept --no-sandbox with its risk, or run on a host that supports it');
    }
    if (sb.mode !== 'off') {
      console.error('cdp-daemon: WARNING chromium sandbox unavailable (' + sb.why +
        ') — launching with --no-sandbox: page content runs with this user\'s full rights.' +
        ' Set PU_CHROME_SANDBOX=require to refuse, or =off to silence this.');
      try { appendFileSync(join(STATE_DIR, 'cdp-daemon.log'),
        new Date().toISOString() + ' sandbox=disabled why=' + sb.why + '\n'); } catch {}
    }
  }
  const logFd = openSync(join(STATE_DIR, 'cdp-chrome.log'), 'a');
  // The profile holds cookies and sessions: create it 0700 before Chrome does,
  // and keep it 0700 in case an earlier run left it wider.
  try { mkdirSync(PROFILE, { recursive: true, mode: 0o700 }); chmodSync(PROFILE, 0o700); } catch {}
  chromeProc = spawn(WRAPPER, args, { stdio: ['ignore', logFd, logFd], env: process.env });
  chromeProc.on('exit', () => {
    chromeProc = null; ws = null; readyPromise = null; sessions.clear(); spaces.clear();
    dlBehaviorSet = false; downloads.clear(); downloadLog.length = 0;
    browserSignals.length = 0; popupTargets.clear();
  });
  // Wait for the DevTools endpoint, then connect the browser-level socket.
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`); if (r.ok) ver = await r.json(); } catch {}
    if (!ver) await new Promise(r => setTimeout(r, 250));
  }
  if (!ver) throw new Error('chrome devtools endpoint never came up (see cdp-chrome.log)');
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = onWsMessage;
  // Discover targets so popup tabs (window.open / target=_blank) surface
  // as Target.targetCreated signals (see drainEvents()).
  try { await cdpSend('Target.setDiscoverTargets', { discover: true }); } catch {}
  // Close the startup about:blank tab Chrome was launched with. It is useless
  // to us and its renderer process keeps ~9 threads for the daemon's whole
  // life; measured on 2026-11-27. Nothing else uses it.
  try {
    const r = await cdpSend('Target.getTargets', {});
    for (const t of r.targetInfos || []) {
      if (t.type === 'page' && (!t.url || t.url === 'about:blank')) {
        try { await cdpSend('Target.closeTarget', { targetId: t.targetId }); } catch {}
      }
    }
  } catch {}
}

function ensureChrome() {
  if (!readyPromise) {
    readyPromise = launchChrome().catch(e => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

// ---------------------------------------------------------------- Input primitives
// Input primitives carried over from the earlier harness build (2026-11-26):
// SNAPSHOT_SCRIPT, buildRectScript, buildFocusScript, SPECIAL_KEYS +
// keyDefinition — trimmed only so the snapshot's body-text field is dropped
// (read/snapshot already cover text) and invalidParams() is a plain Error.
const ELEMENT_ID_ATTR = 'data-pu-id';
const MAX_SNAPSHOT_ELEMENTS = 300;
// AX roles treated as interactive for snapshot({interactiveOnly:true})
// (2026-11-27 — the standard ARIA interactive role set) and for the [clickable] state
// annotation (step 5: the a11y tree annotates focus/clickable/iframe
// states; the state tokens ride INSIDE the existing single [..] bracket
// so snaptrim's line grammar — role "name" [one bracket group] — keeps
// parsing).
const AX_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'switch', 'textbox', 'searchbox', 'combobox',
  'listbox', 'slider', 'spinbutton', 'treeitem', 'gridcell',
]);
const AX_CLICKABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'switch', 'treeitem', 'gridcell',
]);
const SNAPSHOT_SCRIPT = `(() => {
  const ATTR = '${ELEMENT_ID_ATTR}';
  document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  const out = [];
  let n = 0;
  let truncated = false;
  for (const el of document.querySelectorAll(SELECTOR)) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.width === 0 && rect.height === 0) continue;
    n += 1;
    if (n > ${MAX_SNAPSHOT_ELEMENTS}) { truncated = true; break; }
    const id = 'e' + n;
    el.setAttribute(ATTR, id);
    const item = {
      id,
      kind: el.tagName.toLowerCase(),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
    const type = el.getAttribute('type');
    if (type) item.type = type;
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    if (text) item.text = text;
    const label = el.getAttribute('aria-label');
    if (label) item.label = label.slice(0, 120);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) item.placeholder = placeholder.slice(0, 120);
    if (el.tagName === 'A' && el.href) item.href = el.href.slice(0, 300);
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && type !== 'password') {
      if (el.value) item.value = String(el.value).slice(0, 200);
    }
    if (el.tagName === 'SELECT' && el.value) item.value = String(el.value).slice(0, 200);
    if ('checked' in el && (type === 'checkbox' || type === 'radio')) item.checked = Boolean(el.checked);
    if (el.disabled) item.disabled = true;
    out.push(item);
  }
  return { url: location.href, title: document.title, elements: out, truncated };
})()`;

function buildRectScript(ref) {
  const lookup = ref.id
    ? `document.querySelector('[${ELEMENT_ID_ATTR}="' + ${JSON.stringify(ref.id)} + '"]')`
    : `document.querySelector(${JSON.stringify(ref.selector)})`;
  return `(() => {
    const el = ${lookup};
    if (!el) return null;
    el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`;
}

function buildFocusScript(ref) {
  const lookup = ref.id
    ? `document.querySelector('[${ELEMENT_ID_ATTR}="' + ${JSON.stringify(ref.id)} + '"]')`
    : `document.querySelector(${JSON.stringify(ref.selector)})`;
  return `(() => { const el = ${lookup}; if (!el) return false; el.focus(); return true; })()`;
}

// --- Challenge detect + wait (2026-11-27) ---
// Challenge handling: DETECT a visible human-
// verification challenge and WAIT briefly for it to resolve by itself
// (Turnstile and Cloudflare managed challenges often auto-pass in a
// healthy session). This NEVER interacts with a challenge — no checkbox
// clicks, no image solving, no external solver service. If the wait
// expires unresolved, the caller stops and reports / switches exit (see
// the ultra-captcha-handling skill).
//
// --fp interaction: under run.sh's strict Fetch policy only the target
// host is continued, so challenge hosts (challenges.cloudflare.com,
// hcaptcha.com, www.google.com/recaptcha) are blocked and the widget
// never renders — challenge() finds nothing and the widget's spot on
// the page just looks empty/broken. Detect+wait is a normal/lean-mode
// tool; an empty challenge area under --fp means the widget was
// intercepted, not that no challenge exists.
const CHALLENGE_PROBE_SCRIPT = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const frames = Array.from(document.querySelectorAll('iframe'));
  const src = (f) => f.getAttribute('src') || '';
  const tokenOf = (sel) => {
    const el = document.querySelector(sel);
    return !!(el && el.value);
  };
  const out = [];
  // Cloudflare managed challenge / "Just a moment" interstitial. Checked
  // first: it also loads a challenges.cloudflare.com frame, which must
  // not be misread as a plain Turnstile widget.
  const cfInterstitial = !!(window._cf_chl_opt
    || document.querySelector('#challenge-form, #cf-challenge, .cf-browser-verification')
    || /just a moment/i.test(document.title || ''));
  if (cfInterstitial) out.push({ type: 'cloudflare-challenge', token: false });
  // Cloudflare Turnstile widget.
  const tsFrame = frames.find((f) => src(f).indexOf('challenges.cloudflare.com') !== -1);
  const tsBox = document.querySelector('.cf-turnstile');
  if (!cfInterstitial && (tsFrame || tsBox)) {
    out.push({ type: 'turnstile', token: tokenOf('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]') });
  }
  // hCaptcha.
  const hcFrame = frames.find((f) => src(f).indexOf('hcaptcha.com') !== -1);
  const hcBox = document.querySelector('.h-captcha');
  if (hcFrame || hcBox) {
    out.push({ type: 'hcaptcha', token: tokenOf('[name="h-captcha-response"]') });
  }
  // reCAPTCHA v2 (checkbox / challenge iframe).
  const rcFrame = frames.find((f) => src(f).indexOf('google.com/recaptcha') !== -1 || src(f).indexOf('recaptcha.net/recaptcha') !== -1);
  const rcBox = document.querySelector('.g-recaptcha');
  if (rcFrame || rcBox) {
    out.push({ type: 'recaptcha-v2', token: tokenOf('#g-recaptcha-response, [name="g-recaptcha-response"]') });
  } else if (document.querySelector('.grecaptcha-badge')
    || Array.from(document.scripts).some((s) => (s.src || '').indexOf('recaptcha/api.js') !== -1 && (s.src || '').indexOf('render=') !== -1)) {
    // reCAPTCHA v3: score-based, no user-visible challenge and no token
    // field until execute() runs — presence only, pass state unknowable.
    out.push({ type: 'recaptcha-v3', token: false, passive: true });
  }
  // Generic fallback: a visible element that names itself a captcha.
  if (!out.length) {
    const g = Array.from(document.querySelectorAll('[class*="captcha" i], [id*="captcha" i]')).find(vis);
    if (g) out.push({ type: 'generic', token: false });
  }
  return { url: location.href, title: document.title, challenges: out };
})()`;

const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

function keyDefinition(name) {
  if (SPECIAL_KEYS[name]) return SPECIAL_KEYS[name];
  const fMatch = /^F([1-9]|1[0-2])$/.test(name);
  if (fMatch) {
    const n = Number(name.slice(1));
    return { key: name, code: name, vk: 111 + n };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = upper >= 'A' && upper <= 'Z';
    const isDigit = name >= '0' && name <= '9';
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
      vk: upper.charCodeAt(0),
      text: name,
    };
  }
  throw new Error(
    `press: unsupported key "${name}". Use a special key (Enter, Tab, Escape, ` +
      'Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space, F1-F12) or a single character.',
  );
}

// A ref is 'e3' (an id from elements()), a CSS selector string, or
// {id} / {selector}.
function parseRef(ref) {
  if (ref && typeof ref === 'object') {
    if (ref.id) return { id: String(ref.id) };
    if (ref.selector) return { selector: String(ref.selector) };
  }
  if (typeof ref === 'string' && ref) {
    return /^e\d+$/.test(ref) ? { id: ref } : { selector: ref };
  }
  throw new Error('ref must be an element id (e3), a CSS selector, or {id}/{selector}');
}
function refLabel(ref) {
  const r = parseRef(ref);
  return r.id ? 'element ' + r.id : 'selector ' + JSON.stringify(r.selector);
}

// ---------------------------------------------------------------- Page shim
class PUPage {
  constructor(space, targetId, sessionId, label) {
    this.space = space; this.targetId = targetId; this.sessionId = sessionId; this.label = label;
    this.busy = false;      // acquirePage()/finish() reuse bookkeeping
    this._snapBaselines = new Map();  // scopeKey -> Map(key -> rendered line); '' is the unscoped baseline
    this._sigCursor = 0;    // drainEvents() cursor into browserSignals
    this._dlCursor = 0;     // drainEvents() cursor into downloadLog
  }
  async cdp(method, params = {}) { return cdpSend(method, params, this.sessionId); }
  // armFetch(policy, fallback): policy({url, method, resourceType, requestId})
  // runs daemon-side per Fetch.requestPaused and must return 'continue' or
  // 'fail'. Because scripts execute in this process, the policy may be a
  // closure over script variables (counters, timestamps).
  armFetch(policy, fallback = 'fail') {
    const s = sessions.get(this.sessionId);
    if (s) s.fetchPolicy = { policy, fallback };
  }
  disarmFetch() {
    const s = sessions.get(this.sessionId);
    if (s) s.fetchPolicy = null;
  }
  async events() {
    const s = sessions.get(this.sessionId);
    if (!s) return [];
    const out = s.events; s.events = [];
    return out;
  }
  async evaluate(fnOrExpr, arg) {
    let expression;
    if (typeof fnOrExpr === 'function') {
      expression = `(${fnOrExpr.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    } else { expression = String(fnOrExpr); }
    const r = await this.cdp('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const msg = (r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value)) || r.exceptionDetails.text || 'page evaluation failed';
      throw new Error(String(msg).slice(0, 500));
    }
    return r.result ? r.result.value : undefined;
  }
  async goto(url) {
    const s = sessions.get(this.sessionId);
    const loaded = new Promise(res => {
      const t = setTimeout(() => res('timeout'), 15000);
      s.loadWaiters.push(() => { clearTimeout(t); res('loaded'); });
    });
    await this.cdp('Page.navigate', { url });
    const how = await loaded;
    if (how === 'timeout') throw new Error('goto: load timeout (15s) for ' + url);
  }
  // --- Snapshot core (2026-11-27: structured entries, for diff) ---
  // _axEntries() flattens the AX tree into entries {depth, role, name,
  // backendId, key, states[]}. The walk mirrors the historical text walk
  // exactly (ignored nodes emit no line and add no depth; InlineTextBox
  // dropped — per-character fragments of a parent StaticText that bloat
  // the snapshot ~10x and leak into snaptrim's text mode). key is the
  // backendDOMNodeId when present, else the child-index path — stable
  // enough across two snapshots of the same page for diffing. states[]
  // carries the a11y state annotations (2026-11-27,
  // step 5): iframe / focused / disabled / checked / selected /
  // expanded / collapsed / clickable (clickable role or AX focusable).
  async _axEntries() {
    const { nodes } = await this.cdp('Accessibility.getFullAXTree', {});
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const entries = [];
    const prop = (node, name) => {
      for (const p of node.properties || []) if (p.name === name) return p.value ? p.value.value : undefined;
      return undefined;
    };
    const walk = (node, depth, path) => {
      if (!node) return;
      const role = (node.role && node.role.value) || 'generic';
      if (role === 'InlineTextBox') return;
      const name = node.name ? node.name.value : '';
      let d = depth;
      if (!node.ignored || depth === 0) {
        const states = [];
        if (role === 'Iframe') states.push('iframe');
        if (prop(node, 'focused') === true) states.push('focused');
        if (prop(node, 'disabled') === true) states.push('disabled');
        const checked = prop(node, 'checked');
        // AX 'checked' is a tristate value: boolean true or the
        // strings 'true'/'false'/'mixed' depending on the node.
        if (checked === true || checked === 'true') states.push('checked');
        else if (checked === 'mixed') states.push('checked=mixed');
        if (prop(node, 'selected') === true) states.push('selected');
        const expanded = prop(node, 'expanded');
        if (expanded === true) states.push('expanded');
        else if (expanded === false) states.push('collapsed');
        if (AX_CLICKABLE_ROLES.has(role) || prop(node, 'focusable') === true) states.push('clickable');
        entries.push({
          depth, role, name,
          backendId: node.backendDOMNodeId || null,
          key: node.backendDOMNodeId ? 'b' + node.backendDOMNodeId : 'p' + path,
          states,
        });
        d = depth + 1;
      }
      (node.childIds || []).forEach((cid, i) => walk(byId.get(cid), d, path + '/' + i));
    };
    nodes.filter(n => !n.parentId).forEach((n, i) => walk(n, 0, String(i)));
    return entries;
  }
  _renderSnapLine(e) {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    let line = '  '.repeat(e.depth) + e.role;
    if (e.name) line += ' "' + esc(e.name) + '"';
    // State tokens ride INSIDE the single bracket group (with ref=) so
    // snaptrim's line grammar keeps matching — see the AX_* comment.
    const bracket = [];
    if (e.backendId) bracket.push('ref=' + e.backendId);
    bracket.push(...e.states);
    if (bracket.length) line += ' [' + bracket.join(' ') + ']';
    return line;
  }
  // _subtreeEntries(entries, backendId): the entry for backendId plus
  // its descendants (following entries of greater depth), with depths
  // rebased so the scope root renders at depth 0. Entry keys are NOT
  // rebased — they stay comparable with the full tree's keys.
  _subtreeEntries(entries, backendId) {
    const i = entries.findIndex(e => e.backendId === backendId);
    if (i < 0) return [];
    const base = entries[i].depth;
    const out = [entries[i]];
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].depth <= base) break;
      out.push(entries[j]);
    }
    return out.map(e => ({ ...e, depth: e.depth - base }));
  }
  // _scopeBackendId(opts): resolve a scope target to a backendDOMNodeId.
  // ref may be a backendDOMNodeId (number — the [ref=N] printed in
  // snapshot lines), an 'e3' id from elements(), or a CSS selector
  // string; opts.selector is always CSS. The element is tagged with a
  // throwaway attribute and resolved through the DOM domain (the AX
  // tree itself cannot be searched by selector), then untagged.
  async _scopeBackendId(opts) {
    if (typeof opts.ref === 'number') return opts.ref;
    let selector = opts.selector || null;
    if (!selector && typeof opts.ref === 'string' && opts.ref) {
      selector = /^e\d+$/.test(opts.ref)
        ? '[' + ELEMENT_ID_ATTR + '="' + opts.ref + '"]'
        : opts.ref;
    }
    if (!selector) return null;
    const tagged = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.setAttribute('data-pu-scope', '1');
      return true;
    }, selector);
    if (!tagged) return null;
    try {
      const doc = await this.cdp('DOM.getDocument', { depth: 1 });
      const q = await this.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-pu-scope="1"]' });
      if (!q.nodeId) return null;
      const desc = await this.cdp('DOM.describeNode', { nodeId: q.nodeId });
      return desc.node.backendNodeId;
    } finally {
      await this.evaluate(() => {
        const el = document.querySelector('[data-pu-scope="1"]');
        if (el) el.removeAttribute('data-pu-scope');
      }).catch(() => {});
    }
  }
  // snapshot(opts) -> text tree. No opts = the historical full tree;
  // existing callers (run.sh passes {scope:'full_page'}) are unaffected —
  // unknown opts are ignored. Options (2026-11-27):
  //   diff: true — return only what changed vs this page's previous
  //   snapshot (the common {tree, diff} pattern): a header line
  //   'snapshot-diff: +A -R ~C' then '+ '/'- '/'~ '-prefixed lines.
  //   First diff call (no baseline) returns the full tree with a
  //   no-baseline note. (①)
  //   ref / selector — scope to that element's subtree only; the
  //   scope root renders at depth 0. (③)
  //   interactiveOnly: true — keep only interactive-role lines
  //   (indentation preserved). (③)
  // Lines carry a11y state tokens (iframe/focused/disabled/checked/
  // selected/expanded/collapsed/clickable) inside the [..] bracket,
  // after ref= when present. (⑤)
  // Baseline rule (③ design decision): baselines are kept PER SCOPE —
  // the unscoped baseline (key '') plus one per resolved scope target
  // (+interactiveOnly). Scoped/filtered calls only ever read and
  // refresh their own scope's baseline, so scoping can never pollute
  // the full-page diff baseline (and vice versa). Every snapshot call
  // refreshes the baseline of the scope it ran in.
  async snapshot(opts = {}) {
    if (!opts || typeof opts !== 'object') opts = {};
    let entries = await this._axEntries();
    let scopeKey = '';
    const notes = [];
    if (opts.ref !== undefined || opts.selector) {
      const backendId = await this._scopeBackendId(opts);
      if (backendId == null) {
        throw new Error('snapshot: scope target not found (' + (opts.selector ? 'selector ' + JSON.stringify(opts.selector) : 'ref ' + JSON.stringify(opts.ref)) + ')');
      }
      entries = this._subtreeEntries(entries, backendId);
      scopeKey = 'b' + backendId;
      notes.push('scope: subtree of [ref=' + backendId + '] (' + entries.length + ' entries, depths rebased)');
    }
    if (opts.interactiveOnly) {
      entries = entries.filter(e => AX_INTERACTIVE_ROLES.has(e.role));
      scopeKey += '|io';
      notes.push('scope: interactive-only (' + entries.length + ' entries)');
    }
    const header = [];
    try {
      const href = await this.evaluate(() => location.href);
      const title = await this.evaluate(() => document.title);
      header.push('title: ' + title, 'url: ' + href);
    } catch {}
    header.push(...notes);
    const rendered = entries.map(e => this._renderSnapLine(e));
    if (opts.diff) return this._diffSnapshot(entries, rendered, header, scopeKey);
    this._snapBaselines.set(scopeKey, new Map(entries.map((e, i) => [e.key, rendered[i]])));
    return header.concat(rendered).join('\n');
  }
  _diffSnapshot(entries, rendered, header, scopeKey = '') {
    const cur = new Map(entries.map((e, i) => [e.key, rendered[i]]));
    const prev = this._snapBaselines.get(scopeKey) || null;
    this._snapBaselines.set(scopeKey, cur);
    if (!prev) {
      return header.concat(['snapshot-diff: no baseline yet — full tree below'], rendered).join('\n');
    }
    const out = [];
    let added = 0, removed = 0, changed = 0;
    entries.forEach((e, i) => {
      const line = rendered[i];
      if (!prev.has(e.key)) { out.push('+ ' + line); added++; }
      else if (prev.get(e.key) !== line) { out.push('~ ' + line); changed++; }
    });
    for (const [k, line] of prev) {
      if (!cur.has(k)) { out.push('- ' + line); removed++; }
    }
    const MAXD = 200;
    const shown = out.slice(0, MAXD);
    if (out.length > MAXD) shown.push('... diff truncated (' + (out.length - MAXD) + ' more lines)');
    return header.concat(
      ['snapshot-diff: +' + added + ' -' + removed + ' ~' + changed],
      shown.length ? shown : ['(no changes)'],
    ).join('\n');
  }
  // --- Input primitives (carried over from the earlier harness build) ---
  // elements(): interactive-element snapshot with e-ids + center coords.
  // Password inputs report type only, never a value.
  async elements() {
    const v = await this.evaluate(SNAPSHOT_SCRIPT);
    if (!v || !Array.isArray(v.elements)) throw new Error('elements: page did not return a snapshot');
    return v;
  }
  async rectOf(ref) {
    const r = parseRef(ref);
    const rect = await this.evaluate(buildRectScript(r));
    if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number') {
      throw new Error('element_not_found: ' + refLabel(ref) + ' is not on the page anymore - take a fresh elements()');
    }
    return rect;
  }
  async click(ref) {
    const rect = await this.rectOf(ref);
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    return { clicked: refLabel(ref), x: rect.x, y: rect.y };
  }
  async focus(ref) {
    const r = parseRef(ref);
    const ok = await this.evaluate(buildFocusScript(r));
    if (!ok) throw new Error('element_not_found: ' + refLabel(ref) + ' is not on the page anymore - take a fresh elements()');
    return { focused: refLabel(ref) };
  }
  async dispatchKey(def, modifiers, type) {
    const ev = {
      type, key: def.key, code: def.code,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
      modifiers: modifiers || 0,
    };
    if (type === 'keyDown' && def.text && !((modifiers || 0) & 2) && !((modifiers || 0) & 4)) ev.text = def.text;
    await this.cdp('Input.dispatchKeyEvent', ev);
  }
  async press(key, modifiers = 0) {
    const def = keyDefinition(key);
    // A character key carries text into the focused element; do not let that
    // become a second way to type into a password field.
    if (def.text) await this.assertNotPasswordField();
    await this.dispatchKey(def, modifiers, 'keyDown');
    await this.dispatchKey(def, modifiers, 'keyUp');
    return { pressed: key };
  }
  // type(ref, text, {clear:true}) focuses ref, optionally clears it
  // (Ctrl+A + Backspace, as in chromeControl), then inserts text as real
  // input via Input.insertText.
  //
  // Password guard (2026-11-27): run.sh's `type` action refuses a password
  // field before running, but a `-f` script calling p.type/p.typeText/press
  // directly used to bypass that check (DEFECT-003). The guard now sits at
  // the last step before text reaches the page and reads the element's
  // *property* (el.type), so no attribute spelling can hide the field. The
  // text being typed is never echoed in the error.
  async assertNotPasswordField() {
    let pw = false;
    try {
      pw = await this.evaluate(() => {
        const el = document.activeElement;
        if (!el) return false;
        const t = String(el.type || '').toLowerCase();
        const ac = String((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
        return t === 'password' || ac === 'current-password' || ac === 'new-password';
      });
    } catch { pw = false; }
    if (pw) {
      throw new Error('password_field_refused: this build never fills a password field — ' +
        'hand the flow to the host agent\'s browser + vault (code F-AUTH, next=builtin-browser-vault)');
    }
    return true;
  }
  async type(ref, text, opts = {}) {
    await this.focus(ref);
    await this.assertNotPasswordField();
    if (opts && opts.clear) {
      await this.dispatchKey({ key: 'a', code: 'KeyA', vk: 65 }, 2, 'keyDown');
      await this.dispatchKey({ key: 'a', code: 'KeyA', vk: 65 }, 2, 'keyUp');
      await this.dispatchKey(SPECIAL_KEYS.Backspace, 0, 'keyDown');
      await this.dispatchKey(SPECIAL_KEYS.Backspace, 0, 'keyUp');
    }
    await this.cdp('Input.insertText', { text: String(text) });
    return { typed: refLabel(ref), chars: String(text).length };
  }
  async typeText(text) {
    await this.assertNotPasswordField();
    await this.cdp('Input.insertText', { text: String(text) });
    return { chars: String(text).length };
  }
  // challenge(opts): detect a human-verification challenge on the page
  // and, when one is present, wait for it to resolve on its own.
  //   opts: { timeoutMs = 30000, pollMs = 500, appearMs = 3000, wait = true }
  //   -> { detected, type, passed, waitedMs, url }
  // type: 'turnstile' | 'hcaptcha' | 'recaptcha-v2' | 'recaptcha-v3'
  //       | 'cloudflare-challenge' | 'generic' | null
  // passed: true  — a response token appeared, the widget disappeared,
  //                 or (interstitial) the page navigated past the check
  //         false — still unresolved when the wait ended / none found
  //         null  — recaptcha-v3 (score-based; pass state not observable)
  // waitedMs covers the appearance grace + resolve wait; the whole call
  // is bounded by ~timeoutMs. Detection + waiting ONLY: this method
  // never clicks, types into, or solves a challenge (see the probe
  // script's comment block for the --fp caveat).
  async challenge(opts = {}) {
    const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 30000));
    const pollMs = Math.min(2000, Math.max(100, Number(opts.pollMs ?? 500)));
    const appearMs = Math.max(0, Number(opts.appearMs ?? 3000));
    const wait = opts.wait !== false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const probe = async () => {
      try { return await this.evaluate(CHALLENGE_PROBE_SCRIPT); }
      catch { return null; } // navigation in flight — "unknown", keep polling
    };
    const started = Date.now();
    // Appearance grace: widgets inject a beat after load, so when the
    // first probes find nothing, keep looking for up to appearMs before
    // reporting "no challenge".
    let first = await probe();
    while (wait && (!first || !first.challenges || !first.challenges.length) && Date.now() - started < appearMs) {
      await sleep(pollMs);
      first = await probe();
    }
    if (!first || !first.challenges || !first.challenges.length) {
      return { detected: false, type: null, passed: false, waitedMs: Date.now() - started, url: first ? first.url : null };
    }
    const type = first.challenges[0].type;
    const startUrl = first.url;
    if (first.challenges[0].passive) {
      return { detected: true, type, passed: null, waitedMs: Date.now() - started, url: startUrl };
    }
    const resolved = (p) => {
      if (!p) return false;
      if (type === 'cloudflare-challenge' && p.url !== startUrl) return true;
      if (!p.challenges || !p.challenges.length) return true;
      const still = p.challenges.find((c) => c.type === type);
      if (!still) return true;
      return !!still.token;
    };
    if (resolved(first) || !wait) {
      return { detected: true, type, passed: resolved(first), waitedMs: Date.now() - started, url: startUrl };
    }
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        const last = await probe();
        return { detected: true, type, passed: resolved(last), waitedMs: elapsed, url: last ? last.url : startUrl };
      }
      await sleep(pollMs);
      const p = await probe();
      if (p && resolved(p)) {
        return { detected: true, type, passed: true, waitedMs: Date.now() - started, url: p.url };
      }
    }
  }
  // --- Async event signals (2026-11-27) ---
  // drainEvents(): curated async signals since THIS page's last drain,
  // merged in time order:
  //   {kind:'popup', targetId, url, via:'target'}        — a page opened
  //     a popup tab (browser-level Target.targetCreated, openerId set)
  //   {kind:'tab_closed', targetId, via:'target'}        — a popup tab
  //     or one of our own pages was destroyed
  //   {kind:'dialog', dialogType, message}               — a JS dialog
  //     opened on this page (it blocks until handled via Page.* CDP)
  //   {kind:'download_started'|'download_completed'|'download_canceled',
  //     guid, url, filename, state, received, total}     — download
  //     lifecycle; browser-level entries (no session) are reported to
  //     every page, session entries only to their owning page
  // The raw CDP stream stays available via events(); this is the
  // semantic layer on top (the harness reports popup/download/
  // tab-close to the agent instead of making it poll for them).
  async drainEvents() {
    const out = [];
    const s = sessions.get(this.sessionId);
    if (s && s.signals) out.push(...s.signals.splice(0));
    for (let i = this._sigCursor; i < browserSignals.length; i++) {
      const sig = browserSignals[i];
      out.push({ t: sig.t, kind: sig.kind, targetId: sig.targetId, url: sig.url, via: 'target' });
    }
    this._sigCursor = browserSignals.length;
    for (let i = this._dlCursor; i < downloadLog.length; i++) {
      const d = downloadLog[i];
      if (!d.sessionId || d.sessionId === this.sessionId) {
        out.push({ t: d.t, kind: d.kind, guid: d.guid, url: d.url, filename: d.filename, state: d.state, received: d.received, total: d.total });
      }
    }
    this._dlCursor = downloadLog.length;
    out.sort((a, b) => (a.t || 0) - (b.t || 0));
    return out;
  }
  // waitForEvent(kind, {timeoutMs=15000}) -> the first drained signal
  // of that kind, or null on timeout. NOTE: it drains — signals of
  // other kinds seen while waiting are consumed. Use drainEvents()
  // when you need the whole stream.
  async waitForEvent(kind, opts = {}) {
    const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 15000));
    const started = Date.now();
    for (;;) {
      const evs = await this.drainEvents();
      const hit = evs.find(e => e.kind === kind);
      if (hit) return hit;
      if (Date.now() - started >= timeoutMs) return null;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  // --- Downloads (2026-11-27) ---
  // Download behavior is armed once per daemon (allow + the state
  // downloads dir) from newPage, so a click that starts a download is
  // recorded even if waitForDownload() is only called afterwards.
  async _ensureDownloadBehavior() {
    if (dlBehaviorSet) return;
    dlBehaviorSet = true; // optimistic: blocks re-entry while the CDP call is in flight
    try {
      mkdirSync(DL_DIR, { recursive: true });
      await cdpSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
    } catch (e) { dlBehaviorSet = false; throw e; }
  }
  // downloads(): every download this daemon has seen, oldest first.
  downloads() {
    return [...downloads.values()].map(d => ({
      guid: d.guid, url: d.url, filename: d.filename, state: d.state,
      received: d.received, total: d.total, startedAt: d.startedAt,
    }));
  }
  // waitForDownload({timeoutMs=30000, filename?, url?}):
  //   completed -> {completed:true, path, bytes, filename, url, guid, state}
  //     (path = file under the state downloads dir; bytes = on-disk size)
  //   canceled  -> {completed:false, state:'canceled', filename, url, guid}
  //   timeout   -> {completed:false, state:'timeout', pending:[...]}
  // A report object instead of an exception, so the caller decides
  // what to do next. Downloads that began up to 5s before the call
  // count (the usual click-then-wait pattern).
  async waitForDownload(opts = {}) {
    await this._ensureDownloadBehavior();
    const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 30000));
    const started = Date.now();
    const match = (d) => (!opts.filename || d.filename === opts.filename)
      && (!opts.url || d.url === opts.url)
      && d.startedAt >= started - 5000;
    for (;;) {
      for (const d of downloads.values()) {
        if (!match(d)) continue;
        if (d.state === 'completed') {
          const path = resolveDownloadPath(d.filename);
          let bytes = d.received || 0;
          if (path) { try { bytes = statSync(path).size; } catch {} }
          return { completed: true, guid: d.guid, url: d.url, filename: d.filename, path, bytes, state: d.state };
        }
        if (d.state === 'canceled') {
          return { completed: false, guid: d.guid, url: d.url, filename: d.filename, state: 'canceled' };
        }
      }
      if (Date.now() - started >= timeoutMs) {
        const pending = [...downloads.values()].filter(match)
          .map(d => ({ guid: d.guid, filename: d.filename, state: d.state, received: d.received, total: d.total }));
        return { completed: false, state: 'timeout', pending };
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  // --- Session fetch + bounded API fallback (2026-11-27) ---
  // fetchInPage(pathOrUrl, opts): fetch from INSIDE the page, so the
  // request carries the page's session (cookies) — the route for
  // recovering files/data that L0 fetch.sh (no browser cookies) cannot
  // reach (a cookie-carrying in-page fetch). SAME-ORIGIN ONLY: the URL
  // resolves against the page URL and cross-origin targets are refused
  // before any request is made.
  // opts: { method='GET', headers, save, name, json }
  // Text/JSON returns inline (100k cap, truncated flag); binary or
  // save:true is written under the state downloads dir -> {savedTo,bytes}.
  async fetchInPage(pathOrUrl, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const r = await this.evaluate(async (a) => {
      const u = new URL(a.url, location.href);
      if (u.origin !== location.origin) {
        throw new Error('fetchInPage: cross-origin refused (' + u.origin + ' !== ' + location.origin + ') — same-origin only');
      }
      const resp = await fetch(u.href, { method: a.method, credentials: 'same-origin', headers: a.headers || {} });
      const ct = resp.headers.get('content-type') || '';
      const textual = /text|json|xml|html|javascript/.test(ct);
      if (!a.save && textual) {
        return { status: resp.status, url: resp.url, contentType: ct, text: await resp.text() };
      }
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return { status: resp.status, url: resp.url, contentType: ct, base64: btoa(bin) };
    }, { url: String(pathOrUrl), method, headers: opts.headers || {}, save: !!opts.save });
    if (!r) throw new Error('fetchInPage: page did not return a result');
    const out = { status: r.status, url: r.url, contentType: r.contentType };
    if (r.base64 !== undefined) {
      const buf = Buffer.from(r.base64, 'base64');
      mkdirSync(DL_DIR, { recursive: true });
      let name = opts.name || '';
      if (!name) { try { name = decodeURIComponent(new URL(r.url).pathname.split('/').filter(Boolean).pop() || ''); } catch {} }
      if (!name) name = 'fetch-' + Date.now();
      name = name.replace(/[\\/:*?"<>|]/g, '_');
      const path = join(DL_DIR, name);
      writeFileSync(path, buf);
      out.savedTo = path;
      out.bytes = buf.length;
      return out;
    }
    const text = r.text || '';
    if (opts.json) {
      try { out.json = JSON.parse(text); return out; } catch {}
    }
    if (text.length > 100000) { out.text = text.slice(0, 100000); out.truncated = true; }
    else out.text = text;
    return out;
  }
  // apiFallback(pathOrUrl, opts): the BOUNDED form of the
  // "reverse-engineer the site's internal API" move — read data from a
  // same-origin endpoint the page's own session can already reach
  // (typically one the page itself calls) when DOM extraction fails.
  // HARD BOUNDARY: this is a data-read fallback, NEVER an access-denial
  // workaround. On 401/403 it throws api_fallback_access_denied and the
  // caller must stop and follow the chain rules (report, switch exit) —
  // no retrying around the denial, no escalation. Same-origin + session
  // rules are inherited from fetchInPage.
  async apiFallback(pathOrUrl, opts = {}) {
    const r = await this.fetchInPage(pathOrUrl, { ...opts, json: opts.json !== false });
    if (r.status === 401 || r.status === 403) {
      throw new Error('api_fallback_access_denied: HTTP ' + r.status + ' for ' + r.url + ' — stop and report / switch exit per chain rules; do not work around an access denial');
    }
    return r;
  }
  // --- PDF + annotated screenshot (2026-11-27) ---
  // pdf(opts): Page.printToPDF -> state downloads dir. Returns {path, bytes}.
  async pdf(opts = {}) {
    const r = await this.cdp('Page.printToPDF', {
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
      paperWidth: Number(opts.paperWidth || 8.27),
      paperHeight: Number(opts.paperHeight || 11.69),
    });
    const buf = Buffer.from(r.data, 'base64');
    mkdirSync(DL_DIR, { recursive: true });
    const name = (opts.name || ('page-' + Date.now() + '.pdf')).replace(/[\\/:*?"<>|]/g, '_');
    const path = join(DL_DIR, name);
    writeFileSync(path, buf);
    return { path, bytes: buf.length };
  }
  // annotatedScreenshot(opts): screenshot with the elements() e-ids
  // drawn over the page as outline boxes + labels (the
  // annotatedScreenshot). The overlay is injected, captured, removed.
  // Returns {path, count, elements, bytes} (PNG in the downloads dir).
  async annotatedScreenshot(opts = {}) {
    const els = await this.elements();
    const drawn = await this.evaluate(() => {
      document.querySelectorAll('.__pu_anno').forEach(e => e.remove());
      let n = 0;
      document.querySelectorAll('[data-pu-id]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const box = document.createElement('div');
        box.className = '__pu_anno';
        box.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;border:2px solid #ff3355;box-sizing:border-box;left:' + (r.left + window.scrollX) + 'px;top:' + (r.top + window.scrollY) + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
        const tag = document.createElement('div');
        tag.textContent = el.getAttribute('data-pu-id');
        tag.style.cssText = 'position:absolute;left:-2px;top:-16px;background:#ff3355;color:#fff;font:11px/14px monospace;padding:0 3px;white-space:nowrap;';
        box.appendChild(tag);
        document.body.appendChild(box);
        n++;
      });
      return n;
    });
    try {
      const data = await this.screenshot();
      const buf = Buffer.from(data, 'base64');
      mkdirSync(DL_DIR, { recursive: true });
      const name = (opts.name || ('annotated-' + Date.now() + '.png')).replace(/[\\/:*?"<>|]/g, '_');
      const path = join(DL_DIR, name);
      writeFileSync(path, buf);
      return { path, count: drawn, elements: els.elements.length, bytes: buf.length };
    } finally {
      await this.evaluate(() => {
        document.querySelectorAll('.__pu_anno').forEach(e => e.remove());
      }).catch(() => {});
    }
  }
  async screenshot() {
    const r = await this.cdp('Page.captureScreenshot', { format: 'png' });
    return r.data;
  }
  async close() {
    try { await cdpSend('Target.closeTarget', { targetId: this.targetId }); } catch {}
    sessions.delete(this.sessionId);
    this.space.pages.delete(this.label);
  }
}

// ---------------------------------------------------------------- Task spaces
let spaceSeq = 0;
const spaces = new Map(); // name -> space
class PUSpace {
  constructor(name) {
    this.id = ++spaceSeq; this.name = name; this.pages = new Map();
    this.contextId = null; this.finished = false; this.pageSeq = 0;
  }
  async newPage(label) {
    await ensureChrome();
    if (EPHEMERAL && !this.contextId) {
      const r = await cdpSend('Target.createBrowserContext', {});
      this.contextId = r.browserContextId;
    }
    const { targetId } = await cdpSend('Target.createTarget', {
      url: 'about:blank', ...(this.contextId ? { browserContextId: this.contextId } : {}),
    });
    const { sessionId } = await cdpSend('Target.attachToTarget', { targetId, flatten: true });
    sessions.set(sessionId, { targetId, events: [], loadWaiters: [], signals: [] });
    const page = new PUPage(this, targetId, sessionId, label || ('p' + (++this.pageSeq)));
    this.pages.set(page.label, page);
    try { await page.cdp('Page.enable', {}); } catch {}
    // Arm download capture daemon-wide from the first page, so a click
    // that starts a download is recorded even before waitForDownload().
    try { await page._ensureDownloadBehavior(); } catch {}
    return page;
  }
  // acquirePage(label): reuse one warm tab per purpose instead of opening a
  // new target for every call (2026-11-27).
  //
  // Measured problem: `run.sh read` created a target, used it and closed it,
  // and Chromium kept the closed tab's renderer process alive as a spare.
  // Each read therefore added ~12 threads and one renderer process; at
  // ulimit -u=256 the daemon died with "pthread_create: Resource temporarily
  // unavailable" after 5-6 reads. Reusing the tab keeps the tree flat:
  // 10 reads in a row now hold steady instead of climbing.
  //
  // A tab that is already busy (two scripts at once) is never shared: the
  // caller gets a second tab with a timestamped label, so parallel calls still
  // work. finish({keep:[page]}) releases the tab for the next call.
  async acquirePage(label = 'main') {
    const key = String(label || 'main');
    const ready = async (pg) => {
      pg.busy = true;
      // Leave no dialog or half-finished navigation behind for this call.
      try { await pg.cdp('Page.handleJavaScriptDialog', { accept: false }); } catch {}
      try { await pg.cdp('Page.stopLoading'); } catch {}
      return pg;
    };
    const cur = this.pages.get(key);
    if (cur && !cur.busy) return ready(cur);
    // A parallel call may have left its own tab for the same purpose
    // ("read-<ts>"): reuse it instead of opening a third one.
    for (const pg of this.pages.values()) {
      if (!pg.busy && pg.label.startsWith(key)) return ready(pg);
    }
    const p = await this.newPage(cur ? key + '-' + Date.now() : key);
    p.busy = true;
    return p;
  }
  async page(label) {
    if (label && this.pages.has(label)) return this.pages.get(label);
    return this.newPage(label);
  }
  async pages() { return [...this.pages.values()]; }
  async finish({ keep = [] } = {}) {
    const keepSet = new Set(keep.map(k => (k && k.label) || k));
    for (const p of [...this.pages.values()]) {
      if (keepSet.has(p.label) || keepSet.has(p)) { p.busy = false; continue; }
      // A page another call is using must survive this call: with a shared
      // task space, closing it killed a concurrent read mid-flight
      // (measured 2026-11-27 — two `run.sh read` at once deadlocked).
      if (p.busy) continue;
      await p.close();
    }
    if (this.pages.size === 0) {
      this.finished = true;
      spaces.delete(this.name);
      if (this.contextId) { try { await cdpSend('Target.disposeBrowserContext', { browserContextId: this.contextId }); } catch {} this.contextId = null; }
    }
  }
}
async function taskSpace(name) {
  const key = String(name);
  if (spaces.has(key) && !spaces.get(key).finished) return spaces.get(key);
  const s = new PUSpace(key);
  spaces.set(key, s);
  return s;
}
async function claimTaskSpace(idOrName) {
  const key = String(idOrName);
  for (const s of spaces.values()) if (String(s.id) === key || s.name === key) return s;
  return taskSpace(key);
}

// ---------------------------------------------------------------- Script runner
function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return util.inspect(a, { depth: 4, maxArrayLength: 50 }); } catch { return String(a); }
}

async function runScript(code, emit) {
  const con = {
    log: (...a) => emit('out', a.map(formatArg).join(' ') + '\n'),
    info: (...a) => emit('out', a.map(formatArg).join(' ') + '\n'),
    warn: (...a) => emit('err', a.map(formatArg).join(' ') + '\n'),
    error: (...a) => emit('err', a.map(formatArg).join(' ') + '\n'),
  };
  const fn = new AsyncFunction('taskSpace', 'claimTaskSpace', 'console', code);
  await fn(taskSpace, claimTaskSpace, con);
}

// ---------------------------------------------------------------- Socket server
try { rmSync(SOCK, { force: true }); } catch {}
const server = createServer(sock => {
  let buf = '';
  let handled = false;
  sock.on('data', async chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0 || handled) return;
    handled = true;
    let msg;
    try { msg = JSON.parse(buf.slice(0, nl)); } catch { sock.end(); return; }
    // A run message carries the script in a follow-up frame if it is large:
    // the client sends {type:"run", scriptLen} then raw bytes. Simpler path:
    // script is inline in the JSON (JSON-escaped) — handled here directly.
    const emit = (type, text) => { try { sock.write(JSON.stringify({ type, text }) + '\n'); } catch {} };
    const done = code => { try { sock.write(JSON.stringify({ type: 'done', code }) + '\n'); sock.end(); } catch {} };
    try {
      if (msg.type === 'run') {
        await runScript(msg.script || '', emit);
        done(0);
      } else if (msg.type === 'status') {
        emit('out', JSON.stringify({
          daemon: 'up', pid: process.pid, chrome: chromeProc ? 'up' : 'down',
          port: chromePort, profile: PROFILE,
          spaces: [...spaces.values()].map(s => ({ id: s.id, name: s.name, pages: s.pages.size })),
        }) + '\n');
        done(0);
      } else if (msg.type === 'stop') {
        done(0);
        shutdown();
      } else { done(1); }
    } catch (e) {
      emit('err', 'cdp-daemon: ' + String(e && e.stack || e).slice(0, 2000) + '\n');
      done(1);
    }
  });
  sock.on('error', () => {});
});

function shutdown() {
  // 2026-11-27 (pickle build): SIGKILL killed Chrome before it flushed cookies,
  // so the persistent profile did not carry a session across daemon restarts
  // (measured: document.cookie empty after stop+start). Send SIGTERM first and
  // give Chrome 1.5s to write its profile, then force-kill as a fallback.
  const cp = chromeProc;
  try { if (cp) cp.kill('SIGTERM'); } catch {}
  try { rmSync(SOCK, { force: true }); rmSync(PIDFILE, { force: true }); } catch {}
  server.close(() => {});
  setTimeout(() => { try { if (cp) cp.kill('SIGKILL'); } catch {} process.exit(0); }, 1500).unref();
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(SOCK, () => {
  // Chrome launches lazily on the first page request; warm-up calls trigger
  // it through taskSpace/newPage. Nothing to do here.
  // The socket runs any JS the caller sends, as this user: it must never be
  // reachable by another local account (it was created 0755 / srwxr-xr-x).
  try { chmodSync(SOCK, 0o600); } catch {}
});
