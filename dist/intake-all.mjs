#!/usr/bin/env node

// extensions/vault-intake/intake-all.mjs
import fs2 from "node:fs";
import path2 from "node:path";

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
var HEADER = ["\uC0AC\uC774\uD2B8", "\uC544\uC774\uB514", "\uBE44\uBC00\uBC88\uD638"];
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
var XLSX_WRITE_PY = `
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

// extensions/vault-intake/intake-all.mjs
var USAGE = "intake-all.mjs [--source auto|sheet|file] [--file PATH] [--sheet-id ID] [--range RANGE] [--gog gog] [--attachments-dir DIR]";
var VAULT = process.env.PICKLE_ULTRA_VAULT || path2.join(REPO, "agent-vault", "vault.py");
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
  const rng = `${tab}!B${rowNo}:C${rowNo}`;
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
  if (!fs2.existsSync(file)) {
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
    rows[idx] = [siteRaw, "", ""];
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
    if ((probe[1] || "").trim() || (probe[2] || "").trim() || (probe[0] || "").trim() !== (siteRaw || "").trim()) {
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
  const base = path2.basename(file);
  const homes = [];
  for (const fmt of ["tsv", "csv", "xlsx"]) {
    const cand = inboxPath(fmt);
    if (path2.basename(cand) === base && fs2.existsSync(cand) && path2.resolve(cand) !== path2.resolve(file)) {
      homes.push(cand);
    }
  }
  const removed = shredFile(file);
  let n = 0;
  for (const c of copies) {
    if (path2.resolve(c) === path2.resolve(file)) continue;
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
async function main(argv) {
  const opts = parseArgs(
    argv,
    {
      source: "value",
      file: "value",
      "sheet-id": "value",
      range: "value",
      gog: "value",
      "attachments-dir": "value"
    },
    USAGE
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  const sourceArg = opts.source || "auto";
  if (!["auto", "sheet", "file"].includes(sourceArg)) {
    process.stderr.write(`usage: ${USAGE}
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
        if (fs2.existsSync(cand)) {
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
process.exitCode = await main(process.argv.slice(2));
