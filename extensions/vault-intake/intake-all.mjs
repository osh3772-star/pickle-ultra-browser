#!/usr/bin/env node
// intake-all.mjs — move the rows the user filled in into the vault.
//
// Two sources, same rules:
//
//   sheet  the private Google Sheet from `vault-sheet-init` (agent reads it
//          itself; needs a connected Google account)
//   file   the local form from `vault-form` (the user fills it on their own
//          phone and sends it back; no Google account needed)
//
// Values are never printed, never logged, and never written to a temp file.
// Once a row is handled, its username/password cells are cleared (sheet) or the
// row is rewritten with the site only (file) and read back to confirm — a row
// that failed to store is cleared the same way, so no value is left waiting on
// disk. The form file and its copies under attachments/ are then shredded and
// deleted, and a failed row is reported so it can be filled in again.
//
// Source choice: --source auto (default) uses the sheet when the config holds a
// sheet id and the sheet is readable, and otherwise the local form. A sheet that
// cannot be read falls back to the form once — no retry loop.
//
// Output (one line per row):
//   ok site=<name> row=<n> cleared=yes|no
//   skip empty
//   note fallback=file reason=<read|config|gog>
//   shredded file=<path> removed=<yes|no> attachments=<n> home=<n>
//   fail code=<incomplete|site|chars|store|clear|read|range|config> row=<n> cleared=<yes|no>
//
// Exit codes: 0 all rows handled · 1 any row failed

import fs from "node:fs";
import path from "node:path";
import {
  REPO,
  attachmentCopies,
  formatOf,
  inboxPath,
  loadConfig,
  normalizeSite,
  parseArgs,
  pythonBin,
  readFormRows,
  readSheet3,
  runGog,
  runProcess,
  shredFile,
  writeFormRows,
} from "./lib.mjs";

const USAGE =
  "intake-all.mjs [--source auto|sheet|file] [--file PATH] [--sheet-id ID] " +
  "[--range RANGE] [--gog gog] [--attachments-dir DIR]";

const VAULT = process.env.PICKLE_ULTRA_VAULT || path.join(REPO, "agent-vault", "vault.py");

// ---------------------------------------------------------------- rows
async function storeValue(name, user, password) {
  const payload = Buffer.from(user + "\t" + password, "utf8");
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
  if (!got.rows.length) return true; // an empty range yields no values row: that is cleared
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
      // The username is pre-filled by the form itself, so an empty password
      // cell means "not filled in yet", not an error.
      continue;
    }
    acted += 1;
    const name = normalizeSite(siteRaw);
    let failure = null;
    if (!(siteRaw || "").trim() || !user) failure = "incomplete";
    else if (!name) failure = "site";
    else if (/[\t\r\n]/.test(user) || /[\t\r\n]/.test(password)) failure = "chars";
    else if (!(await storeValue(name, user, password))) failure = "store";
    // A value that could not be stored must not stay in the sheet either:
    // clear the cells first, then report.
    const cleared = (await clearSheetRow(sheetId, rowNo, gogBin, tab)) ? "yes" : "no";
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
  if (!fs.existsSync(file)) {
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
    if (!password) continue; // not filled in yet (column B is pre-filled by design)
    acted += 1;
    const name = normalizeSite(siteRaw);
    let failure = null;
    if (!(siteRaw || "").trim() || !user) failure = "incomplete";
    else if (!name) failure = "site";
    else if (/[\t\r\n]/.test(user) || /[\t\r\n]/.test(password)) failure = "chars";
    else if (!(await storeValue(name, user, password))) failure = "store";
    // Clear the row in the file whatever happened: a value that could not be
    // stored must not stay on disk waiting for a retry.
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
    if (
      (probe[1] || "").trim() ||
      (probe[2] || "").trim() ||
      (probe[0] || "").trim() !== (siteRaw || "").trim()
    ) {
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
  const base = path.basename(file);
  const homes = [];
  for (const fmt of ["tsv", "csv", "xlsx"]) {
    const cand = inboxPath(fmt);
    if (
      path.basename(cand) === base &&
      fs.existsSync(cand) &&
      path.resolve(cand) !== path.resolve(file)
    ) {
      homes.push(cand);
    }
  }
  const removed = shredFile(file);
  let n = 0;
  for (const c of copies) {
    if (path.resolve(c) === path.resolve(file)) continue;
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
      "attachments-dir": "value",
    },
    USAGE
  );
  if (opts._.length) {
    process.stderr.write(`usage: ${USAGE}\nerror: unrecognized arguments: ${opts._.join(" ")}\n`);
    return 2;
  }
  const sourceArg = opts.source || "auto";
  if (!["auto", "sheet", "file"].includes(sourceArg)) {
    process.stderr.write(`usage: ${USAGE}\nerror: argument --source: invalid choice: '${sourceArg}'\n`);
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
        if (fs.existsSync(cand)) {
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
