#!/usr/bin/env node

// bin/cdp-client.mjs
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var STATE_DIR = process.env.PICKLE_ULTRA_STATE_DIR || join(homedir(), ".local", "share", "pickle-ultra-browser");
var SOCK = join(STATE_DIR, "cdp-daemon.sock");
var HERE = new URL(".", import.meta.url).pathname;
var DAEMON = join(HERE, "cdp-daemon.mjs");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tryConnect() {
  return new Promise((res, rej) => {
    const s = connect(SOCK);
    s.once("connect", () => res(s));
    s.once("error", rej);
  });
}
var START_LOCK = join(STATE_DIR, "daemon.start.lock");
async function ensureDaemon() {
  try {
    const s = await tryConnect();
    s.destroy();
    return;
  } catch {
  }
  mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  const deadline = Date.now() + 2e4;
  let haveLock = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(START_LOCK, { mode: 448 });
      haveLock = true;
      break;
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      try {
        const st = statSync(START_LOCK);
        if (Date.now() - st.mtimeMs > 15e3) {
          rmSync(START_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
      }
      await sleep(250);
      try {
        const s = await tryConnect();
        s.destroy();
        return;
      } catch {
      }
    }
  }
  if (!haveLock) throw new Error("cdp-client: daemon start lock still held after 20s \u2014 another client is starting it");
  try {
    try {
      const s = await tryConnect();
      s.destroy();
      return;
    } catch {
    }
    const logFd = openSync(join(STATE_DIR, "cdp-daemon.log"), "a");
    const child = spawn(process.execPath, [DAEMON], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env
    });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const s = await tryConnect();
        s.destroy();
        return;
      } catch {
      }
    }
    throw new Error("cdp-client: cannot connect to daemon.sock (ECONNREFUSED) \u2014 daemon did not start; see cdp-daemon.log");
  } finally {
    try {
      rmSync(START_LOCK, { recursive: true, force: true });
    } catch {
    }
  }
}
async function sendAndStream(msg) {
  const sock = await tryConnect().catch(() => null);
  if (!sock) throw new Error("cdp-client: connect daemon.sock failed (ECONNREFUSED)");
  return new Promise((resolve, reject) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === "out") process.stdout.write(m.text);
        else if (m.type === "err") process.stderr.write(m.text);
        else if (m.type === "done") {
          sock.end();
          resolve(m.code);
        }
      }
    });
    sock.on("error", reject);
    sock.write(JSON.stringify(msg) + "\n");
  });
}
var mode = process.argv[2] || "";
try {
  if (mode === "--stop") {
    if (!existsSync(SOCK)) {
      process.exit(0);
    }
    const s = await tryConnect().catch(() => null);
    if (!s) process.exit(0);
    s.write(JSON.stringify({ type: "stop" }) + "\n");
    s.on("data", () => {
    });
    s.on("close", () => process.exit(0));
    setTimeout(() => process.exit(0), 3e3).unref();
  } else if (mode === "--status") {
    if (!existsSync(SOCK)) {
      console.log(JSON.stringify({ daemon: "down" }));
      process.exit(0);
    }
    await ensureDaemon().catch(() => {
    });
    const code = await sendAndStream({ type: "status" }).catch(() => {
      console.log(JSON.stringify({ daemon: "down" }));
      return 0;
    });
    process.exit(code);
  } else {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const script = Buffer.concat(chunks).toString("utf8");
    await ensureDaemon();
    const code = await sendAndStream({ type: "run", script });
    process.exit(code);
  }
} catch (e) {
  console.error("cdp-client: " + String(e && e.message || e));
  process.exit(1);
}
