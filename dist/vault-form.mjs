#!/usr/bin/env node

// extensions/vault-intake/vault-form.mjs
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
var NAME_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
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

// extensions/vault-intake/vault-form.mjs
var USAGE = "vault-form.mjs [--from-json FILE] [--format tsv|csv|xlsx] [--out PATH] [--vault-cli CMD] [--agent-name NAME] [--json]";
function stem2(p) {
  const ext = path2.extname(p);
  return ext ? p.slice(0, p.length - ext.length) : p;
}
async function main(argv) {
  const opts = parseArgs(
    argv,
    {
      "from-json": "value",
      format: "value",
      out: "value",
      "vault-cli": "value",
      "agent-name": "value",
      json: "flag"
    },
    USAGE
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}
error: unrecognized arguments: ${opts._.join(" ")}
`);
    return 2;
  }
  if (opts.format && !["tsv", "csv", "xlsx"].includes(opts.format)) {
    process.stderr.write(`usage: ${USAGE}
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
    mode = (fs2.statSync(out).mode & 511).toString(8);
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
process.exitCode = await main(process.argv.slice(2));
