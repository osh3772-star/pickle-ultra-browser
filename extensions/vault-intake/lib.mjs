// lib.mjs — shared helpers for the vault-intake plugin.
//
// Pure Node (ESM, no npm packages). Every helper here was duplicated across
// the four former Python modules: the gog runner and its one 20 s retry, the
// JSON walkers for the different gog/vault envelopes, normalizeSite, the vault
// login list, the config file, the TSV/CSV form reader and writer, and the
// shred routine.
//
// Security rules kept in this file:
//  - a value (password, username the user typed) is never printed, logged or
//    written to a temporary file; it only travels in memory or through a pipe
//    into agent-vault;
//  - the form writer zeroes the previous bytes before replacing a file, and
//    shred() zeroes then unlinks.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.dirname(path.dirname(HERE)); // extensions/vault-intake -> tree root
export const HEADER = ["사이트", "아이디", "비밀번호"];
export const RATE_MARKERS = ["rate_limited", "429", "quota", "RESOURCE_EXHAUSTED"];
export const NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

// ---------------------------------------------------------------- processes
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a command and collect its output. Resolves — never rejects — with
// {code, stdout, stderr, error}; `code` is null when the process could not be
// started or was killed on timeout, and `error` is true in that case.
export function runProcess(cmd, args, { input = null, timeout = 0, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
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
      error: true,
    });
    child.on("error", () => finish(current()));
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.on("error", () => {}); // a child that exits early closes the pipe
    child.on("close", (code) =>
      finish({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        error: false,
      })
    );
    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(current());
      }, timeout * 1000);
    }
    try {
      child.stdin.end(input === null ? undefined : input);
    } catch {
      /* the close handler still reports */
    }
  });
}

// ---------------------------------------------------------------- gog
// Run the Google CLI. Returns {obj, code}: code is null on ok:true, otherwise
// a string ("cli" when gog could not start, "parse" when its output was not
// JSON, else the CLI's own code). A rate limit is retried once after 20 s.
export async function runGog(args, gogBin, timeout = 110) {
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
    const rate =
      raw === 7 || raw === "rate_limited" || RATE_MARKERS.some((m) => blob.includes(m));
    if (attempt === 1 && rate) {
      await sleep(20000);
      continue;
    }
    return { obj, code: raw === null || raw === undefined || raw === "ok" ? "gog" : String(raw) };
  }
  return { obj: null, code: "gog" };
}

// ---------------------------------------------------------------- JSON walkers
export function findListWithKey(obj, key, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(obj)) {
    const allObjects =
      obj.length > 0 && obj.every((i) => i !== null && typeof i === "object" && !Array.isArray(i));
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

export function findScalar(obj, keys, depth = 0) {
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

// A sheet get answer carries its rows as list-of-lists under values/data.
export function findValues(obj, depth = 0) {
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

// ---------------------------------------------------------------- sites
export function normalizeSite(raw) {
  let s = String(raw === null || raw === undefined ? "" : raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  if (s.startsWith("www.")) s = s.slice(4);
  s = s.replace(/[^a-z0-9._-]+/g, "-");
  s = s.replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (s.length > 64) return "";
  return NAME_RE.test(s) ? s : "";
}

// ---------------------------------------------------------------- vault logins
// -> {logins, error}. error is null when the CLI answered with a login list.
export async function loadLogins(cli) {
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

export function loadLoginsFromJson(file) {
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

// rows = [[site, username_prefill]] sorted; notes for the header cell.
export function planRows(logins) {
  const rows = [];
  const notes = [];
  const seen = new Set();
  for (const item of logins) {
    if (item === null || typeof item !== "object") continue;
    const site = normalizeSite(item.site === undefined || item.site === null ? "" : item.site);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    const hasPassword = item.password === true;
    const username = String(item.username === undefined || item.username === null ? "" : item.username).trim();
    const method = String(item.method === undefined || item.method === null ? "" : item.method).trim();
    // The username is pre-filled whenever the vault knows one, so the user
    // types only the password. A social sign-in stays empty and is noted.
    let prefill = "";
    if (method && !hasPassword) {
      notes.push(`${site}=${method}`);
    } else {
      prefill = username;
    }
    rows.push([site, prefill]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  notes.sort();
  return { rows, notes };
}

// ---------------------------------------------------------------- sheet ranges
// -> {rows, code}; rows are 6 cells wide, starting at the requested range.
export async function readSheet6(sheetId, rng, gogBin) {
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

// Intake's reader: three cells wide, with the read error mapped to
// range|read exactly as the intake CLI reports it.
export async function readSheet3(sheetId, rng, gogBin) {
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

export async function updateRange(sheetId, rng, values, gogBin, raw = true) {
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
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export function cellFormat({
  bg = null,
  bold = false,
  fg = null,
  size = 11,
  halign = "CENTER",
  valign = "MIDDLE",
  wrap = "CLIP",
  borders = false,
} = {}) {
  const f = {
    verticalAlignment: valign,
    horizontalAlignment: halign,
    wrapStrategy: wrap,
    textFormat: { bold, fontSize: size },
  };
  if (bg) f.backgroundColor = rgb(bg);
  if (fg) f.textFormat.foregroundColor = rgb(fg);
  if (borders) {
    const line = () => ({ style: "SOLID", color: rgb("#C6CDD5") });
    f.borders = { top: line(), bottom: line(), left: line(), right: line() };
  }
  return f;
}

// Column widths, frozen header, row heights, header styling, borders and the
// "fill me" column highlight. Idempotent; -> {ok, failed:[label]}.
export async function applyVisuals(sheetId, gogBin, tab, lastRow) {
  const failed = [];
  const rng = (a) => `${tab}!${a}`;
  const last = Math.max(lastRow, 2);
  const fmt = (range, style) =>
    ["sheets", "format", sheetId, rng(range), "--format-json", JSON.stringify(style)];
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
    [fmt(`C2:C${last}`, cellFormat({ bg: "#FFF8DC", halign: "LEFT", borders: true })), "format:C"],
  ];
  for (const [args, label] of steps) {
    const { code } = await runGog(args, gogBin);
    if (code) failed.push(label);
  }
  return { ok: failed.length === 0, failed };
}

export async function tabTitle(sheetId, gogBin, fallback = "Sheet1") {
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

// ---------------------------------------------------------------- config
function configDir() {
  return (
    process.env.PU_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pickle-ultra")
  );
}

export function configFile() {
  return process.env.PU_CONFIG_FILE || path.join(configDir(), "config.json");
}

const CONFIG_DEFAULTS = { sheet_tab: "in", sheet_range: "in!A2:C200" };

export function loadConfig() {
  const cfg = { ...CONFIG_DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    if (data !== null && typeof data === "object" && !Array.isArray(data)) Object.assign(cfg, data);
  } catch {
    /* absent or unreadable: defaults */
  }
  return cfg;
}

export function saveConfig(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const file = configFile();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

// Path of the local intake form used when Google is not connected.
// $PICKLE_ULTRA_INBOX (or $PU_INBOX) wins; otherwise
// $PICKLE_ULTRA_HOME/inbox.<ext>, falling back to the tree root.
export function inboxPath(fmt = "tsv") {
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

// ---------------------------------------------------------------- TSV / CSV
export function formatOf(file) {
  const low = String(file || "").toLowerCase();
  for (const fmt of ["xlsx", "csv", "tsv"]) {
    if (low.endsWith("." + fmt)) return fmt;
  }
  return "tsv";
}

export function parseDelimited(text, delim) {
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

export function serializeDelimited(rows, delim) {
  const quote = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  return rows.map((r) => r.map(quote).join(delim)).join("\n") + "\n";
}

// ---------------------------------------------------------------- xlsx (optional)
// The sheet/form xlsx option needs python3 + openpyxl, exactly as before. It is
// used only when that module imports; otherwise the caller reports a clear
// failure and recommends tsv/csv. Neither snippet writes a value anywhere but
// the requested file (or a pipe).
const XLSX_WRITE_PY = `
import json, sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
rows = json.load(sys.stdin)
wb = Workbook()
ws = wb.active
ws.title = "in"
ws.append(["사이트", "아이디", "비밀번호"])
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

const XLSX_READ_PY = `
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

export function pythonBin() {
  return process.env.PICKLE_ULTRA_PYTHON || "python3";
}

let openpyxlChecked = null;
export async function openpyxlAvailable() {
  if (openpyxlChecked !== null) return openpyxlChecked;
  const p = await runProcess(pythonBin(), ["-c", "import openpyxl"], { timeout: 30 });
  openpyxlChecked = !p.error && p.code === 0;
  return openpyxlChecked;
}

async function readXlsx(file) {
  if (!(await openpyxlAvailable())) return { error: "xlsx-unavailable" };
  const p = await runProcess(pythonBin(), ["-c", XLSX_READ_PY, file], { timeout: 60 });
  if (p.error || p.code !== 0) return { error: "xlsx-read" };
  try {
    return { rows: JSON.parse(p.stdout) };
  } catch {
    return { error: "xlsx-read" };
  }
}

async function writeXlsx(file, rows) {
  if (!(await openpyxlAvailable())) return { error: "xlsx-unavailable" };
  const p = await runProcess(pythonBin(), ["-c", XLSX_WRITE_PY, file], {
    input: JSON.stringify(rows),
    timeout: 120,
  });
  if (p.error || p.code !== 0) return { error: "xlsx-write" };
  return { error: null };
}

// ---------------------------------------------------------------- form files
// -> rows [[site, user, pw], ...] without the header; [] when absent.
// Throws {reason:"xlsx-unavailable"} when an xlsx file is there but cannot be read.
export async function readFormRows(file) {
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
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  for (const [i, row] of parseDelimited(text, fmt === "csv" ? "," : "\t").entries()) {
    if (i === 0) continue;
    const cells = [0, 1, 2].map((j) => (j < row.length ? row[j] : ""));
    if (!cells[0].trim()) continue;
    rows.push([cells[0].trim(), cells[1].trim(), cells[2].trim()]);
  }
  return rows;
}

export function zeroOldFile(file) {
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
    /* best effort */
  }
}

// Atomic write, mode 0600; the previous bytes are zeroed first because the file
// may hold a value the user typed.
export async function writeFormRows(file, rows, fmt) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    const delim = fmt === "csv" ? "," : "\t";
    const body = serializeDelimited([HEADER, ...rows], delim);
    const text = (fmt === "csv" ? "\uFEFF" : "") + body;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, text, { encoding: "utf8" });
    } finally {
      fs.closeSync(fd);
    }
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// ---------------------------------------------------------------- shredding
// Zero the bytes, then unlink. -> true when unlinked.
export function shredFile(file) {
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
      /* best effort */
    }
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// Same-named copies under attachments/<date>/ (depth limited to two levels).
export function attachmentCopies(target, attachmentsDir) {
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

// ---------------------------------------------------------------- misc
// Local time as "%Y-%m-%dT%H:%M:%S%z" (e.g. 2026-11-27T18:30:00+0900).
export function isoLocalNow(d = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}${pad(off % 60)}`
  );
}

// A small argument reader that behaves like the argparse setup it replaces:
// --flag, --opt value, --opt=value, and exit 2 on an unknown option.
// spec: { "option-name": "flag" | "value" } (names without the leading --).
export function parseArgs(argv, spec, usage) {
  const opts = { _: [] };
  const die = (msg) => {
    process.stderr.write(`usage: ${usage}\n${msg ? "error: " + msg + "\n" : ""}`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") {
      process.stdout.write(`usage: ${usage}\n`);
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
        if (i + 1 >= argv.length) die(`argument --${name}: expected one argument`);
        value = argv[++i];
      }
      opts[key] = value;
      continue;
    }
    opts._.push(a);
  }
  return opts;
}
