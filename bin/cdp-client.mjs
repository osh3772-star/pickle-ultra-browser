#!/usr/bin/env node
// cdp-client.mjs — Pickle Ultra Browser raw-CDP client (companion to cdp-daemon.mjs).
// Drop-in for the earlier client invocation:
//   node cdp-client.mjs < script.js     run a script in the daemon
//   node cdp-client.mjs --status        daemon status (JSON)
//   node cdp-client.mjs --stop          stop daemon (+ its Chrome)
// Auto-starts the daemon on first use. Connection failures are reported with
// the strings run.sh's retry greps for ("daemon.sock" / "ECONNREFUSED").
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = process.env.PICKLE_ULTRA_STATE_DIR || join(homedir(), '.local', 'share', 'pickle-ultra-browser');
const SOCK = join(STATE_DIR, 'cdp-daemon.sock');
const HERE = new URL('.', import.meta.url).pathname;
const DAEMON = join(HERE, 'cdp-daemon.mjs');
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
  // Spawn the daemon detached with THIS process's environment (the old
  // harness had the same semantics: scripts see the daemon-start env).
  // STATE_DIR must exist before opening the log file — on a fresh install
  // it does not, and openSync throws ENOENT before the daemon (which would
  // create the dir itself) ever starts. Bug found 2026-11-26.
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
  if (!haveLock) throw new Error('cdp-client: daemon start lock still held after 20s — another client is starting it');
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
    throw new Error('cdp-client: cannot connect to daemon.sock (ECONNREFUSED) — daemon did not start; see cdp-daemon.log');
  } finally {
    try { rmSync(START_LOCK, { recursive: true, force: true }); } catch {}
  }
}

async function sendAndStream(msg) {
  const sock = await tryConnect().catch(() => null);
  if (!sock) throw new Error('cdp-client: connect daemon.sock failed (ECONNREFUSED)');
  return new Promise((resolve, reject) => {
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
        else if (m.type === 'done') { sock.end(); resolve(m.code); }
      }
    });
    sock.on('error', reject);
    sock.write(JSON.stringify(msg) + '\n');
  });
}

const mode = process.argv[2] || '';
try {
  if (mode === '--stop') {
    if (!existsSync(SOCK)) { process.exit(0); }
    const s = await tryConnect().catch(() => null);
    if (!s) process.exit(0);
    s.write(JSON.stringify({ type: 'stop' }) + '\n');
    s.on('data', () => {});
    s.on('close', () => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  } else if (mode === '--status') {
    if (!existsSync(SOCK)) { console.log(JSON.stringify({ daemon: 'down' })); process.exit(0); }
    await ensureDaemon().catch(() => {});
    const code = await sendAndStream({ type: 'status' }).catch(() => { console.log(JSON.stringify({ daemon: 'down' })); return 0; });
    process.exit(code);
  } else {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const script = Buffer.concat(chunks).toString('utf8');
    await ensureDaemon();
    const code = await sendAndStream({ type: 'run', script });
    process.exit(code);
  }
} catch (e) {
  console.error('cdp-client: ' + String(e && e.message || e));
  process.exit(1);
}
