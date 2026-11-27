#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// extensions/vault-intake/lib.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function runProcess(cmd2, args, { input = null, timeout = 0, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd2, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", error: true });
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const current = () => ({
      code: null,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      error: true
    });
    child.on("error", () => finish(current()));
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.on("error", () => {
    });
    child.on(
      "close",
      (code) => finish({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        error: false
      })
    );
    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        finish(current());
      }, timeout * 1e3);
    }
    try {
      child.stdin.end(input === null ? void 0 : input);
    } catch {
    }
  });
}
async function runGog(args, gogBin, timeout = 110) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = await runProcess(gogBin, args, { timeout });
    if (p.error) return { obj: null, code: "cli" };
    let obj = null;
    try {
      obj = JSON.parse(p.stdout);
    } catch {
      obj = null;
    }
    const blob = (p.stdout || "") + (p.stderr || "");
    if (obj && obj.ok === true) return { obj, code: null };
    const raw = obj === null ? "parse" : obj.code;
    const rate = raw === 7 || raw === "rate_limited" || RATE_MARKERS.some((m) => blob.includes(m));
    if (attempt === 1 && rate) {
      await sleep(2e4);
      continue;
    }
    return { obj, code: raw === null || raw === void 0 || raw === "ok" ? "gog" : String(raw) };
  }
  return { obj: null, code: "gog" };
}
function findListWithKey(obj, key, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(obj)) {
    const allObjects = obj.length > 0 && obj.every((i) => i !== null && typeof i === "object" && !Array.isArray(i));
    if (allObjects && obj.some((i) => key in i)) return obj;
    for (const v of obj) {
      const got = findListWithKey(v, key, depth + 1);
      if (got !== null) return got;
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const v of Object.values(obj)) {
      const got = findListWithKey(v, key, depth + 1);
      if (got !== null) return got;
    }
  }
  return null;
}
function findScalar(obj, keys, depth = 0) {
  if (depth > 6) return null;
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of keys) {
      if (typeof obj[k] === "string" && obj[k]) return obj[k];
    }
    for (const v of Object.values(obj)) {
      const got = findScalar(v, keys, depth + 1);
      if (got !== null) return got;
    }
  } else if (Array.isArray(obj)) {
    for (const v of obj) {
      const got = findScalar(v, keys, depth + 1);
      if (got !== null) return got;
    }
  }
  return null;
}
function findValues(obj, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(obj)) {
    if (obj.every((r) => Array.isArray(r))) return obj;
    for (const v of obj) {
      const got = findValues(v, depth + 1);
      if (got !== null) return got;
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const k of ["values", "data"]) {
      if (k in obj) {
        const got = findValues(obj[k], depth + 1);
        if (got !== null) return got;
      }
    }
    for (const v of Object.values(obj)) {
      if (v !== null && typeof v === "object") {
        const got = findValues(v, depth + 1);
        if (got !== null) return got;
      }
    }
  }
  return null;
}
function normalizeSite(raw) {
  let s = String(raw === null || raw === void 0 ? "" : raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  if (s.startsWith("www.")) s = s.slice(4);
  s = s.replace(/[^a-z0-9._-]+/g, "-");
  s = s.replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (s.length > 64) return "";
  return NAME_RE.test(s) ? s : "";
}
async function loadLogins(cli) {
  const p = await runProcess(cli, ["logins"], { timeout: 60 });
  if (p.error) return { logins: null, error: "cli" };
  let data;
  try {
    data = JSON.parse(p.stdout);
  } catch {
    return { logins: null, error: "parse" };
  }
  return { logins: findListWithKey(data, "site") || [], error: null };
}
function loadLoginsFromJson(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const e = new Error(err.message);
    e.reason = "unreadable";
    throw e;
  }
  return findListWithKey(data, "site") || [];
}
function planRows(logins) {
  const rows = [];
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of logins) {
    if (item === null || typeof item !== "object") continue;
    const site = normalizeSite(item.site === void 0 || item.site === null ? "" : item.site);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    const hasPassword = item.password === true;
    const username = String(item.username === void 0 || item.username === null ? "" : item.username).trim();
    const method = String(item.method === void 0 || item.method === null ? "" : item.method).trim();
    let prefill = "";
    if (method && !hasPassword) {
      notes.push(`${site}=${method}`);
    } else {
      prefill = username;
    }
    rows.push([site, prefill]);
  }
  rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  notes.sort();
  return { rows, notes };
}
async function readSheet6(sheetId, rng, gogBin) {
  const { obj, code } = await runGog(["--readonly", "sheets", "get", sheetId, rng], gogBin);
  if (code) return { rows: null, code };
  const raw = findValues(obj);
  const rows = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!Array.isArray(row)) continue;
      const cells = [];
      for (let i = 0; i < 6; i++) cells.push(i >= row.length || row[i] === null ? "" : String(row[i]));
      rows.push(cells);
    }
  }
  return { rows, code: null };
}
async function readSheet3(sheetId, rng, gogBin) {
  const { obj, code } = await runGog(["--readonly", "sheets", "get", sheetId, rng], gogBin);
  if (code) {
    const c = String(code || "read");
    return { rows: null, code: c.includes("range") || c.includes("invalid") ? "range" : "read" };
  }
  const raw = findValues(obj);
  const rows = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!Array.isArray(row)) continue;
      const cells = [];
      for (let i = 0; i < 3; i++) cells.push(i < row.length && row[i] !== null ? String(row[i]) : "");
      rows.push(cells);
    }
  }
  return { rows, code: null };
}
async function updateRange(sheetId, rng, values, gogBin, raw = true) {
  const args = ["sheets", "update", sheetId, rng, "--values-json", JSON.stringify(values)];
  if (raw) args.push("--input", "RAW");
  const { code } = await runGog(args, gogBin);
  return code;
}
function rgb(hex) {
  const h = hex.replace(/^#/, "");
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255
  };
}
function cellFormat({
  bg = null,
  bold = false,
  fg = null,
  size = 11,
  halign = "CENTER",
  valign = "MIDDLE",
  wrap = "CLIP",
  borders = false
} = {}) {
  const f = {
    verticalAlignment: valign,
    horizontalAlignment: halign,
    wrapStrategy: wrap,
    textFormat: { bold, fontSize: size }
  };
  if (bg) f.backgroundColor = rgb(bg);
  if (fg) f.textFormat.foregroundColor = rgb(fg);
  if (borders) {
    const line = () => ({ style: "SOLID", color: rgb("#C6CDD5") });
    f.borders = { top: line(), bottom: line(), left: line(), right: line() };
  }
  return f;
}
async function applyVisuals(sheetId, gogBin, tab, lastRow) {
  const failed = [];
  const rng = (a) => `${tab}!${a}`;
  const last = Math.max(lastRow, 2);
  const fmt = (range, style) => ["sheets", "format", sheetId, rng(range), "--format-json", JSON.stringify(style)];
  const steps = [
    // 1) column widths — a long address in B must never bleed into C
    [["sheets", "resize-columns", sheetId, rng("A:A"), "--width", "220"], "width:A:A"],
    [["sheets", "resize-columns", sheetId, rng("B:B"), "--width", "240"], "width:B:B"],
    [["sheets", "resize-columns", sheetId, rng("C:C"), "--width", "240"], "width:C:C"],
    // 2) header frozen, comfortable row heights
    [["sheets", "freeze", sheetId, "--rows", "1", "--sheet", tab], "freeze"],
    [["sheets", "resize-rows", sheetId, rng("1:1"), "--height", "38"], "row-height:1"],
    [["sheets", "resize-rows", sheetId, rng(`2:${last}`), "--height", "34"], "row-height:data"],
    // 3) header band: bold, dark, centred
    [fmt("A1:C1", cellFormat({ bg: "#1F3B57", bold: true, fg: "#FFFFFF", borders: true })), "format:header"],
    // 4) data area: plain text format (prevents numeric IDs/passwords from right-aligning) + thin borders
    [["sheets", "number-format", sheetId, rng("A2:C200"), "--type", "TEXT"], "number-format:TEXT"],
    [fmt("A2:C200", { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE" }), "align:A2:C200"],
    [fmt(`A2:C${last}`, cellFormat({ borders: true, halign: "LEFT" })), "format:data"],
    // 5) B reads as pre-filled grey; C is the one cell the user fills in
    [fmt(`B2:B${last}`, cellFormat({ bg: "#F1F3F5", halign: "LEFT", borders: true })), "format:B"],
    [fmt(`C2:C${last}`, cellFormat({ bg: "#FFF8DC", halign: "LEFT", borders: true })), "format:C"]
  ];
  for (const [args, label] of steps) {
    const { code } = await runGog(args, gogBin);
    if (code) failed.push(label);
  }
  return { ok: failed.length === 0, failed };
}
async function tabTitle(sheetId, gogBin, fallback = "Sheet1") {
  const { obj, code } = await runGog(["--readonly", "sheets", "metadata", sheetId], gogBin);
  if (code) return fallback;
  const titles = [];
  const walk = (o, depth = 0) => {
    if (depth > 6) return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
    } else if (o !== null && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if ((k === "title" || k === "sheetName") && typeof v === "string") titles.push(v);
        else if (v !== null && typeof v === "object") walk(v, depth + 1);
      }
    }
  };
  walk(obj);
  return titles.length ? titles[0] : fallback;
}
function configDir() {
  return process.env.PU_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pickle-ultra");
}
function configFile() {
  return process.env.PU_CONFIG_FILE || path.join(configDir(), "config.json");
}
function loadConfig() {
  const cfg = { ...CONFIG_DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    if (data !== null && typeof data === "object" && !Array.isArray(data)) Object.assign(cfg, data);
  } catch {
  }
  return cfg;
}
function saveConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  try {
    fs.chmodSync(dir, 448);
  } catch {
  }
  const file = configFile();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 384 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 384);
  } catch {
  }
}
function inboxPath(fmt = "tsv") {
  const explicit = process.env.PICKLE_ULTRA_INBOX || process.env.PU_INBOX || "";
  if (explicit) {
    if (fmt === "csv" && !explicit.toLowerCase().endsWith(".csv")) {
      return stem(explicit) + ".csv";
    }
    if (fmt === "tsv" && explicit.toLowerCase().endsWith(".csv")) {
      return stem(explicit) + ".tsv";
    }
    return explicit;
  }
  const home = process.env.PICKLE_ULTRA_HOME || REPO;
  return path.join(home, fmt === "tsv" ? "inbox.tsv" : "inbox.csv");
}
function stem(p) {
  const ext = path.extname(p);
  return ext ? p.slice(0, p.length - ext.length) : p;
}
function formatOf(file) {
  const low = String(file || "").toLowerCase();
  for (const fmt of ["xlsx", "csv", "tsv"]) {
    if (low.endsWith("." + fmt)) return fmt;
  }
  return "tsv";
}
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
function serializeDelimited(rows, delim) {
  const quote = (v) => {
    const s = v === null || v === void 0 ? "" : String(v);
    if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  return rows.map((r) => r.map(quote).join(delim)).join("\n") + "\n";
}
function pythonBin() {
  return process.env.PICKLE_ULTRA_PYTHON || "python3";
}
async function openpyxlAvailable() {
  if (openpyxlChecked !== null) return openpyxlChecked;
  const p = await runProcess(pythonBin(), ["-c", "import openpyxl"], { timeout: 30 });
  openpyxlChecked = !p.error && p.code === 0;
  return openpyxlChecked;
}
async function readXlsx(file) {
  if (!await openpyxlAvailable()) return { error: "xlsx-unavailable" };
  const p = await runProcess(pythonBin(), ["-c", XLSX_READ_PY, file], { timeout: 60 });
  if (p.error || p.code !== 0) return { error: "xlsx-read" };
  try {
    return { rows: JSON.parse(p.stdout) };
  } catch {
    return { error: "xlsx-read" };
  }
}
async function writeXlsx(file, rows) {
  if (!await openpyxlAvailable()) return { error: "xlsx-unavailable" };
  const p = await runProcess(pythonBin(), ["-c", XLSX_WRITE_PY, file], {
    input: JSON.stringify(rows),
    timeout: 120
  });
  if (p.error || p.code !== 0) return { error: "xlsx-write" };
  return { error: null };
}
async function readFormRows(file) {
  if (!fs.existsSync(file)) return [];
  const fmt = formatOf(file);
  if (fmt === "xlsx") {
    const got = await readXlsx(file);
    if (got.error) {
      const e = new Error(got.error);
      e.reason = got.error;
      throw e;
    }
    return got.rows;
  }
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  const rows = [];
  for (const [i, row] of parseDelimited(text, fmt === "csv" ? "," : "	").entries()) {
    if (i === 0) continue;
    const cells = [0, 1, 2].map((j) => j < row.length ? row[j] : "");
    if (!cells[0].trim()) continue;
    rows.push([cells[0].trim(), cells[1].trim(), cells[2].trim()]);
  }
  return rows;
}
function zeroOldFile(file) {
  if (!fs.existsSync(file)) return;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  try {
    const fd = fs.openSync(file, "r+");
    try {
      fs.writeSync(fd, Buffer.alloc(size), 0, size, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
  }
}
async function writeFormRows(file, rows, fmt) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  zeroOldFile(file);
  const tmp = file + ".tmp";
  if (fmt === "xlsx") {
    const got = await writeXlsx(tmp, rows);
    if (got.error) {
      const e = new Error(got.error);
      e.reason = got.error;
      throw e;
    }
  } else {
    const delim = fmt === "csv" ? "," : "	";
    const body = serializeDelimited([HEADER, ...rows], delim);
    const text = (fmt === "csv" ? "\uFEFF" : "") + body;
    const fd = fs.openSync(tmp, "w", 384);
    try {
      fs.writeFileSync(fd, text, { encoding: "utf8" });
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    fs.chmodSync(tmp, 384);
  } catch {
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 384);
}
function shredFile(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  if (size > 0) {
    try {
      const fd = fs.openSync(file, "r+");
      try {
        fs.writeSync(fd, Buffer.alloc(size), 0, size, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
    }
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
function attachmentCopies(target, attachmentsDir) {
  const copies = [];
  if (!attachmentsDir) return copies;
  let isDir = false;
  try {
    isDir = fs.statSync(attachmentsDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return copies;
  const base = path.basename(target);
  const rootDepth = path.resolve(attachmentsDir).split(path.sep).length;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const depth = path.resolve(dir).split(path.sep).length - rootDepth;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(full);
      } else if (entry.name === base) {
        copies.push(full);
      }
    }
  };
  walk(attachmentsDir);
  return copies;
}
function isoLocalNow(d = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}${pad(off % 60)}`;
}
function parseArgs(argv2, spec, usage) {
  const opts = { _: [] };
  const die = (msg) => {
    process.stderr.write(`usage: ${usage}
${msg ? "error: " + msg + "\n" : ""}`);
    process.exit(2);
  };
  for (let i = 0; i < argv2.length; i++) {
    const a = argv2[i];
    if (a === "--") {
      opts._.push(...argv2.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      process.stdout.write(`usage: ${usage}
`);
      process.exit(0);
    }
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let value = null;
      let hasValue = false;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
        hasValue = true;
      }
      const kind = spec[name];
      if (!kind) die("unrecognized arguments: " + a);
      const key = name.replace(/-/g, "_");
      if (kind === "flag") {
        if (hasValue) die(`argument --${name}: ignored explicit argument '${value}'`);
        opts[key] = true;
        continue;
      }
      if (!hasValue) {
        if (i + 1 >= argv2.length) die(`argument --${name}: expected one argument`);
        value = argv2[++i];
      }
      opts[key] = value;
      continue;
    }
    opts._.push(a);
  }
  return opts;
}
var HERE, REPO, HEADER, RATE_MARKERS, NAME_RE, CONFIG_DEFAULTS, XLSX_WRITE_PY, XLSX_READ_PY, openpyxlChecked;
var init_lib = __esm({
  "extensions/vault-intake/lib.mjs"() {
    HERE = (() => {
      const d = path.dirname(fileURLToPath(import.meta.url));
      if (fs.existsSync(path.join(d, "vault-sheet-init.sh"))) return d;
      const up = path.join(path.dirname(d), "extensions", "vault-intake");
      return fs.existsSync(path.join(up, "vault-sheet-init.sh")) ? up : d;
    })();
    REPO = path.dirname(path.dirname(HERE));
    HEADER = ["\uC0AC\uC774\uD2B8", "\uC544\uC774\uB514", "\uBE44\uBC00\uBC88\uD638"];
    RATE_MARKERS = ["rate_limited", "429", "quota", "RESOURCE_EXHAUSTED"];
    NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
    CONFIG_DEFAULTS = { sheet_tab: "in", sheet_range: "in!A2:C200" };
    XLSX_WRITE_PY = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
rows = json.load(sys.stdin)
wb = Workbook()
ws = wb.active
ws.title = "in"
ws.append(["\uC0AC\uC774\uD2B8", "\uC544\uC774\uB514", "\uBE44\uBC00\uBC88\uD638"])
for c in ws[1]:
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="1F3B57")
    c.alignment = Alignment(horizontal="center", vertical="center")
for site, user, pw in rows:
    ws.append([site, user, pw])
ws.column_dimensions["A"].width = 34
ws.column_dimensions["B"].width = 34
ws.column_dimensions["C"].width = 32
ws.freeze_panes = "A2"
wb.save(sys.argv[1])
`;
    XLSX_READ_PY = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1], data_only=True)
ws = wb.active
out = []
for i, row in enumerate(ws.iter_rows(values_only=True)):
    if i == 0:
        continue
    cells = ["" if (j >= len(row) or row[j] is None) else str(row[j]) for j in range(3)]
    if not cells[0].strip():
        continue
    out.append([cells[0].strip(), cells[1].strip(), cells[2].strip()])
print(json.dumps(out, ensure_ascii=False))
`;
    openpyxlChecked = null;
  }
});

// extensions/vault-intake/vault-sheet.mjs
var vault_sheet_exports = {};
import fs2 from "node:fs";
async function cmdInit(opts) {
  const cfg = loadConfig();
  if (opts.agent_name) cfg.agent_name = opts.agent_name;
  const agent = cfg.agent_name || "Pickle Ultra";
  const gogBin = opts.gog || process.env.PU_GOG || "gog";
  let logins;
  if (opts.from_json) {
    try {
      logins = loadLoginsFromJson(opts.from_json);
    } catch {
      console.log("fail code=vault reason=from-json");
      return 1;
    }
  } else {
    const cli = process.env.PU_VAULT_CLI || "vault";
    const got = await loadLogins(cli);
    if (got.error) {
      console.log("fail code=vault reason=login-list-unavailable");
      return 1;
    }
    logins = got.logins;
  }
  const { rows, notes } = planRows(logins);
  if (!rows.length) {
    console.log("skip empty source=no-sites");
    return 0;
  }
  if (opts.dry_run) {
    console.log(
      `dry-run rows=${rows.length} prefilled=${rows.filter(([, u]) => u).length} notes=${notes.length} sheet=${cfg.sheet_id || "new"}`
    );
    return 0;
  }
  let sheetId = opts.new ? "" : cfg.sheet_id || "";
  let created = "no";
  let existing = [];
  let anchor = 2;
  if (sheetId) {
    const got = await readSheet6(sheetId, `${cfg.sheet_tab || "in"}!A1:F200`, gogBin);
    if (got.code) {
      sheetId = "";
    } else {
      existing = got.rows;
      anchor = Math.max(2, existing.length + 1);
      for (let i = 1; i < existing.length; i++) {
        const row = existing[i];
        if (!(row && (row[0] || "").trim())) {
          anchor = i + 1;
          break;
        }
      }
    }
  }
  if (!sheetId) {
    const title = `${agent} \uC778\uC785 (\uC790\uB3D9 \uD30C\uC1C4)`;
    const got = await runGog(["sheets", "create", title], gogBin);
    if (got.code) {
      console.log("fail code=gog reason=create");
      return 1;
    }
    sheetId = findScalar(got.obj, ["spreadsheetId", "id"]) || "";
    if (!sheetId) {
      console.log("fail code=gog reason=create-no-id");
      return 1;
    }
    created = "yes";
    Object.assign(cfg, {
      sheet_id: sheetId,
      sheet_tab: "in",
      sheet_range: "in!A2:C200",
      sheet_title: title,
      agent_name: agent
    });
    saveConfig(cfg);
    const old = await tabTitle(sheetId, gogBin);
    if (old && old !== "in") {
      await runGog(["sheets", "rename-tab", sheetId, old, "in"], gogBin);
    }
    await updateRange(sheetId, "in!A1:C1", [["\uC0AC\uC774\uD2B8", "\uC544\uC774\uB514", "\uBE44\uBC00\uBC88\uD638"]], gogBin);
    anchor = 2;
  }
  const known = /* @__PURE__ */ new Set();
  for (const row of existing.slice(1)) {
    const site = normalizeSite(row ? row[0] : "");
    if (site) known.add(site);
  }
  const toAdd = rows.filter(([s]) => !known.has(s));
  let added = 0;
  let filled = 0;
  let rowNo = anchor;
  for (const [site, prefill] of toAdd) {
    const err = await updateRange(sheetId, `in!A${rowNo}:C${rowNo}`, [[site, prefill, ""]], gogBin);
    if (err) {
      console.log(`fail code=write row=${rowNo} site=${site}`);
      return 1;
    }
    if (prefill) filled += 1;
    added += 1;
    rowNo += 1;
  }
  const wanted = new Map(rows);
  for (let i = 1; i < existing.length; i++) {
    const row = existing[i];
    const site = normalizeSite(row ? row[0] : "");
    const want = wanted.get(site) || "";
    if (site && want && !(row.length > 1 ? (row[1] || "").trim() : "")) {
      const err = await updateRange(sheetId, `in!B${i + 1}`, [[want]], gogBin);
      if (err) {
        console.log(`fail code=write row=${i + 1} col=B`);
        return 1;
      }
      filled += 1;
    }
  }
  if (notes.length) {
    const note = "\uAC04\uD3B8\uB85C\uADF8\uC778(\uBE44\uBC00\uBC88\uD638 \uC5C6\uC74C): " + notes.join(", ");
    await updateRange(sheetId, "in!E1", [["\uCC38\uACE0"]], gogBin);
    await updateRange(sheetId, "in!F1", [[note]], gogBin);
  }
  const lastRow = Math.max(anchor + added - 1, existing.length || 2, 2);
  let fmtOk = true;
  let fmtFailed = [];
  if (!opts.no_format) {
    const fmt = await applyVisuals(sheetId, gogBin, cfg.sheet_tab || "in", lastRow);
    fmtOk = fmt.ok;
    fmtFailed = fmt.failed;
  }
  const formatStatus = fmtOk ? "ok" : "fail:" + fmtFailed.join(",");
  let verify = "ok";
  let prefilled = 0;
  let listed = 0;
  const back = await readSheet6(sheetId, "in!A2:C200", gogBin);
  if (back.code) {
    verify = "unreadable";
  } else {
    for (const row of back.rows) {
      if (row && (row[0] || "").trim()) {
        listed += 1;
        if (row.length > 1 && (row[1] || "").trim()) prefilled += 1;
        if (row.length > 2 && (row[2] || "").trim()) verify = "mismatch";
      }
    }
  }
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  Object.assign(cfg, {
    sheet_id: sheetId,
    sheet_url: url,
    sheet_tab: "in",
    agent_name: agent,
    sites: rows.map((r) => r[0])
  });
  saveConfig(cfg);
  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        sheet_id: sheetId,
        url,
        created,
        rows: rows.length,
        added,
        prefilled,
        listed,
        verify,
        format: formatStatus,
        format_failed: fmtFailed
      })
    );
  } else {
    console.log(
      `ok sheet_id=${sheetId} url=${url || "-"} created=${created} rows=${rows.length} added=${added} prefilled=${prefilled} verify=${verify} format=${formatStatus}`
    );
  }
  return 0;
}
async function cmdStatus(opts) {
  const cfg = loadConfig();
  const sheetId = cfg.sheet_id || "";
  const source = sheetId ? "sheet" : "inbox";
  let listed = 0;
  let waiting = 0;
  let file = "";
  if (sheetId) {
    const gogBin = opts.gog || process.env.PU_GOG || "gog";
    const got = await readSheet6(sheetId, `${cfg.sheet_tab || "in"}!A2:C200`, gogBin);
    if (got.code) {
      console.log("fail code=read");
      return 1;
    }
    listed = got.rows.filter((r) => r && (r[0] || "").trim()).length;
    waiting = got.rows.filter((r) => r && (r[0] || "").trim() && r.length > 2 && (r[2] || "").trim()).length;
  } else {
    for (const cand of [inboxPath("tsv"), inboxPath("csv"), inboxPath("xlsx")]) {
      if (cand && fileExists(cand)) {
        file = cand;
        break;
      }
    }
    if (!file) {
      console.log("skip no-form");
      return 0;
    }
    let rows;
    try {
      rows = await readFormRows(file);
    } catch (err) {
      console.log(`fail code=read reason=${err.reason || "unreadable"}`);
      return 1;
    }
    listed = rows.length;
    waiting = rows.filter((r) => (r[2] || "").trim()).length;
  }
  const checkedAt = isoLocalNow();
  cfg.last_status_at = checkedAt;
  saveConfig(cfg);
  const unfilled = Math.max(listed - waiting, 0);
  if (opts.json) {
    console.log(
      JSON.stringify({
        source,
        sheet_id: sheetId,
        path: file,
        url: cfg.sheet_url || "",
        listed,
        waiting,
        unfilled,
        checked_at: checkedAt
      })
    );
  } else {
    const tail = file ? " path=" + file : sheetId ? " sheet_id=" + sheetId : "";
    console.log(
      `status source=${source} listed=${listed} waiting=${waiting} unfilled=${unfilled} checked_at=${checkedAt}${tail}`
    );
  }
  return 0;
}
function fileExists(p) {
  try {
    return fs2.statSync(p).isFile();
  } catch {
    return false;
  }
}
async function main(argv2) {
  const cmd2 = argv2[0];
  if (cmd2 !== "init" && cmd2 !== "status") {
    process.stderr.write(`usage: ${USAGE}
`);
    return 2;
  }
  const spec = cmd2 === "init" ? {
    gog: "value",
    json: "flag",
    "from-json": "value",
    "agent-name": "value",
    new: "flag",
    "dry-run": "flag",
    "no-format": "flag"
  } : { gog: "value", json: "flag" };
  const opts = parseArgs(argv2.slice(1), spec, USAGE);
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  return cmd2 === "init" ? cmdInit(opts) : cmdStatus(opts);
}
var USAGE;
var init_vault_sheet = __esm({
  async "extensions/vault-intake/vault-sheet.mjs"() {
    init_lib();
    USAGE = "vault-sheet.mjs [init|status] [--from-json FILE] [--agent-name NAME] [--new] [--gog gog] [--dry-run] [--json] [--no-format]";
    process.exitCode = await main(process.argv.slice(2));
  }
});

// extensions/vault-intake/vault-form.mjs
var vault_form_exports = {};
import fs3 from "node:fs";
import path2 from "node:path";
function stem2(p) {
  const ext = path2.extname(p);
  return ext ? p.slice(0, p.length - ext.length) : p;
}
async function main2(argv2) {
  const opts = parseArgs(
    argv2,
    {
      "from-json": "value",
      format: "value",
      out: "value",
      "vault-cli": "value",
      "agent-name": "value",
      json: "flag"
    },
    USAGE2
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE2}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  if (opts.format && !["tsv", "csv", "xlsx"].includes(opts.format)) {
    process.stderr.write(`usage: ${USAGE2}
error: argument --format: invalid choice: '${opts.format}'
`);
    return 2;
  }
  const cfg = loadConfig();
  const agent = opts.agent_name || cfg.agent_name || "Pickle Ultra";
  let logins;
  if (opts.from_json) {
    try {
      logins = loadLoginsFromJson(opts.from_json);
    } catch {
      console.log("fail code=from-json reason=unreadable");
      return 1;
    }
  } else {
    const cli = opts.vault_cli || process.env.PU_VAULT_CLI || "vault";
    const got = await loadLogins(cli);
    if (got.error) {
      console.log("fail code=vault reason=login-list-unavailable");
      return 1;
    }
    logins = got.logins;
  }
  const { rows: planned, notes } = planRows(logins);
  if (!planned.length) {
    console.log("skip empty source=no-sites");
    return 0;
  }
  const fmt = opts.format || formatOf(opts.out || inboxPath("tsv"));
  if (fmt === "xlsx" && !await openpyxlAvailable()) {
    console.log("fail code=write reason=xlsx-unavailable");
    return 1;
  }
  let out = opts.out || inboxPath(fmt);
  if (!out.toLowerCase().endsWith("." + fmt)) {
    out = path2.extname(out) ? stem2(out) + "." + fmt : out + "." + fmt;
  }
  let existing;
  try {
    existing = await readFormRows(out);
  } catch (err) {
    console.log(`fail code=read reason=${err.reason || "unreadable"}`);
    return 1;
  }
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [site, user, pw] of existing) {
    merged.push([site, user, pw]);
    seen.add(String(site).toLowerCase());
  }
  let added = 0;
  for (const [site, prefill] of planned) {
    if (seen.has(site.toLowerCase())) continue;
    merged.push([site, prefill, ""]);
    seen.add(site.toLowerCase());
    added += 1;
  }
  merged.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  try {
    await writeFormRows(out, merged, fmt);
  } catch (err) {
    console.log(`fail code=write reason=${err.reason === "xlsx-unavailable" ? "xlsx-unavailable" : "path"}`);
    return 1;
  }
  let mode = "";
  try {
    mode = (fs3.statSync(out).mode & 511).toString(8);
  } catch {
    mode = "600";
  }
  const prefilled = merged.filter(([, user]) => user).length;
  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        form: out,
        agent,
        format: fmt,
        rows: merged.length,
        added,
        prefilled,
        mode,
        social: notes
      })
    );
    return 0;
  }
  console.log(
    `ok form=${out} format=${fmt} rows=${merged.length} added=${added} prefilled=${prefilled} mode=${mode}`
  );
  console.log("attach=" + out);
  if (notes.length) console.log("note social=" + notes.join(","));
  return 0;
}
var USAGE2;
var init_vault_form = __esm({
  async "extensions/vault-intake/vault-form.mjs"() {
    init_lib();
    USAGE2 = "vault-form.mjs [--from-json FILE] [--format tsv|csv|xlsx] [--out PATH] [--vault-cli CMD] [--agent-name NAME] [--json]";
    process.exitCode = await main2(process.argv.slice(2));
  }
});

// extensions/vault-intake/intake-all.mjs
var intake_all_exports = {};
import fs4 from "node:fs";
import path3 from "node:path";
async function storeValue(name, user, password) {
  const payload = Buffer.from(user + "	" + password, "utf8");
  try {
    const p = await runProcess(
      pythonBin(),
      [VAULT, "store", name, "--purpose", "pickle-ultra login: " + name, "--force"],
      { input: payload }
    );
    return !p.error && p.code === 0;
  } catch {
    return false;
  } finally {
    payload.fill(0);
  }
}
async function clearSheetRow(sheetId, rowNo, gogBin, tab) {
  const rng = `${tab}!C${rowNo}`;
  const cleared = await runGog(["sheets", "clear", sheetId, rng], gogBin);
  if (cleared.code) return false;
  const got = await readSheet3(sheetId, rng, gogBin);
  if (got.code) return false;
  if (!got.rows.length) return true;
  return got.rows[0].every((c) => !String(c).trim());
}
async function handleSheet(sheetId, rng, gogBin, tab) {
  const got = await readSheet3(sheetId, rng, gogBin);
  if (got.code) return { rc: 0, code: got.code };
  let acted = 0;
  let rc = 0;
  for (let idx = 0; idx < got.rows.length; idx++) {
    const [siteRaw, userRaw, pwRaw] = got.rows[idx];
    const rowNo = idx + 2;
    const user = (userRaw || "").trim();
    const password = (pwRaw || "").trim();
    if (!password) {
      continue;
    }
    acted += 1;
    const name = normalizeSite(siteRaw);
    let failure = null;
    if (!(siteRaw || "").trim() || !user) failure = "incomplete";
    else if (!name) failure = "site";
    else if (/[\t\r\n]/.test(user) || /[\t\r\n]/.test(password)) failure = "chars";
    else if (!await storeValue(name, user, password)) failure = "store";
    const cleared = await clearSheetRow(sheetId, rowNo, gogBin, tab) ? "yes" : "no";
    if (failure) {
      console.log(`fail code=${failure} row=${rowNo} cleared=${cleared}`);
      rc = 1;
      continue;
    }
    console.log(`ok site=${name} row=${rowNo} cleared=${cleared}`);
    if (cleared !== "yes") rc = 1;
  }
  if (acted === 0) console.log("skip empty");
  return { rc, code: null };
}
async function handleFile(file, attachmentsDir) {
  if (!fs4.existsSync(file)) {
    console.log("skip empty");
    return { rc: 0, shredded: false };
  }
  let rows;
  let kind;
  try {
    kind = formatOf(file);
    rows = await readFormRows(file);
  } catch (err) {
    console.log(`fail code=read reason=${err.reason || "unreadable"}`);
    return { rc: 1, shredded: false };
  }
  let rc = 0;
  let acted = 0;
  for (let idx = 0; idx < rows.length; idx++) {
    const [siteRaw, userRaw, pwRaw] = rows[idx];
    const rowNo = idx + 2;
    const user = (userRaw || "").trim();
    const password = (pwRaw || "").trim();
    if (!password) continue;
    acted += 1;
    const name = normalizeSite(siteRaw);
    let failure = null;
    if (!(siteRaw || "").trim() || !user) failure = "incomplete";
    else if (!name) failure = "site";
    else if (/[\t\r\n]/.test(user) || /[\t\r\n]/.test(password)) failure = "chars";
    else if (!await storeValue(name, user, password)) failure = "store";
    rows[idx] = [siteRaw, userRaw, ""];
    try {
      await writeFormRows(file, rows, kind);
    } catch {
      console.log(`fail code=clear row=${rowNo}`);
      rc = 1;
      continue;
    }
    let back;
    try {
      back = await readFormRows(file);
    } catch {
      back = [];
    }
    const probe = idx < back.length ? back[idx] : ["", "", ""];
    let cleared = "yes";
    if ((probe[2] || "").trim() || (probe[0] || "").trim() !== (siteRaw || "").trim()) {
      cleared = "no";
    }
    if (failure) {
      console.log(`fail code=${failure} row=${rowNo} cleared=${cleared}`);
      rc = 1;
      continue;
    }
    console.log(`ok site=${name} row=${rowNo} cleared=${cleared}`);
    if (cleared !== "yes") rc = 1;
  }
  if (acted === 0) {
    console.log("skip empty");
    return { rc: 0, shredded: false };
  }
  const copies = attachmentCopies(file, attachmentsDir);
  const base = path3.basename(file);
  const homes = [];
  for (const fmt of ["tsv", "csv", "xlsx"]) {
    const cand = inboxPath(fmt);
    if (path3.basename(cand) === base && fs4.existsSync(cand) && path3.resolve(cand) !== path3.resolve(file)) {
      homes.push(cand);
    }
  }
  const removed = shredFile(file);
  let n = 0;
  for (const c of copies) {
    if (path3.resolve(c) === path3.resolve(file)) continue;
    if (shredFile(c)) n += 1;
  }
  let h = 0;
  for (const c of homes) {
    if (shredFile(c)) h += 1;
  }
  console.log(
    `shredded file=${file} removed=${removed ? "yes" : "no"} attachments=${n} home=${h}`
  );
  if (rc) console.log("refill rows that failed, then send the file again");
  return { rc, shredded: rc === 0 };
}
async function main3(argv2) {
  const opts = parseArgs(
    argv2,
    {
      source: "value",
      file: "value",
      "sheet-id": "value",
      range: "value",
      gog: "value",
      "attachments-dir": "value"
    },
    USAGE3
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE3}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  const sourceArg = opts.source || "auto";
  if (!["auto", "sheet", "file"].includes(sourceArg)) {
    process.stderr.write(`usage: ${USAGE3}
error: argument --source: invalid choice: '${sourceArg}'
`);
    return 2;
  }
  const gogBin = opts.gog || process.env.PU_GOG || "gog";
  const attachmentsDir = opts.attachments_dir || process.env.PICKLE_ULTRA_ATTACH_DIR || "";
  const cfg = loadConfig();
  const sheetId = opts.sheet_id || cfg.sheet_id || "";
  let source = sourceArg;
  if (source === "auto") source = sheetId ? "sheet" : "file";
  if (source === "sheet") {
    if (!sheetId) {
      if (sourceArg === "auto") {
        console.log("note fallback=file reason=config");
        source = "file";
      } else {
        console.log("fail code=config row=0");
        return 1;
      }
    } else {
      const tab = cfg.sheet_tab || "in";
      const rng = opts.range || cfg.sheet_range || tab + "!A2:C200";
      const got = await handleSheet(sheetId, rng, gogBin, tab);
      if (got.code === null) return got.rc;
      if (sourceArg !== "auto") {
        console.log("fail code=" + got.code);
        return 1;
      }
      console.log("note fallback=file reason=" + got.code);
      source = "file";
    }
  }
  if (source === "file") {
    let file = opts.file;
    if (!file) {
      for (const cand of [inboxPath("tsv"), inboxPath("csv")]) {
        if (fs4.existsSync(cand)) {
          file = cand;
          break;
        }
      }
      file = file || inboxPath("tsv");
    }
    const got = await handleFile(file, attachmentsDir);
    return got.rc;
  }
  return 0;
}
var USAGE3, VAULT;
var init_intake_all = __esm({
  async "extensions/vault-intake/intake-all.mjs"() {
    init_lib();
    USAGE3 = "intake-all.mjs [--source auto|sheet|file] [--file PATH] [--sheet-id ID] [--range RANGE] [--gog gog] [--attachments-dir DIR]";
    VAULT = process.env.PICKLE_ULTRA_VAULT || path3.join(REPO, "agent-vault", "vault.py");
    process.exitCode = await main3(process.argv.slice(2));
  }
});

// extensions/vault-intake/selftest-intake.mjs
var selftest_intake_exports = {};
import fs5 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
async function gog(args, timeout = 120) {
  const p = await runProcess(GOG, args, { timeout });
  if (p.error) return { ok: false, code: "cli" };
  try {
    return JSON.parse(p.stdout);
  } catch {
    return { ok: false, code: "parse" };
  }
}
async function run(cmd2, env) {
  const p = await runProcess(cmd2[0], cmd2.slice(1), { env, cwd: REPO });
  return { rc: p.code === null ? 1 : p.code, out: (p.stdout || "") + (p.stderr || "") };
}
function parseLine(out) {
  for (const line of out.split("\n")) {
    if (!line.startsWith("ok ")) continue;
    const fields = {};
    for (const part of line.split(/\s+/).slice(1)) {
      if (!part.includes("=")) continue;
      const eq = part.indexOf("=");
      fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return fields;
  }
  return {};
}
async function sheetRows(sheetId) {
  const obj = await gog(["--readonly", "sheets", "get", sheetId, "in!A1:C200"]);
  if (obj.ok !== true) return [];
  const values = findValues(obj);
  return Array.isArray(values) ? values : [];
}
async function profileCycle(r, prof, root) {
  const tag = "profile" + prof.name;
  const work = path4.join(root, tag);
  fs5.mkdirSync(work, { recursive: true });
  const conf = path4.join(work, "config");
  const profPath = path4.join(work, "profile.json");
  fs5.writeFileSync(profPath, JSON.stringify(prof), { encoding: "utf8" });
  const stub = path4.join(work, "vault-stub");
  fs5.writeFileSync(stub, STUB_VAULT, { encoding: "utf8" });
  fs5.chmodSync(stub, 448);
  const env = {
    ...process.env,
    PU_CONFIG_DIR: conf,
    PU_VAULT_CLI: stub,
    SELFTEST_PROFILE: profPath,
    PU_GOG: GOG,
    PICKLE_ULTRA_HOME: work
  };
  let got = await run(
    ["bash", path4.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  let fields = parseLine(got.out);
  if (!fields.sheet_id) {
    const failLine = got.out.split("\n").find((l) => l.startsWith("fail")) || "";
    console.log("SKIP  " + (tag + " create").padEnd(34) + " " + (failLine || "no sheet id"));
    r.skipped = true;
    return;
  }
  const sheetId = fields.sheet_id;
  r.sheets.push(sheetId);
  const rowsExpected = prof.logins.length;
  r.check(
    tag + " create+prefill",
    got.rc === 0 && fields.created === "yes" && fields.rows === String(rowsExpected) && fields.prefilled === String(prof.expect_prefilled),
    `rows=${fields.rows} prefilled=${fields.prefilled} (expected ${rowsExpected}/${prof.expect_prefilled}) created=${fields.created}`
  );
  r.check(
    tag + " verify+format",
    fields.verify === "ok" && fields.format === "ok",
    `verify=${fields.verify} format=${fields.format}`
  );
  got = await run(
    ["bash", path4.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  const fields2 = parseLine(got.out);
  r.check(
    tag + " idempotent",
    fields2.sheet_id === sheetId && fields2.created === "no" && fields2.added === "0" && fields2.verify === "ok",
    `sheet reused=${fields2.sheet_id === sheetId} added=${fields2.added} verify=${fields2.verify}`
  );
  const profNew = JSON.parse(JSON.stringify(prof));
  profNew.logins.push({ site: "new.example.org", username: "new.user@example.org", password: true });
  fs5.writeFileSync(profPath, JSON.stringify(profNew), { encoding: "utf8" });
  got = await run(
    ["bash", path4.join(HERE, "vault-sheet-init.sh"), "--gog", GOG, "--agent-name", prof.agent],
    env
  );
  const fields3 = parseLine(got.out);
  r.check(
    tag + " append only new",
    fields3.added === "1" && fields3.rows === String(rowsExpected + 1),
    `added=${fields3.added} rows=${fields3.rows}`
  );
  const rows = await sheetRows(sheetId);
  const targets = [];
  for (let i = 1; i < rows.length && targets.length < 2; i++) {
    const row = rows[i];
    if (row.length > 1 && row[1] && !(row.length > 2 && row[2])) targets.push([i + 1, row[0]]);
  }
  if (targets.length < 2) {
    r.check(
      tag + " fill+intake",
      false,
      `no pre-filled rows to fill (rows_read=${rows.length} prefilled=${rows.slice(1).filter((row) => row.length > 1 && row[1]).length})`
    );
    return;
  }
  const tokens = [TOKEN_A, TOKEN_B];
  for (let k = 0; k < targets.length; k++) {
    await gog([
      "sheets",
      "update",
      sheetId,
      `in!C${targets[k][0]}`,
      "--values-json",
      JSON.stringify([[tokens[k]]]),
      "--input",
      "RAW"
    ]);
  }
  const vaultDir = path4.join(work, "vault");
  fs5.mkdirSync(vaultDir, { recursive: true });
  const vaultPy = path4.join(vaultDir, "vault.py");
  fs5.copyFileSync(path4.join(REPO, "agent-vault", "vault.py"), vaultPy);
  await runProcess(pythonBin(), [vaultPy, "init"], { timeout: 60 });
  const envIntake = { ...env, PICKLE_ULTRA_VAULT: vaultPy };
  got = await run(
    [
      process.execPath,
      path4.join(HERE, "intake-all.mjs"),
      "--source",
      "sheet",
      "--sheet-id",
      sheetId,
      "--range",
      "in!A2:C200",
      "--gog",
      GOG
    ],
    envIntake
  );
  const okLines = got.out.split("\n").filter((l) => l.startsWith("ok site="));
  const fails = got.out.split("\n").filter((l) => l.startsWith("fail"));
  const good = okLines.filter((l) => l.includes("cleared=yes"));
  r.check(
    tag + " intake round trip",
    got.rc === 0 && okLines.length === 2 && good.length === 2,
    `rows=${okLines.length} cleared=yes=${good.length} exit=${got.rc}${fails.length ? " " + fails[0] : ""}`
  );
  const after = await sheetRows(sheetId);
  const dirty = [];
  for (const [rowNo] of targets) {
    const row = after[rowNo - 1] || [];
    const cells = row.map((c) => typeof c === "string" ? c : String(c === null || c === void 0 ? "" : c));
    if ([TOKEN_A, TOKEN_B].some((t) => cells.join(" ").includes(t))) dirty.push(rowNo);
    if (cells.length > 2 && String(cells[2] || "").trim()) dirty.push(rowNo);
  }
  r.check(tag + " cells cleared on read-back", dirty.length === 0, `rows_still_holding=${dirty.length}`);
  const listing = await runProcess(pythonBin(), [vaultPy, "list"], { timeout: 60 });
  const stored = (listing.stdout || "").split("\n").filter((l) => l.trim()).map((l) => l.split("	")[0]);
  r.check(tag + " values in vault", stored.length === 2, `items=${stored.length}`);
}
async function main4(argv2) {
  const opts = parseArgs(argv2, { keep: "flag" }, "selftest-intake.mjs [--keep]");
  const r = new Runner();
  const root = fs5.mkdtempSync(path4.join(os2.tmpdir(), "pu-selftest-intake-"));
  console.log(`selftest-intake: Pickle Ultra Browser \u2014 ${REPO}`);
  console.log(`selftest-intake: gog=${GOG} work=${root}`);
  try {
    for (const prof of [PROFILE_A, PROFILE_B]) await profileCycle(r, prof, root);
  } finally {
    for (const sid of r.sheets) await gog(["drive", "delete", sid, "--force"]);
    if (r.sheets.length) console.log(`cleanup: sheets to trash=${r.sheets.length}`);
    if (!opts.keep) fs5.rmSync(root, { recursive: true, force: true });
    else console.log(`kept: ${root}`);
  }
  console.log("----");
  if (r.skipped && r.npass === 0) {
    console.log("selftest-intake: SKIP reason=no-google (use extensions/vault-intake/vault-form.sh instead)");
    return 2;
  }
  console.log(`selftest-intake: PASS=${r.npass} FAIL=${r.nfail}`);
  return r.nfail === 0 ? 0 : 1;
}
var GOG, TOKEN_A, TOKEN_B, PROFILE_A, PROFILE_B, STUB_VAULT, Runner;
var init_selftest_intake = __esm({
  async "extensions/vault-intake/selftest-intake.mjs"() {
    init_lib();
    GOG = process.env.PU_GOG || "gog";
    TOKEN_A = "SelfTestAlpha-7k2q";
    TOKEN_B = "SelfTestBeta-9m4v";
    PROFILE_A = {
      name: "A",
      agent: "Test Agent A",
      logins: [
        { site: "mail.example.com", username: "first.last@example.com", password: true },
        { site: "shop.example.com", username: "first.last@example.com", password: true },
        { site: "news.example.com", username: "first.last@example.com", password: true },
        { site: "bank.example.com", username: "first.last@example.com", password: true },
        { site: "docs.example.com", username: "first.last@example.com", password: true },
        { site: "video.example.com", username: "first.last@example.com", password: true },
        { site: "photo.example.com", username: "first.last@example.com", password: false },
        { site: "travel.example.com", username: "first.last@example.com", password: false },
        { site: "music.example.com", username: "first.last@example.com", password: false },
        { site: "forum.example.com", username: "first.last@example.com", password: false }
      ],
      expect_prefilled: 10
    };
    PROFILE_B = {
      name: "B",
      agent: "Test Agent B",
      logins: [
        { site: "portal.example.ac.kr", username: "2023123456", password: false },
        { site: "lms.example.ac.kr", username: "2023123456", password: false },
        { site: "library.example.ac.kr", username: "2023123456", password: false },
        { site: "chat.example.net", username: "", password: false, method: "kakao" },
        { site: "store.example.net", username: "", password: false, method: "kakao" },
        { site: "map.example.net", username: "", password: false, method: "naver" },
        { site: "grade.example.ac.kr", username: "", password: false, method: "kakao" },
        { site: "club.example.ac.kr", username: "", password: false, method: "naver" }
      ],
      expect_prefilled: 3
    };
    STUB_VAULT = `#!${process.execPath}
import fs from "node:fs";
const prof = JSON.parse(fs.readFileSync(process.env.SELFTEST_PROFILE, "utf8"));
if (process.argv[2] === "logins") {
  console.log(JSON.stringify({ ok: true, data: { logins: prof.logins } }));
  process.exit(0);
}
console.log(JSON.stringify({ ok: false, code: "stub" }));
process.exit(2);
`;
    Runner = class {
      constructor() {
        this.npass = 0;
        this.nfail = 0;
        this.skipped = false;
        this.sheets = [];
      }
      check(label, cond, detail = "") {
        if (cond) {
          this.npass += 1;
          console.log("PASS  " + label.padEnd(34) + " " + detail);
        } else {
          this.nfail += 1;
          console.log("FAIL  " + label.padEnd(34) + " " + detail);
        }
        return cond;
      }
    };
    process.exitCode = await main4(process.argv.slice(2));
  }
});

// extensions/vault-intake/vault-intake-cli.mjs
var argv = process.argv.slice(2);
var cmd = argv[0] || "";
var rest = argv.slice(1);
var USAGE4 = `usage: vault-intake.mjs <command> [args...]

  sheet  init|status   build / inspect the private intake sheet
      [--from-json FILE] [--agent-name NAME] [--new] [--gog CMD] [--dry-run] [--json] [--no-format]
  form                 write the fill-in form file
      [--from-json FILE] [--out FILE] [--format tsv|csv|xlsx] [--gog CMD]
  intake               read the sheet (or a form file) into the vault, then clear it
      [--source sheet|file] [--file F] [--attachments-dir D] [--gog CMD]
  selftest             end-to-end self-test (needs gog signed in; uses a temp vault)
      [--keep] [--verbose]
`;
if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(USAGE4);
} else if (cmd === "sheet" || cmd === "form" || cmd === "intake" || cmd === "selftest") {
  process.argv = [process.argv[0], process.argv[1], ...rest];
  if (cmd === "sheet") await init_vault_sheet().then(() => vault_sheet_exports);
  else if (cmd === "form") await init_vault_form().then(() => vault_form_exports);
  else if (cmd === "intake") await init_intake_all().then(() => intake_all_exports);
  else await init_selftest_intake().then(() => selftest_intake_exports);
} else {
  process.stderr.write(USAGE4 + `
error: unknown command: ${cmd}
`);
  process.exitCode = 2;
}
