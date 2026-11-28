#!/usr/bin/env node
// plan-replay.mjs — Verified Plan Replay runner (Pickle Ultra Browser)
//
// Reads a site skill (`skills/<skill-id>/skill.json` + `plan.json`) and replays
// its steps inside ONE daemon, ONE Chrome session and ONE tab, after checking
// the plan's Origin, path allowlist and read-only class. It prints a single
// JSON object and exits 0 only when the run and its postconditions held.
//
//   node bin/plan-replay.mjs <skill-id|skill-dir> [--out FILE] [--no-login]
//                            [--skills-dir DIR] [--max-bytes N] [--quiet]
//   node bin/plan-replay.mjs --list
//   node bin/plan-replay.mjs --help
//
// Design (the lightweight form of ULTRABROWSE_NEXT_ARCHITECTURE ch.7–8):
//  - The plan is data (plan.json); site knowledge is a parser (extractors.mjs).
//    This runner knows no site.
//  - Only three ops exist: goto / auth_check / fetch_extract.
//  - Read-only (riskClass=READ_ONLY) only. Every step URL must be the plan's
//    Origin and an allowlisted path, checked BEFORE Chrome is opened.
//  - Credentials never enter this process: login is a vault-login.mjs child.
//  - Output is one contracted JSON line: per-step results + postconditions
//    + elapsedMs + toolCalls=1.
//
// skill.json fields used: skillId, origins[], riskClass, scope{paths,methods},
// auth{loginUrl, sessionSignal, selectors, vaultSite}, plan, extractors.
// plan.json fields used: planId, origin, riskClass, parameters, steps[],
// postconditions[].
import { connect } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOOLS = process.env.PU_TOOLS || join(ROOT, '.tools');
const STATE = process.env.PICKLE_ULTRA_STATE_DIR || join(ROOT, '.state');
const SOCK = join(STATE, 'cdp-daemon.sock');
const DAEMON = join(HERE, 'cdp-daemon.mjs');
const SKILLS = process.env.PICKLE_ULTRA_SKILLS_DIR || join(ROOT, 'skills');
const SPACE = 'plan-replay';
const T0 = Date.now();

const USAGE = `plan-replay — replay a site skill's plan.json in one browser session

usage:
  node bin/plan-replay.mjs <skill-id | skill-dir> [options]
  node bin/plan-replay.mjs --list
  node bin/plan-replay.mjs --help

options:
  --out FILE        also write the result JSON to FILE (pretty, 1-space indent)
  --no-login        never run vault-login; fail if the session is not alive
  --skills-dir DIR  where <skill-id> folders live (default: $PICKLE_ULTRA_SKILLS_DIR or ./skills)
  --max-bytes N     cap the result JSON size by dropping extracted payloads
                    once it would exceed N bytes (default: 262144)
  --quiet           no per-step notes on stderr

A skill folder holds skill.json, plan.json (or the file named by skill.plan)
and extractors.mjs (or skill.extractors). The runner refuses a plan whose
origin, paths or riskClass fall outside the skill's declaration before it
opens the browser. Login values come from the agent vault through
bin/vault-login.mjs; they never reach this process.`;

// ---- env for a daemon we may have to start (same semantics as run.sh/pu-config.sh)
process.env.PICKLE_ULTRA_STATE_DIR = STATE;
process.env.PICKLE_ULTRA_PROFILE = process.env.PICKLE_ULTRA_PROFILE || join(STATE, 'profile');
process.env.CHROME_PATH = process.env.CHROME_PATH || join(HERE, 'chrome-wrapper.sh');
process.env.PICKLE_ULTRA_HEADLESS = process.env.PICKLE_ULTRA_HEADLESS || '1';
process.env.TMPDIR = process.env.TMPDIR || join(ROOT, '.tmp');
mkdirSync(process.env.TMPDIR, { recursive: true });
const depsLib = join(TOOLS, 'chrome-deps', 'lib');
if (existsSync(depsLib)) {
  process.env.LD_LIBRARY_PATH = depsLib + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowKST = () => {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};
const json = (v) => JSON.stringify(v);

class CliError extends Error {
  constructor(message, hint = '') { super(message); this.hint = hint; }
}

// ---- args
function parseArgs() {
  const argv = process.argv.slice(2);
  const opt = { target: null, out: null, noLogin: false, list: false, help: false, quiet: false, skillsDir: SKILLS, maxBytes: 262144 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} needs a value`, 'see --help');
      return v;
    };
    if (a === '--help' || a === '-h') opt.help = true;
    else if (a === '--list') opt.list = true;
    else if (a === '--out') opt.out = value();
    else if (a === '--skills-dir') opt.skillsDir = value();
    else if (a === '--max-bytes') {
      const n = Number(value());
      if (!Number.isFinite(n) || n < 1024) throw new CliError('--max-bytes needs a number >= 1024', 'see --help');
      opt.maxBytes = n;
    } else if (a === '--no-login') opt.noLogin = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a.startsWith('-')) throw new CliError(`unknown option: ${a}`, 'see --help');
    else if (opt.target === null) opt.target = a;
    else throw new CliError(`unexpected argument: ${a}`, 'one skill per run; see --help');
  }
  return opt;
}

let opt;
try { opt = parseArgs(); } catch (e) { dieUsage(e); }

if (opt.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
if (opt.list) {
  const dir = resolve(opt.skillsDir);
  if (!existsSync(dir)) { process.stdout.write('(no skills directory: ' + dir + ')\n'); process.exit(0); }
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'skill.json');
    if (!existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      rows.push(`${name}\t${s.skillId || '-'}\t${(s.origins || []).join(',') || '-'}`);
    } catch { rows.push(`${name}\t(invalid skill.json)`); }
  }
  process.stdout.write(rows.length ? rows.join('\n') + '\n' : `(no skills in ${dir})\n`);
  process.exit(0);
}
if (!opt.target) dieUsage(new CliError('no skill given', 'node bin/plan-replay.mjs <skill-id | skill-dir> [--out FILE]'));

function dieUsage(e) {
  process.stderr.write(`plan-replay: ${e.message}\n` + (e.hint ? `  hint: ${e.hint}\n` : ''));
  process.exit(2);
}

// ---- resolve + load the skill
function resolveSkillDir(target) {
  const direct = resolve(target);
  if (existsSync(join(direct, 'skill.json'))) return direct;
  const skillsDir = resolve(opt.skillsDir);
  const byId = join(skillsDir, target);
  if (existsSync(join(byId, 'skill.json'))) return byId;
  let available = '';
  if (existsSync(skillsDir)) {
    const names = readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, 'skill.json')));
    available = names.length ? `\n  available: ${names.join(', ')}` : '';
  }
  throw new CliError(`no skill.json for "${target}"`, `looked in ${direct} and ${byId}${available}\n  a skill folder needs skill.json (+ plan.json, extractors.mjs)`);
}

function loadJson(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new CliError(`${label} not found: ${file}`, 'a skill folder needs skill.json and its plan file');
    throw new CliError(`${label} unreadable: ${file} (${e && e.message})`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new CliError(`${label} is not valid JSON: ${file}`, String(e && e.message).slice(0, 160)); }
}

let skillDir, skill, plan;
try {
  skillDir = resolveSkillDir(opt.target);
  skill = loadJson(join(skillDir, 'skill.json'), 'skill.json');
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new CliError('skill.json must be a JSON object');
  const planName = typeof skill.plan === 'string' && skill.plan ? skill.plan : 'plan.json';
  plan = loadJson(join(skillDir, planName), planName);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new CliError(`${planName} must be a JSON object`);
} catch (e) { dieUsage(e); }

// ---- daemon socket (one run per connection, as the daemon serves it)
function tryConnect() {
  return new Promise((res, rej) => {
    const s = connect(SOCK);
    s.once('connect', () => res(s));
    s.once('error', rej);
  });
}
let daemonStarted = null; // 1: this run started the daemon, 0: it reused a running one
async function ensureDaemon() {
  try { const s = await tryConnect(); s.destroy(); if (daemonStarted === null) daemonStarted = 0; return; } catch {}
  mkdirSync(STATE, { recursive: true });
  const logFd = openSync(join(STATE, 'cdp-daemon.log'), 'a');
  const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
  child.unref();
  daemonStarted = 1;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { const s = await tryConnect(); s.destroy(); return; } catch {}
  }
  throw new Error('cdp-daemon did not come up (see ' + join(STATE, 'cdp-daemon.log') + ')');
}
let daemonRuns = 0;
async function runInDaemon(script) {
  const sock = await tryConnect().catch(() => null);
  if (!sock) throw new Error('cannot connect to ' + SOCK);
  daemonRuns += 1;
  return new Promise((resolvePromise, reject) => {
    let buf = '', out = '', err = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'out') out += m.text;
        else if (m.type === 'err') err += m.text;
        else if (m.type === 'done') { sock.end(); resolvePromise({ code: m.code, out, err }); }
      }
    });
    sock.on('error', reject);
    sock.write(JSON.stringify({ type: 'run', script }) + '\n');
  });
}

// Page handle snippet (every script reuses the same tab → one session, one page)
const PAGE = `const space = await claimTaskSpace(${json(SPACE)});\nconst p = await space.page('main');\n`;

// ---- plan validation: Origin · path allowlist · read-only · ops
const OPS = new Set(['goto', 'auth_check', 'fetch_extract']);
function validatePlan() {
  const errors = [];
  const notes = [];
  if (typeof plan.planId !== 'string' || !plan.planId) errors.push('plan_id_missing');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) errors.push('steps_missing');
  const steps = Array.isArray(plan.steps) ? plan.steps : [];

  const origins = Array.isArray(skill.origins) ? skill.origins.filter((o) => typeof o === 'string') : [];
  if (!origins.length) errors.push('skill_origins_missing');
  if (typeof plan.origin !== 'string' || !plan.origin) errors.push('plan_origin_missing');
  else if (plan.origin !== origins[0]) errors.push('origin_mismatch');
  if ((plan.riskClass || '') !== 'READ_ONLY' || (skill.riskClass || '') !== 'READ_ONLY') errors.push('risk_class_not_read_only');

  const methods = Array.isArray(skill.scope?.methods) && skill.scope.methods.length ? skill.scope.methods : ['GET'];
  if (!methods.includes('GET')) errors.push('method_not_allowed');
  if (skill.scope?.writes === true) errors.push('skill_declares_writes');

  const allowed = new Set(Array.isArray(skill.scope?.paths) ? skill.scope.paths : []);
  const origin = plan.origin;
  let originUrl = null;
  try { originUrl = new URL(origin); } catch { errors.push('bad_origin:' + origin); }
  const checkUrl = (raw) => {
    let u;
    try { u = new URL(raw, origin); } catch { errors.push('bad_url:' + String(raw).slice(0, 120)); return null; }
    if (!originUrl || u.origin !== originUrl.origin) errors.push('cross_origin:' + u.href);
    if (!allowed.has(u.pathname)) errors.push('path_not_allowlisted:' + u.pathname);
    return u.href;
  };

  // plan.parameters values may be bound into step URLs as {name}. A step with
  // "foreach": "<key>" repeats once per item of an array parameter, binding the
  // item's own fields (and {id}); the item id labels the result.
  const parameters = plan.parameters && typeof plan.parameters === 'object' ? plan.parameters : {};
  const params = { ...parameters };
  for (const [k, val] of Object.entries(parameters)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) params[k] = val.id ?? val.name ?? '';
  }
  const fill = (t, extra = {}) => String(t).replace(/\{(\w+)\}/g, (_, k) => {
    const val = extra[k] !== undefined ? extra[k] : params[k];
    return val === undefined || val === null ? '' : String(val);
  });
  const expand = (s) => {
    if (s.foreach === undefined) return [{ targets: [{ id: s.id, url: checkUrl(fill(s.url)) }] }];
    const items = parameters[s.foreach];
    if (!Array.isArray(items)) throw new Error('foreach_unknown_parameter:' + s.foreach);
    if (!items.length) throw new Error('foreach_empty:' + s.foreach);
    return items.map((it) => {
      const extra = (it && typeof it === 'object') ? it : { id: it };
      const id = extra.id !== undefined ? extra.id : extra.name;
      return { targets: [{ id: id === undefined ? null : String(id), url: checkUrl(fill(s.url, extra)) }] };
    });
  };

  // Pre-flight: expand every step URL once and check it before any browser work.
  // (Checking only at execution time would be a post-hoc check, not a gate.)
  const ids = new Set();
  let seenGoto = false;
  for (const [i, s] of steps.entries()) {
    if (!s || typeof s !== 'object') { errors.push(`step_${i}_invalid`); continue; }
    if (typeof s.id !== 'string' || !s.id) errors.push(`step_${i}_id_missing`);
    else if (ids.has(s.id)) errors.push('duplicate_step_id:' + s.id);
    else ids.add(s.id);
    if (!OPS.has(s.op)) { errors.push(`step_${s.id || i}_unknown_op:${s.op}`); continue; }
    if (s.op === 'goto') seenGoto = true;
    if (s.op === 'fetch_extract') {
      if (typeof s.extractor !== 'string' || !s.extractor) errors.push(`step_${s.id}_extractor_missing`);
      if (typeof s.url !== 'string' || !s.url) errors.push(`step_${s.id}_url_missing`);
      // Fetches run in the shared tab's session, so the tab must already be on
      // the origin; otherwise fetch() has no same-origin context to use.
      if (!seenGoto) errors.push(`step_${s.id}_fetch_without_prior_goto`);
    }
    if (s.op === 'goto' && (typeof s.url !== 'string' || !s.url)) errors.push(`step_${s.id}_url_missing`);
    if (s.op === 'auth_check' && s.signal !== undefined && s.signal !== 'session') errors.push(`step_${s.id}_unknown_signal:${s.signal}`);
    if (s.op !== 'goto' && s.op !== 'fetch_extract') continue;
    try { expand(s); } catch (e) { errors.push(String(e.message || e)); }
  }

  const loginUrl = skill.auth?.loginUrl;
  if (steps.some((s) => s.op === 'auth_check')) {
    if (!loginUrl) errors.push('auth_login_url_missing');
    else checkUrl(loginUrl);
  }

  const postTypes = new Set(['session_alive', 'no_secret_output', 'all_steps_ok']);
  if (plan.postconditions !== undefined && !Array.isArray(plan.postconditions)) errors.push('postconditions_not_an_array');
  for (const pc of Array.isArray(plan.postconditions) ? plan.postconditions : []) {
    if (!pc || !postTypes.has(pc.type)) errors.push('unknown_postcondition:' + (pc && pc.type));
  }

  notes.push(`skill=${skill.skillId || '-'}, steps=${steps.length}, paths=${allowed.size}, parameters=${Object.keys(parameters).length}`);
  return { errors: [...new Set(errors)], notes, params, expand };
}

function finish(result) {
  let payload = { ...result, outputBytes: 0 };
  let text = JSON.stringify({ ...payload, outputBytes: 0 });
  const cap = opt.maxBytes || 262144;
  if (Buffer.byteLength(text) > cap && payload.results) {
    // Keep the shape, drop the payloads: a caller that needs the full extract
    // should narrow the plan or raise --max-bytes.
    const dropped = Buffer.byteLength(text);
    for (const key of Object.keys(payload.results)) {
      for (const item of payload.results[key] || []) {
        if (item && item.data !== undefined) { item.data = { truncated: true }; item.truncated = true; }
      }
    }
    payload.outputTruncated = true;
    payload.droppedBytes = dropped;
    text = JSON.stringify({ ...payload, outputBytes: 0 });
  }
  payload.outputBytes = Buffer.byteLength(text);
  text = JSON.stringify(payload);
  if (opt.out) {
    mkdirSync(dirname(resolve(opt.out)), { recursive: true });
    writeFileSync(resolve(opt.out), JSON.stringify(payload, null, 1) + '\n');
  }
  process.stdout.write(text + '\n');
  process.exit(payload.ok ? 0 : 1);
}

function fail(failure, extra) {
  return finish({ ok: false, failure, asOf: nowKST(), plan: planMeta(), ...extra });
}
function planMeta() {
  return { id: plan?.planId, skill: plan?.skillId || skill?.skillId, origin: plan?.origin, risk: plan?.riskClass };
}

async function loadExtractors() {
  const file = join(skillDir, skill.extractors || 'extractors.mjs');
  if (!existsSync(file)) throw new Error('extractors file not found: ' + file);
  return import('file://' + file);
}

function doLogin(login) {
  const runner = join(HERE, 'vault-login.mjs');
  const sel = skill.auth?.selectors || {};
  const loginUrl = new URL(login.url || skill.auth.loginUrl, plan.origin).href;
  const vaultSite = login.vaultSite || skill.auth.vaultSite;
  const args = [runner, loginUrl, vaultSite];
  if (sel.username) args.push('--id-sel', sel.username);
  if (sel.password) args.push('--pw-sel', sel.password);
  if (sel.submit) args.push('--submit-sel', sel.submit);
  return new Promise((res) => {
    execFile(process.execPath, args, { cwd: ROOT, env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // vault-login's own verdict is not trusted here: the session signal below
      // decides (its report of a dashboard as login_failed was a 2026-11-28
      // observation). Keep a short note when the child said something useful.
      let reported = null;
      try { const lines = String(stdout || '').trim().split('\n'); reported = JSON.parse(lines[lines.length - 1] || '{}'); } catch {}
      res({ ok: !err, status: reported?.status || null, report: err ? { error: String(err.message || err).slice(0, 200) } : null });
    });
  });
}

async function checkSessionSignal() {
  const signal = skill.auth?.sessionSignal || 'a[href*="logout"], a[href*="login/logout"]';
  const r = await runInDaemon(`${PAGE}
const ok = await p.evaluate(async (sel) => {
  const html = await (await fetch('/', { credentials: 'same-origin' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return !!doc.querySelector(sel);
}, ${json(signal)});
console.log(JSON.stringify({ loggedIn: ok }));`);
  if (r.code !== 0) throw new Error('session signal check failed: ' + (r.err || '').trim().slice(0, 200));
  return JSON.parse(r.out.trim().split('\n').pop() || '{}').loggedIn === true;
}

// ---- daemon page code for one step (shared by goto and fetch_extract)
async function stepGoto(step) {
  const url = new URL(step.url, plan.origin).href;
  const r = await runInDaemon(`${PAGE}
await p.goto(${json(url)}).catch(() => {});
const t0 = Date.now();
let st = await p.evaluate(() => ({ url: location.href, title: document.title }));
while ((!st.url || st.url === 'about:blank') && Date.now() - t0 < 8000) {
  await new Promise(r => setTimeout(r, 200));
  st = await p.evaluate(() => ({ url: location.href, title: document.title }));
}
console.log(JSON.stringify(st));`);
  if (r.code !== 0) throw new Error('daemon_error:' + (r.err || '').trim().slice(0, 200));
  return JSON.parse(r.out.trim().split('\n').pop() || '{}');
}

async function stepFetchExtract(step, params, expand, extractorSrc) {
  const fnSrc = extractorSrc[step.extractor];
  if (!fnSrc) throw new Error('extractor_not_found:' + step.extractor);
  const ctx = {};
  for (const [k, val] of Object.entries(step.params || {})) {
    ctx[k] = String(val).replace(/\{(\w+)\}/g, (_, key) => params[key]);
  }
  const targets = expand(step).flatMap((g) => g.targets);
  const conc = Math.max(1, Number(step.concurrency || 4));
  // One page-side evaluate per step. The extractor is inserted as a source
  // expression (never eval'd), and every fetched URL was allowlisted above.
  const pageCode = `(async () => {
const targets = ${json(targets)};
const ctx = ${json(ctx)};
const conc = ${conc};
const origin = ${json(new URL(plan.origin).origin)};
const extract = (${fnSrc});
const results = new Array(targets.length);
let cursor = 0;
const worker = async () => {
  while (cursor < targets.length) {
    const i = cursor++;
    const t = targets[i];
    try {
      const resp = await fetch(t.url, { credentials: 'same-origin' });
      const html = await resp.text();
      const finalOrigin = (() => { try { return new URL(resp.url).origin; } catch { return null; } })();
      results[i] = { id: t.id, status: resp.status, finalUrl: resp.url, bytes: html.length,
        data: extract(html, ctx),
        err: finalOrigin && finalOrigin !== origin ? 'redirected_origin:' + finalOrigin : null };
    } catch (e) {
      results[i] = { id: t.id, status: 0, finalUrl: t.url, bytes: 0, data: null, err: String((e && (e.stack || e.message)) || e).slice(0, 300) };
    }
  }
};
await Promise.all(Array.from({ length: Math.min(conc, targets.length) }, worker));
return results;
})()`;
  const r = await runInDaemon(`${PAGE}
const results = await p.evaluate(${json(pageCode)});
console.log(JSON.stringify(results));`);
  if (r.code !== 0) throw new Error('daemon_error:' + (r.err || r.out).trim().slice(0, 300));
  return JSON.parse(r.out.trim().split('\n').pop() || '[]');
}

async function main() {
  const v = validatePlan();
  if (v.errors.length) return fail('precondition_failed', { errors: v.errors });
  const { params, expand } = v;
  const needExtractors = plan.steps.some((s) => s.op === 'fetch_extract');
  let extractorSrc = {};
  if (needExtractors) {
    let mod;
    try { mod = await loadExtractors(); }
    catch (e) { return fail('extractors_load_failed', { error: String(e.message || e).slice(0, 300) }); }
    extractorSrc = Object.fromEntries(
      Object.entries(mod).filter(([, fn]) => typeof fn === 'function').map(([k, fn]) => [k, fn.toString()]),
    );
    const missing = plan.steps.filter((s) => s.op === 'fetch_extract' && !extractorSrc[s.extractor]).map((s) => s.extractor);
    if (missing.length) return fail('precondition_failed', { errors: [...new Set(missing)].map((m) => 'extractor_not_exported:' + m) });
  }

  await ensureDaemon();
  const steps = [];
  const data = {};
  const session = { reused: null, login: 'skipped', loginMs: 0 };
  let apparentOrigin = null;

  for (const step of plan.steps) {
    const started = Date.now();
    try {
      if (step.op === 'goto') {
        const st = await stepGoto(step);
        if (st.url) apparentOrigin = new URL(st.url).origin;
        if (apparentOrigin !== new URL(plan.origin).origin) throw new Error('origin_redirected:' + st.url);
        steps.push({ id: step.id, op: step.op, ms: Date.now() - started, url: st.url });
      } else if (step.op === 'auth_check') {
        let loggedIn = await checkSessionSignal();
        session.reused = loggedIn;
        if (!loggedIn && !opt.noLogin) {
          const loginStart = Date.now();
          const res = await doLogin(step.login || {});
          session.loginMs = Date.now() - loginStart;
          if (res.report) session.loginChild = res.report;
          loggedIn = await checkSessionSignal();
          session.login = loggedIn ? 'performed' : 'failed';
        }
        if (!loggedIn) throw new Error('not_authenticated (session signal absent' + (opt.noLogin ? '; --no-login given' : ' and vault login did not establish one') + ')');
        steps.push({ id: step.id, op: step.op, ms: Date.now() - started, loggedIn: true, login: session.login });
      } else if (step.op === 'fetch_extract') {
        const results = await stepFetchExtract(step, params, expand, extractorSrc);
        data[step.id] = results;
        steps.push({
          id: step.id, op: step.op, extractor: step.extractor, ms: Date.now() - started,
          targets: results.length, okTargets: results.filter((x) => x.status === 200 && !x.err).length,
          htmlBytes: results.reduce((a, b) => a + (b.bytes || 0), 0),
          ...(results.find((x) => x.err) ? { error: results.find((x) => x.err).err.slice(0, 300) } : {}),
        });
      } else {
        throw new Error('unknown_op:' + step.op);
      }
    } catch (e) {
      steps.push({ id: step.id, op: step.op, ms: Date.now() - started, error: String(e.message || e) });
      return finish({ ok: false, failure: 'replay_failed', failedStep: step.id, error: String(e.message || e), asOf: nowKST(), plan: planMeta(), steps, session, ...(Object.keys(data).length ? { results: data } : {}) });
    }
    if (!opt.quiet) process.stderr.write(`plan-replay: ${step.id} ${step.op} ${Date.now() - started}ms\n`);
  }

  let post = [];
  const allStepsOk = steps.every((s) => !s.error);
  for (const pc of plan.postconditions || []) {
    if (pc.type === 'session_alive') {
      let alive = false;
      try { alive = await checkSessionSignal(); } catch { alive = false; }
      post.push({ type: pc.type, ok: alive });
    } else if (pc.type === 'all_steps_ok') {
      post.push({ type: pc.type, ok: allStepsOk });
    } else if (pc.type === 'no_secret_output') {
      const text = JSON.stringify({ data, steps });
      const leaks = (text.match(/\t/g) || []).length + (/"password"\s*:/i.test(text) ? 1 : 0);
      post.push({ type: pc.type, ok: leaks === 0, detail: 'runner never holds vault values; login ran in child process' });
    }
  }

  const base = { asOf: nowKST(), session, steps, metrics: {} };
  const order = ['all_steps_ok', 'session_alive', 'no_secret_output'];
  post = post.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const ok = post.every((p) => p.ok) && allStepsOk;

  return finish({
    ok,
    plan: planMeta(),
    ...base,
    results: data,
    summary: { steps: steps.length, targets: steps.reduce((n, s) => n + (s.targets || 0), 0), okTargets: steps.reduce((n, s) => n + (s.okTargets || 0), 0), htmlBytes: steps.reduce((n, s) => n + (s.htmlBytes || 0), 0) },
    postconditions: post,
    metrics: {
      elapsedMs: Date.now() - T0, toolCalls: 1, daemonRuns,
      httpRequests: steps.filter((s) => s.op === 'fetch_extract').reduce((n, s) => n + (s.targets || 0), 0),
      htmlBytes: steps.reduce((n, s) => n + (s.htmlBytes || 0), 0),
      daemonStarted: daemonStarted === 1 ? 1 : 0, loginMs: session.loginMs,
    },
  });
}

try { await main(); }
catch (e) {
  process.stderr.write('plan-replay: ' + String(e && (e.stack || e.message) || e).slice(0, 500) + '\n');
  finish({ ok: false, failure: 'runner_error', error: String(e && e.message || e).slice(0, 300), asOf: nowKST(), plan: planMeta() });
}
