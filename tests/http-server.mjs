#!/usr/bin/env node
// http-server.mjs — fixture server for Pickle Ultra Browser tests.
//
// The old bin/selftest.sh fed `file://` URLs to the L0 lane and expected a
// verdict; curl returns status 000 for file://, so a perfectly normal local
// page was reported as F-NET and the "normal" case could never pass for the
// right reason. Every test now goes through HTTP, where the status code is
// real: 200/403/429/500, a JS-rendered shell, a login wall, a redirect.
//
//   node tests/http-server.mjs [--port 0] [--port-file PATH] [--fixtures DIR]
//
// Routes are listed in ROUTES below. Only localhost is bound. The process
// exits on SIGTERM/SIGINT; tests remove their temp files themselves.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('--port', process.env.PU_TEST_PORT || 0));
const PORT_FILE = opt('--port-file', '');
const FIX = opt('--fixtures', join(HERE, 'fixtures'));

const page = (name) => readFileSync(join(FIX, name), 'utf8');

// status, fixture, extra headers
const ROUTES = {
  '/':                { status: 200, file: 'normal.html' },
  '/normal':          { status: 200, file: 'normal.html' },
  '/normal-ko':       { status: 200, file: 'normal-ko.html' },
  '/forbidden':       { status: 403, file: 'block-403.html' },
  '/ratelimit':       { status: 429, file: 'block-429.html' },
  '/error':           { status: 500, file: 'error-500.html' },
  '/doc-403':         { status: 200, file: 'doc-403.html' },
  '/doc-403-ko':      { status: 200, file: 'doc-403-ko.html' },
  '/doc-403-ja':      { status: 200, file: 'doc-403-ja.html' },
  '/challenge':       { status: 200, file: 'challenge.html' },
  '/challenge-ja':    { status: 200, file: 'challenge-ja.html' },
  '/ko-block':        { status: 403, file: 'block-403-ko.html' },
  '/ja-block':        { status: 403, file: 'block-403-ja.html' },
  '/login':           { status: 200, file: 'login-wall.html' },
  '/login-attrs':     { status: 200, file: 'login-wall-attr.html' },
  '/login-ja':        { status: 200, file: 'login-wall-ja.html' },
  '/public-login-link': { status: 200, file: 'public-login-link.html' },
  '/public-login-box':  { status: 200, file: 'public-login-box.html' },
  '/js':              { status: 200, file: 'js-render.html' },
  '/dynamic-login':   { status: 200, file: 'dynamic-login.html' },
  '/redirect':        { status: 302, location: '/normal' },
  '/empty':           { status: 200, file: 'empty.html' },
  '/form':            { status: 200, file: 'form.html' },
  '/popup':           { status: 200, file: 'popup.html' },
  '/tall':            { status: 200, file: 'tall.html' },
  '/passwd':          { status: 200, file: 'normal.html' },
};

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/slow') {                       // never answers within 1s
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><body>late</body></html>'); }, 15000);
    return;
  }
  const r = ROUTES[path];
  if (!r) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  if (r.location) headers.location = r.location;
  // A block page must look like one to a client that only sees headers too:
  // these are the headers Cloudflare sends with a 403/429 interstitial.
  if (r.status === 403 || r.status === 429) {
    headers['server'] = 'cloudflare';
    headers['cf-mitigated'] = 'challenge';
  }
  res.writeHead(r.status, headers);
  if (r.location) { res.end(); return; }
  res.end(page(r.file));
});

server.listen(PORT, '127.0.0.1', () => {
  const p = server.address().port;
  if (PORT_FILE) writeFileSync(PORT_FILE, String(p));
  console.log('pu-fixture-server listening on 127.0.0.1:' + p);
});
// Chrome keeps its sockets alive; server.close() waits for them and the
// process would never exit (the test suite then hung in cleanup). Drop the
// connections first, and keep a hard exit as the fallback.
const bye = () => {
  try { server.closeAllConnections?.(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
