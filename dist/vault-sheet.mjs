#!/usr/bin/env node

// extensions/vault-intake/vault-sheet.mjs
import fs2 from "node:fs";

// extensions/vault-intake/lib.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var HERE = (() => {
  const d = path.dirname(fileURLToPath(import.meta.url));
  if (fs.existsSync(path.join(d, "vault-sheet-init.sh"))) return d;
  const up = path.join(path.dirname(d), "extensions", "vault-intake");
  return fs.existsSync(path.join(up, "vault-sheet-init.sh")) ? up : d;
})();
var REPO = path.dirname(path.dirname(HERE));
var RATE_MARKERS = ["rate_limited", "429", "quota", "RESOURCE_EXHAUSTED"];
var NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function runProcess(cmd, args, { input = null, timeout = 0, env = process.env, cwd } = {}) {
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
var CONFIG_DEFAULTS = { sheet_tab: "in", sheet_range: "in!A2:C200" };
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
var XLSX_READ_PY = `
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
function pythonBin() {
  return process.env.PICKLE_ULTRA_PYTHON || "python3";
}
var openpyxlChecked = null;
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
function isoLocalNow(d = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}${pad(off % 60)}`;
}
function parseArgs(argv, spec, usage) {
  const opts = { _: [] };
  const die = (msg) => {
    process.stderr.write(`usage: ${usage}
${msg ? "error: " + msg + "\n" : ""}`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts._.push(...argv.slice(i + 1));
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

// extensions/vault-intake/vault-sheet.mjs
var USAGE = "vault-sheet.mjs [init|status] [--from-json FILE] [--agent-name NAME] [--new] [--gog gog] [--dry-run] [--json] [--no-format]";
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
async function main(argv) {
  const cmd = argv[0];
  if (cmd !== "init" && cmd !== "status") {
    process.stderr.write(`usage: ${USAGE}
`);
    return 2;
  }
  const spec = cmd === "init" ? {
    gog: "value",
    json: "flag",
    "from-json": "value",
    "agent-name": "value",
    new: "flag",
    "dry-run": "flag",
    "no-format": "flag"
  } : { gog: "value", json: "flag" };
  const opts = parseArgs(argv.slice(1), spec, USAGE);
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  return cmd === "init" ? cmdInit(opts) : cmdStatus(opts);
}
process.exitCode = await main(process.argv.slice(2));
